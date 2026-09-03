import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig } from "./config.js";
import {
  KalshiClient,
  parseKalshiTokenId,
  type KalshiFill,
} from "./kalshi-api.js";
import { KalshiMarketStream } from "./kalshi-market-stream.js";
import { exactKalshiOrderFee } from "./kalshi-fees.js";
import { ladderV13SellGuard } from "./ladder-v13-inventory.js";
import { ladderV14BuyGuard, ladderV14SellGuard } from "./ladder-v14-inventory.js";
import { log, logThrottled } from "./logger.js";
import type { MarketStreamEvent } from "./market-stream.js";
import {
  minimumOrderRejection,
  validateOrderMinimum,
} from "./utils/order-validation.js";
import type {
  MarketExecutionSnapshot,
  OrderExecutor,
  OrderResult,
  PaperFill,
  PaperOrder,
  PaperPosition,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";

interface LiveState {
  version: 1;
  orders: PaperOrder[];
  fills: PaperFill[];
  expectedFillCounts?: Array<[string, number]>;
  pendingV13Cancellations?: string[];
}

interface MarketContext {
  event: UpDownEvent;
  books: TokenBook[];
  streamBacked: boolean;
}

interface KalshiTraderOptions {
  stream?: Pick<KalshiMarketStream, "subscribe" | "close">;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export class KalshiTrader implements OrderExecutor {
  private readonly client: KalshiClient;
  private readonly statePath: string;
  private state: LiveState = { version: 1, orders: [], fills: [] };
  private readonly contexts = new Map<string, MarketContext>();
  private readonly tickerToMarket = new Map<string, string>();
  private readonly invalidMarkets = new Set<string>();
  private readonly reconciledMarkets = new Set<string>();
  private readonly loggedFeeMarkets = new Set<string>();
  private readonly executionQueues = new Map<string, Promise<void>>();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private lastAvailableCash = 0;
  private inFlightReservedCash = 0;
  private readonly unconfirmedOrderReservations = new Map<string, number>();
  private readonly expectedFillCounts = new Map<string, number>();
  private readonly pendingV13Cancellations = new Set<string>();
  private readonly stream: Pick<KalshiMarketStream, "subscribe" | "close">;
  private executionWakeHandler:
    | ((marketSlug: string) => void | Promise<void>)
    | undefined;
  private marketTelemetryHandler:
    | ((event: Record<string, unknown>) => void | Promise<void>)
    | undefined;

  constructor(
    private readonly config: BotConfig,
    options: KalshiTraderOptions = {},
  ) {
    this.client = new KalshiClient(config);
    this.stream =
      options.stream ??
      new KalshiMarketStream(config, (event) => this.ingestMarketEvent(event));
    this.statePath = join(config.paperStatePath, "kalshi-live-execution-state.json");
  }

  async init(): Promise<void> {
    await this.client.init();
    if (this.config.dryRun) return;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as LiveState;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported Kalshi live execution state: ${parsed.version}`);
      }
      this.state = parsed;
      this.state.orders ??= [];
      this.state.fills ??= [];
      for (const [id, count] of parsed.expectedFillCounts ?? []) this.expectedFillCounts.set(id, count);
      for (const id of parsed.pendingV13Cancellations ?? []) this.pendingV13Cancellations.add(id);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") throw error;
      await this.persist();
    }
    this.lastAvailableCash = await this.client.getBalance();
  }

  setExecutionWakeHandler(
    handler: (marketSlug: string) => void | Promise<void>,
  ): void {
    this.executionWakeHandler = handler;
  }

  setMarketTelemetryHandler(
    handler: (event: Record<string, unknown>) => void | Promise<void>,
  ): void {
    this.marketTelemetryHandler = handler;
  }

  async observeMarket(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    const clonedBooks = books.map((book) => ({
        ...book,
        bids: book.bids.map((level) => ({ ...level })),
        asks: book.asks.map((level) => ({ ...level })),
      }));
    const existingContext = this.contexts.get(event.slug);
    if (existingContext) {
      existingContext.event = event;
      if (!existingContext.streamBacked) existingContext.books = clonedBooks;
    } else {
      this.contexts.set(event.slug, {
        event,
        books: clonedBooks,
        streamBacked: false,
      });
    }
    const ticker = event.market.externalMarketId ?? event.market.id;
    if (ticker) this.tickerToMarket.set(ticker, event.slug);
    if (!this.config.dryRun) {
      this.stream.subscribe(books.map((book) => book.tokenId));
    }
    if (!this.loggedFeeMarkets.has(event.slug)) {
      this.loggedFeeMarkets.add(event.slug);
      log("Kalshi market fee assumptions", {
        market: event.slug,
        series: event.market.seriesTicker,
        takerRate:
          event.market.feeSchedule?.rate ??
          this.config.kalshiTakerFeeRate,
        makerRate:
          event.market.feeSchedule?.makerRate ??
          this.config.kalshiMakerFeeRate,
        exponent: event.market.feeSchedule?.exponent ?? 1,
      });
    }
    if (!this.config.dryRun && !this.reconciledMarkets.has(event.slug)) {
      await this.reconcile(event);
      this.reconciledMarkets.add(event.slug);
    } else if (!this.config.dryRun && this.getMarketExecutionSnapshot(event.slug)?.executionPending) {
      await this.serializeExecution(event.slug, () => this.reconcile(event));
    }
  }

  async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
    return this.serializeExecution(opportunity.event.slug, () =>
      this.placeBuyLocked(opportunity),
    );
  }

  async placeBuys(opportunities: readonly TradeOpportunity[]): Promise<OrderResult[]> {
    if (opportunities.length === 0) return [];
    const slug = opportunities[0]!.event.slug;
    if (opportunities.some((opportunity) => opportunity.event.slug !== slug)) {
      throw new Error("Kalshi batch orders must belong to one market");
    }
    return this.serializeExecution(slug, () => this.placeBuysLocked(opportunities));
  }

  private async placeBuysLocked(opportunities: readonly TradeOpportunity[]): Promise<OrderResult[]> {
    if (this.config.ladderV14VolumeFirstMode &&
      opportunities.some((opportunity) => opportunity.strategyMode === "ladder_v14")) {
      const results: OrderResult[] = [];
      for (const opportunity of opportunities) results.push(await this.placeBuyLocked(opportunity));
      return results;
    }
    for (const opportunity of opportunities) {
      const failure = validateOrderMinimum(opportunity);
      if (failure) return opportunities.map((candidate) => minimumOrderRejection(candidate, failure, this.config.dryRun));
    }
    if (this.config.dryRun) return opportunities.map((opportunity) => ({
      dryRun: true, accepted: true, tokenId: opportunity.token.tokenId,
      side: "BUY" as const, price: opportunity.price, size: opportunity.size,
      response: { batch: true },
    }));
    const parsed = opportunities.map((opportunity) => {
      const token = parseKalshiTokenId(opportunity.token.tokenId);
      if (!token) throw new Error(`Invalid Kalshi token ID: ${opportunity.token.tokenId}`);
      return token;
    });
    const reserves = opportunities.map((opportunity) => {
      const rate = opportunity.orderPolicy === "post_only"
        ? (opportunity.event.market.feeSchedule?.makerRate ?? this.config.kalshiMakerFeeRate)
        : Math.max(
            opportunity.event.market.feeSchedule?.rate ?? this.config.kalshiTakerFeeRate,
            opportunity.event.market.feeSchedule?.makerRate ?? this.config.kalshiMakerFeeRate,
          );
      return opportunity.price * opportunity.size + exactKalshiOrderFee({
        price: opportunity.price, size: opportunity.size, rate,
        exponent: opportunity.event.market.feeSchedule?.exponent ?? 1,
      });
    });
    const totalReserve = reserves.reduce((sum, value) => sum + value, 0);
    if (totalReserve > this.availableCashForOrders() + 1e-8) {
      throw new Error(`Kalshi balance too low: $${this.availableCashForOrders().toFixed(2)} available, $${totalReserve.toFixed(2)} required`);
    }
    this.inFlightReservedCash = round(this.inFlightReservedCash + totalReserve);
    try {
      const responses = await this.client.createOrders(opportunities.map((opportunity, index) => ({
        ticker: parsed[index]!.ticker,
        clientOrderId: crypto.randomUUID(),
        outcome: parsed[index]!.outcome,
        count: opportunity.size,
        price: opportunity.price,
        timeInForce: opportunity.orderPolicy === "fok" ? "fill_or_kill" as const
          : opportunity.orderPolicy === "fak" ? "immediate_or_cancel" as const
          : "good_till_canceled" as const,
        postOnly: opportunity.orderPolicy === "post_only",
      })));
      const createdAt = new Date().toISOString();
      const results = opportunities.map((opportunity, index): OrderResult => {
        const response = responses[index];
        if (!response || response.error || !response.order_id) return {
          dryRun: false, accepted: false, tokenId: opportunity.token.tokenId,
          side: "BUY", price: opportunity.price, size: opportunity.size,
          response: response ?? { status: "rejected", reason: "missing_batch_response" },
        };
        const filled = Number(response.fill_count) || 0;
        const remaining = Number(response.remaining_count) || 0;
        this.state.orders.push({
          id: response.order_id, tradeKey: opportunity.tradeKey,
          marketSlug: opportunity.event.slug, marketTitle: opportunity.event.title,
          conditionId: parsed[index]!.ticker, tokenId: opportunity.token.tokenId,
          outcome: opportunity.token.outcome, limitPrice: opportunity.price,
          originalSize: opportunity.size, remainingSize: remaining, queueAhead: 0,
          status: remaining <= 1e-8 ? (filled > 0 ? "filled" : "cancelled") : (filled > 0 ? "partial" : "open"),
          side: "BUY", phaseId: opportunity.phaseId, pairId: opportunity.pairId,
          orderPolicy: opportunity.orderPolicy ?? "gtc", pairLockRole: opportunity.pairLockRole,
          pairLockSourceFillId: opportunity.pairLockSourceFillId,
          pairLockEntryPrice: opportunity.pairLockEntryPrice,
          referenceTokenId: opportunity.referenceTokenId,
          referenceAllInPrice: opportunity.referenceAllInPrice,
          plannedAllInPairCost: opportunity.plannedAllInPairCost,
          plannedNetEdgePerPair: opportunity.plannedNetEdgePerPair,
          createdAt, submittedMinutesLeft: (opportunity.event.windowEnd - Date.now() / 1_000) / 60,
        });
        this.unconfirmedOrderReservations.set(response.order_id, reserves[index]!);
        this.expectedFillCounts.set(response.order_id, filled);
        return { dryRun: false, accepted: true, tokenId: opportunity.token.tokenId, side: "BUY", price: opportunity.price, size: opportunity.size, response };
      });
      await this.persist();
      return results;
    } finally {
      this.inFlightReservedCash = round(Math.max(0, this.inFlightReservedCash - totalReserve));
    }
  }

  async placeSell(opportunity: TradeOpportunity): Promise<OrderResult> {
    return this.serializeExecution(opportunity.event.slug, () =>
      this.placeSellLocked(opportunity),
    );
  }

  private async placeSellLocked(
    opportunity: TradeOpportunity,
  ): Promise<OrderResult> {
    if (opportunity.strategyMode === "ladder_v13") {
      if (!this.config.dryRun) await this.reconcile(opportunity.event);
      const snapshot = this.getMarketExecutionSnapshot(opportunity.event.slug);
      const reason = opportunity.orderPolicy !== "fak" ? "v13_sale_requires_ioc" :
        snapshot ? ladderV13SellGuard(snapshot, opportunity.token.tokenId, opportunity.size) : "missing_market_snapshot";
      if (reason) return { dryRun: this.config.dryRun, accepted: false, tokenId: opportunity.token.tokenId,
        side: "SELL", price: opportunity.price, size: opportunity.size,
        response: { status: "rejected", reason } };
    }
    if (opportunity.strategyMode === "ladder_v14") {
      if (!this.config.dryRun) await this.reconcile(opportunity.event);
      const snapshot = this.getMarketExecutionSnapshot(opportunity.event.slug);
      const reason = opportunity.orderPolicy !== "fak"
        ? "v14_sale_requires_ioc"
        : snapshot
          ? ladderV14SellGuard(snapshot, opportunity.token.tokenId, opportunity.size)
          : "missing_market_snapshot";
      if (reason) return {
        dryRun: this.config.dryRun,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "SELL",
        price: opportunity.price,
        size: opportunity.size,
        response: { status: "rejected", reason },
      };
    }
    const minimumFailure = validateOrderMinimum(opportunity);
    if (minimumFailure) {
      return minimumOrderRejection(
        opportunity,
        minimumFailure,
        this.config.dryRun,
      );
    }
    const token = parseKalshiTokenId(opportunity.token.tokenId);
    if (!token) throw new Error(`Invalid Kalshi token ID: ${opportunity.token.tokenId}`);
    const existing = this.state.orders.find(
      (order) => order.tradeKey === opportunity.tradeKey,
    );
    if (existing) {
      return {
        dryRun: this.config.dryRun,
        accepted: true,
        tokenId: existing.tokenId,
        side: "SELL",
        price: existing.limitPrice,
        size: existing.originalSize,
        response: { duplicate: true, order_id: existing.id },
      };
    }
    const position = derivePositions(
      this.state.fills.filter((fill) => fill.marketSlug === opportunity.event.slug),
    ).find((candidate) => candidate.tokenId === opportunity.token.tokenId);
    if (!this.config.dryRun && (!position || position.shares + 1e-8 < opportunity.size)) {
      return {
        dryRun: false,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "SELL",
        price: opportunity.price,
        size: opportunity.size,
        response: { status: "rejected", reason: "position_too_small" },
      };
    }
    if (this.config.dryRun) {
      return {
        dryRun: true,
        accepted: true,
        tokenId: opportunity.token.tokenId,
        side: "SELL",
        price: opportunity.price,
        size: opportunity.size,
      };
    }
    const timeInForce = opportunity.orderPolicy === "fok"
      ? "fill_or_kill"
      : opportunity.orderPolicy === "fak"
        ? "immediate_or_cancel"
        : "good_till_canceled";
    const response = await this.client.createOrder({
      ticker: token.ticker,
      clientOrderId: crypto.randomUUID(),
      outcome: token.outcome,
      count: opportunity.size,
      price: opportunity.price,
      timeInForce,
      postOnly: opportunity.orderPolicy === "post_only",
      action: "sell",
    });
    const filled = Number(response.fill_count) || 0;
    const remaining = Number(response.remaining_count) || 0;
    this.state.orders.push({
      id: response.order_id,
      tradeKey: opportunity.tradeKey,
      marketSlug: opportunity.event.slug,
      marketTitle: opportunity.event.title,
      conditionId: token.ticker,
      tokenId: opportunity.token.tokenId,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      originalSize: opportunity.size,
      remainingSize: opportunity.orderPolicy === "fak" ? round(Math.max(0, opportunity.size - filled)) : remaining,
      queueAhead: 0,
      status: opportunity.orderPolicy === "fak" ? (filled + 1e-8 >= opportunity.size ? "filled" : "cancelled") : remaining <= 1e-8
        ? filled > 0 ? "filled" : "cancelled"
        : filled > 0 ? "partial" : "open",
      side: "SELL",
      phaseId: opportunity.phaseId,
      pairId: opportunity.pairId,
      orderPolicy: opportunity.orderPolicy ?? "fak",
      createdAt: new Date().toISOString(),
      submittedMinutesLeft:
        (opportunity.event.windowEnd - Date.now() / 1_000) / 60,
    });
    this.expectedFillCounts.set(response.order_id, filled);
    await this.persist();
    return {
      dryRun: false,
      accepted: true,
      tokenId: opportunity.token.tokenId,
      side: "SELL",
      price: opportunity.price,
      size: opportunity.size,
      response,
    };
  }

  private async placeBuyLocked(
    opportunity: TradeOpportunity,
  ): Promise<OrderResult> {
    if (this.config.ladderV14VolumeFirstMode && opportunity.strategyMode === "ladder_v14") {
      const reason = ladderV14BuyGuard(this.getMarketExecutionSnapshot(opportunity.event.slug), opportunity);
      if (reason) return { dryRun: this.config.dryRun, accepted: false, tokenId: opportunity.token.tokenId,
        side: "BUY", price: opportunity.price, size: opportunity.size,
        response: { status: "rejected", reason } };
    }
    const minimumFailure = validateOrderMinimum(opportunity);
    if (minimumFailure) {
      return minimumOrderRejection(
        opportunity,
        minimumFailure,
        this.config.dryRun,
      );
    }
    if (this.config.dryRun) {
      return {
        dryRun: true,
        accepted: true,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
      };
    }
    const token = parseKalshiTokenId(opportunity.token.tokenId);
    if (!token) {
      throw new Error(`Invalid Kalshi token ID: ${opportunity.token.tokenId}`);
    }
    const existing = this.state.orders.find(
      (order) => order.tradeKey === opportunity.tradeKey,
    );
    if (existing) {
      return {
        dryRun: false,
        accepted: true,
        tokenId: existing.tokenId,
        side: "BUY",
        price: existing.limitPrice,
        size: existing.originalSize,
        response: { duplicate: true, order_id: existing.id },
      };
    }
    const feeRate =
      opportunity.orderPolicy === "post_only"
        ? (opportunity.event.market.feeSchedule?.makerRate ??
          this.config.kalshiMakerFeeRate)
        : Math.max(
            opportunity.event.market.feeSchedule?.rate ??
              this.config.kalshiTakerFeeRate,
            opportunity.event.market.feeSchedule?.makerRate ??
              this.config.kalshiMakerFeeRate,
          );
    const exponent =
      opportunity.event.market.feeSchedule?.exponent ?? 1;
    const estimatedFee = exactKalshiOrderFee({
      price: opportunity.price,
      size: opportunity.size,
      rate: feeRate,
      exponent,
    });
    const reserveNeeded =
      opportunity.price * opportunity.size + estimatedFee;
    const capitalCommitted = this.marketCapitalCommitted(
      opportunity.event.slug,
    );
    const projectedCommitment = capitalCommitted + reserveNeeded;
    const ladderCapitalEffect =
      opportunity.strategyMode !== undefined &&
      opportunity.strategyMode !== "reverse" &&
      opportunity.strategyMode !== "odahoa_static_maker"
        ? (opportunity.capitalEffect ?? "increase")
        : undefined;
    if (
      opportunity.strategyMode !== "ladder_v13" &&
      opportunity.strategyMode !== "ladder_v14" &&
      ladderCapitalEffect === "increase" &&
      projectedCommitment > this.config.ladderMaxUsdcPerMarket + 1e-8
    ) {
      log("Ladder order skipped by per-market cap", {
        market: opportunity.event.slug,
        series: opportunity.event.market.seriesTicker,
        capitalCommitted: round(capitalCommitted, 4),
        prospectiveCapital: round(projectedCommitment, 4),
        capUsdc: this.config.ladderMaxUsdcPerMarket,
        capitalEffect: ladderCapitalEffect,
      });
      return {
        dryRun: false,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
        response: {
          status: "rejected",
          reason: "per_market_cap",
          capitalCommitted: round(capitalCommitted, 4),
          prospectiveCapital: round(projectedCommitment, 4),
          capUsdc: this.config.ladderMaxUsdcPerMarket,
        },
      };
    }
    const cachedAvailableCash = this.availableCashForOrders();
    if (reserveNeeded > cachedAvailableCash + 1e-8) {
      throw new Error(
        `Kalshi balance too low: $${cachedAvailableCash.toFixed(2)} available, ` +
          `$${reserveNeeded.toFixed(2)} required`,
      );
    }
    const timeInForce =
      opportunity.orderPolicy === "fok"
        ? "fill_or_kill"
        : opportunity.orderPolicy === "fak"
          ? "immediate_or_cancel"
          : "good_till_canceled";
    this.inFlightReservedCash = round(
      this.inFlightReservedCash + reserveNeeded,
    );
    try {
      const response = await this.client.createOrder({
        ticker: token.ticker,
        clientOrderId: crypto.randomUUID(),
        outcome: token.outcome,
        count: opportunity.size,
        price: opportunity.price,
        timeInForce,
        postOnly: opportunity.orderPolicy === "post_only",
      });
      const filled = Number(response.fill_count) || 0;
      const remaining = Number(response.remaining_count) || 0;
      this.state.orders.push({
        id: response.order_id,
        tradeKey: opportunity.tradeKey,
        marketSlug: opportunity.event.slug,
        marketTitle: opportunity.event.title,
        conditionId: token.ticker,
        tokenId: opportunity.token.tokenId,
        outcome: opportunity.token.outcome,
        limitPrice: opportunity.price,
        originalSize: opportunity.size,
        remainingSize: remaining,
        queueAhead: 0,
        status:
          remaining <= 1e-8
            ? filled > 0
              ? "filled"
              : "cancelled"
            : filled > 0
              ? "partial"
              : "open",
        side: "BUY",
        phaseId: opportunity.phaseId,
        pairId: opportunity.pairId,
        orderPolicy: opportunity.orderPolicy ?? "gtc",
        pairLockRole: opportunity.pairLockRole,
        pairLockSourceFillId: opportunity.pairLockSourceFillId,
        pairLockEntryPrice: opportunity.pairLockEntryPrice,
        referenceTokenId: opportunity.referenceTokenId,
        referenceAllInPrice: opportunity.referenceAllInPrice,
        plannedAllInPairCost: opportunity.plannedAllInPairCost,
        plannedNetEdgePerPair: opportunity.plannedNetEdgePerPair,
        createdAt: new Date().toISOString(),
        submittedMinutesLeft:
          (opportunity.event.windowEnd - Date.now() / 1_000) / 60,
      });
      this.unconfirmedOrderReservations.set(response.order_id, reserveNeeded);
      this.expectedFillCounts.set(response.order_id, filled);
      await this.persist();
      return {
        dryRun: false,
        accepted: true,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
        response,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        opportunity.orderPolicy === "post_only" &&
        /post.?only|would cross|cross.*book/i.test(message)
      ) {
        return {
          dryRun: false,
          accepted: false,
          tokenId: opportunity.token.tokenId,
          side: "BUY",
          price: opportunity.price,
          size: opportunity.size,
          response: { status: "rejected", reason: message },
        };
      }
      throw error;
    } finally {
      this.inFlightReservedCash = round(
        Math.max(0, this.inFlightReservedCash - reserveNeeded),
      );
    }
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    const grouped = new Map<string, string[]>();
    for (const orderId of orderIds) {
      const slug =
        this.state.orders.find((order) => order.id === orderId)?.marketSlug ??
        "unknown";
      const ids = grouped.get(slug) ?? [];
      ids.push(orderId);
      grouped.set(slug, ids);
    }
    await Promise.all(
      [...grouped].map(([slug, ids]) =>
        this.serializeExecution(slug, () => this.cancelOrdersLocked(ids)),
      ),
    );
  }

  private async cancelOrdersLocked(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0 || this.config.dryRun) return;
    const v13Markets = new Set<string>();
    for (const orderId of orderIds) {
      const source = this.state.orders.find((candidate) => candidate.id === orderId);
      if (
        source?.pairId?.startsWith("ladder-v13:") ||
        source?.pairId?.startsWith("ladder-v14:")
      ) {
        this.pendingV13Cancellations.add(orderId);
        v13Markets.add(source.marketSlug);
        // Keep the cancellation barrier through a restart or an uncertain ACK.
        await this.persist();
      }
      await this.client.cancelOrder(orderId);
      const order = this.state.orders.find((candidate) => candidate.id === orderId);
      if (order && (order.status === "open" || order.status === "partial")) {
        order.status = "cancelled";
      }
    }
    await this.persist();
    for (const slug of v13Markets) {
      const context = this.contexts.get(slug);
      if (context) await this.reconcile(context.event);
    }
  }

  async amendOrder(
    orderId: string,
    opportunity: TradeOpportunity,
  ): Promise<OrderResult> {
    return this.serializeExecution(opportunity.event.slug, () =>
      this.amendOrderLocked(orderId, opportunity),
    );
  }

  private async amendOrderLocked(
    orderId: string,
    opportunity: TradeOpportunity,
  ): Promise<OrderResult> {
    const order = this.state.orders.find((candidate) => candidate.id === orderId);
    if (!order || (order.status !== "open" && order.status !== "partial")) {
      return {
        dryRun: this.config.dryRun,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
        response: { status: "rejected", reason: "order_not_open" },
      };
    }
    if (this.config.ladderV14VolumeFirstMode && opportunity.strategyMode === "ladder_v14") {
      const reason = ladderV14BuyGuard(this.getMarketExecutionSnapshot(opportunity.event.slug), opportunity, orderId);
      if (reason) return { dryRun: this.config.dryRun, accepted: false, tokenId: opportunity.token.tokenId,
        side: "BUY", price: opportunity.price, size: opportunity.size,
        response: { status: "rejected", reason } };
    }
    const parsed = parseKalshiTokenId(order.tokenId);
    if (!parsed) throw new Error(`Invalid Kalshi token ID: ${order.tokenId}`);
    const alreadyFilled = round(order.originalSize - order.remainingSize);
    const totalCount = round(alreadyFilled + opportunity.size);
    if (this.config.dryRun) {
      order.limitPrice = opportunity.price;
      order.originalSize = totalCount;
      order.remainingSize = opportunity.size;
      return {
        dryRun: true,
        accepted: true,
        tokenId: order.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
      };
    }
    const response = await this.client.amendOrder({
      orderId,
      ticker: parsed.ticker,
      outcome: parsed.outcome,
      price: opportunity.price,
      totalCount,
    });
    order.limitPrice = opportunity.price;
    order.tradeKey = opportunity.tradeKey;
    order.originalSize = totalCount;
    order.remainingSize = Number.isFinite(Number(response.remaining_count))
      ? Number(response.remaining_count)
      : opportunity.size;
    const amendedFillCount = Number(response.fill_count) || 0;
    order.status =
      order.remainingSize <= 1e-8
        ? amendedFillCount > 0
          ? "filled"
          : "cancelled"
        : amendedFillCount > 0 || alreadyFilled > 0
          ? "partial"
          : "open";
    order.pairId = opportunity.pairId;
    order.pairLockRole = opportunity.pairLockRole;
    order.referenceTokenId = opportunity.referenceTokenId;
    order.referenceAllInPrice = opportunity.referenceAllInPrice;
    order.plannedAllInPairCost = opportunity.plannedAllInPairCost;
    order.plannedNetEdgePerPair = opportunity.plannedNetEdgePerPair;
    this.unconfirmedOrderReservations.set(
      order.id,
      opportunity.price * opportunity.size,
    );
    this.expectedFillCounts.set(order.id, alreadyFilled + amendedFillCount);
    await this.persist();
    return {
      dryRun: false,
      accepted: true,
      tokenId: order.tokenId,
      side: "BUY",
      price: opportunity.price,
      size: opportunity.size,
      response,
    };
  }

  getMarketExecutionSnapshot(
    marketSlug: string,
  ): Readonly<MarketExecutionSnapshot> | null {
    const context = this.contexts.get(marketSlug);
    if (!context) return null;
    const orders = this.state.orders.filter(
      (order) => order.marketSlug === marketSlug,
    );
    const openOrders = orders.filter(
      (order) => order.status === "open" || order.status === "partial",
    );
    const fills = this.state.fills.filter(
      (fill) => fill.marketSlug === marketSlug,
    );
    const positions = derivePositions(fills);
    const capitalUsed = fills.reduce(
      (sum, fill) =>
        sum +
        ((fill.side ?? "BUY") === "SELL"
          ? -fill.price * fill.size
          : fill.price * fill.size) +
        fill.fee,
      0,
    );
    const openCommitted = openOrders.reduce(
      (sum, order) =>
        sum + ((order.side ?? "BUY") === "BUY"
          ? order.limitPrice * order.remainingSize
          : 0),
      0,
    );
    return structuredClone({
      marketSlug,
      marketDataValid: !this.invalidMarkets.has(marketSlug),
      executionPending: orders.some((order) => this.pendingV13Cancellations.has(order.id) ||
        (this.expectedFillCounts.get(order.id) ?? 0) >
        fills.filter((fill) => fill.orderId === order.id).reduce((sum, fill) => sum + fill.size, 0) + 1e-8),
      orders,
      openOrders,
      fills,
      positions,
      books: context.books,
      capitalUsed: round(capitalUsed),
      openCommitted: round(openCommitted),
      capitalCommitted: round(capitalUsed + openCommitted),
      availableCash: this.availableCashForOrders(),
      capitalConstraint: true,
      totalFees: round(fills.reduce((sum, fill) => sum + fill.fee, 0)),
      estimatedMakerRebate: 0,
      takerFeeRate:
        context.event.market.feeSchedule?.rate ??
        this.config.kalshiTakerFeeRate,
      makerFeeRate:
        context.event.market.feeSchedule?.makerRate ??
        this.config.kalshiMakerFeeRate,
      takerFeeExponent:
        context.event.market.feeSchedule?.exponent ?? 1,
      settledPnl: null,
    });
  }

  reportMarket(marketSlug: string): void {
    const snapshot = this.getMarketExecutionSnapshot(marketSlug);
    if (!snapshot || snapshot.orders.length === 0) return;
    const shares = snapshot.positions.map((position) => position.shares);
    const pairedShares = shares.length >= 2 ? Math.min(...shares) : 0;
    const maximumShares = shares.length > 0 ? Math.max(...shares) : 0;
    const context = this.contexts.get(marketSlug);
    logThrottled("Kalshi ladder market status", marketSlug, {
      market: marketSlug,
      series: context?.event.market.seriesTicker,
      capitalCommitted: snapshot.capitalCommitted,
      remainingMarketCapacity: this.config.strategyMode === "ladder_v13" ||
        this.config.strategyMode === "ladder_v14"
        ? snapshot.availableCash
        : round(
            Math.max(0, this.config.ladderMaxUsdcPerMarket - snapshot.capitalCommitted),
            4,
          ),
      availableCash: snapshot.availableCash,
      pairedShares: round(pairedShares, 4),
      unmatchedShares: round(maximumShares - pairedShares, 4),
      fees: snapshot.totalFees,
      feeAssumptions: {
        takerRate: snapshot.takerFeeRate,
        makerRate: snapshot.makerFeeRate,
        exponent: snapshot.takerFeeExponent,
      },
    });
  }

  private marketCapitalCommitted(marketSlug: string): number {
    const fills = this.state.fills.filter(
      (fill) => fill.marketSlug === marketSlug,
    );
    const capitalUsed = fills.reduce(
      (sum, fill) =>
        sum +
        ((fill.side ?? "BUY") === "SELL"
          ? -fill.price * fill.size
          : fill.price * fill.size) +
        fill.fee,
      0,
    );
    const openCommitted = this.state.orders
      .filter(
        (order) =>
          order.marketSlug === marketSlug &&
          (order.status === "open" || order.status === "partial") &&
          (order.side ?? "BUY") === "BUY",
      )
      .reduce(
        (sum, order) =>
          sum + order.limitPrice * order.remainingSize,
        0,
      );
    return round(capitalUsed + openCommitted);
  }

  private availableCashForOrders(): number {
    const openCommitted = this.state.orders
      .filter(
        (order) =>
          (order.status === "open" || order.status === "partial") &&
          (order.side ?? "BUY") === "BUY",
      )
      .reduce(
        (sum, order) => sum + order.limitPrice * order.remainingSize,
        0,
      );
    return round(
      Math.max(
        0,
        this.lastAvailableCash -
          openCommitted -
          this.inFlightReservedCash -
          [...this.unconfirmedOrderReservations.values()].reduce(
            (sum, value) => sum + value,
            0,
          ),
      ),
    );
  }

  private serializeExecution<T>(
    marketSlug: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.executionQueues.get(marketSlug) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const queued = result.then(
      () => undefined,
      () => undefined,
    );
    this.executionQueues.set(marketSlug, queued);
    void queued.finally(() => {
      if (this.executionQueues.get(marketSlug) === queued) {
        this.executionQueues.delete(marketSlug);
      }
    });
    return result;
  }

  async ingestMarketEvent(event: MarketStreamEvent): Promise<void> {
    await this.marketTelemetryHandler?.(event);
    const eventType = String(event.event_type ?? "");
    if (eventType === "market_books") {
      const ticker = String(event.market_ticker ?? "");
      const marketSlug = this.tickerToMarket.get(ticker);
      if (!marketSlug) return;
      await this.serializeExecution(marketSlug, async () => {
        const context = this.contexts.get(marketSlug);
        const updates = Array.isArray(event.books)
          ? (event.books as MarketStreamEvent[])
          : [];
        if (!context || updates.length !== 2) return;
        for (const update of updates) this.applyBookEvent(context, update);
        context.streamBacked = true;
        this.invalidMarkets.delete(marketSlug);
        this.notifyExecutionWake(marketSlug, "book");
      });
      return;
    }
    if (eventType === "market_books_invalid") {
      const tickers = Array.isArray(event.market_tickers)
        ? event.market_tickers.map(String)
        : [];
      for (const ticker of tickers) {
        const marketSlug = this.tickerToMarket.get(ticker);
        if (marketSlug) this.invalidMarkets.add(marketSlug);
      }
      return;
    }
    if (eventType === "fill") {
      const orderId = String(event.order_id ?? "");
      const ticker = String(event.market_ticker ?? event.ticker ?? "");
      const marketSlug =
        this.state.orders.find((order) => order.id === orderId)?.marketSlug ??
        this.tickerToMarket.get(ticker);
      if (!marketSlug) return;
      await this.serializeExecution(marketSlug, () =>
        this.handleFillEvent(marketSlug, event),
      );
      return;
    }
    if (eventType === "user_order") {
      const orderId = String(event.order_id ?? "");
      const ticker = String(event.ticker ?? event.market_ticker ?? "");
      const marketSlug =
        this.state.orders.find((order) => order.id === orderId)?.marketSlug ??
        this.tickerToMarket.get(ticker);
      if (!marketSlug) return;
      await this.serializeExecution(marketSlug, () =>
        this.handleUserOrderEvent(marketSlug, event),
      );
      return;
    }
    if (eventType === "kalshi_stream_connected") {
      await Promise.all(
        [...this.contexts].map(([marketSlug, context]) =>
          this.serializeExecution(marketSlug, () => this.reconcile(context.event)),
        ),
      );
      this.lastAvailableCash = await this.client.getBalance();
    }
  }

  private applyBookEvent(
    context: MarketContext,
    event: MarketStreamEvent,
  ): void {
    const tokenId = String(event.asset_id ?? "");
    const book = context.books.find((candidate) => candidate.tokenId === tokenId);
    if (!book) return;
    const bids = parseBookLevels(event.bids, false);
    const asks = parseBookLevels(event.asks, true);
    book.bids = bids;
    book.asks = asks;
    book.bestBid = bids[0]?.price ?? null;
    book.bestAsk = asks[0]?.price ?? null;
    book.timestamp = String(event.timestamp ?? Date.now());
  }

  private async handleFillEvent(
    marketSlug: string,
    event: MarketStreamEvent,
  ): Promise<void> {
    const order = this.state.orders.find(
      (candidate) => candidate.id === String(event.order_id ?? ""),
    );
    if (!order) return;
    const parsed = parseKalshiTokenId(order.tokenId);
    if (!parsed) return;
    const yesPrice = Number(event.yes_price_dollars);
    const explicitNoPrice = Number(event.no_price_dollars);
    const price =
      parsed.outcome === "yes"
        ? yesPrice
        : Number.isFinite(explicitNoPrice)
          ? explicitNoPrice
          : 1 - yesPrice;
    const size = Number(event.count_fp);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return;
    const fillId = fillKey({
      fill_id: String(event.fill_id ?? ""),
      trade_id: String(event.trade_id ?? ""),
      order_id: order.id,
    });
    if (this.state.fills.some((fill) => fill.id === fillId)) return;
    const fee = Math.max(0, Number(event.fee_cost) || 0);
    this.state.fills.push({
      id: fillId,
      orderId: order.id,
      marketSlug,
      tokenId: order.tokenId,
      outcome: order.outcome,
      price,
      size,
      fee,
      liquidity: event.is_taker ? "taker" : "maker",
      side: order.side ?? "BUY",
      timestamp: new Date(
        Number(event.ts_ms) || Number(event.ts) * 1_000 || Date.now(),
      ).toISOString(),
    });
    const filled = this.state.fills
      .filter((fill) => fill.orderId === order.id)
      .reduce((sum, fill) => sum + fill.size, 0);
    order.remainingSize = round(Math.max(0, order.originalSize - filled));
    order.status = order.remainingSize <= 1e-8 ? "filled" :
      order.status === "cancelled" || order.orderPolicy === "fak" || order.orderPolicy === "fok" ? "cancelled" : "partial";
    const expectedFill = this.expectedFillCounts.get(order.id);
    if (expectedFill === undefined || filled + 1e-8 >= expectedFill) {
      this.unconfirmedOrderReservations.delete(order.id);
      this.expectedFillCounts.delete(order.id);
    }
    this.lastAvailableCash = round(Math.max(
      0,
      this.lastAvailableCash +
        ((order.side ?? "BUY") === "SELL"
          ? price * size - fee
          : -price * size - fee),
    ));
    await this.persist();
    this.notifyExecutionWake(marketSlug, "fill");
  }

  private async handleUserOrderEvent(
    marketSlug: string,
    event: MarketStreamEvent,
  ): Promise<void> {
    const order = this.state.orders.find(
      (candidate) => candidate.id === String(event.order_id ?? ""),
    );
    if (!order) return;
    const remaining = Number(event.remaining_count_fp);
    const filled = Number(event.fill_count_fp);
    if (Number.isFinite(filled)) this.expectedFillCounts.set(order.id, Math.max(filled, this.expectedFillCounts.get(order.id) ?? 0));
    if (Number.isFinite(remaining)) order.remainingSize = Math.max(0, remaining);
    const status = String(event.status ?? "").toLowerCase();
    const immediate = order.orderPolicy === "fak" || order.orderPolicy === "fok";
    if (immediate && Number.isFinite(filled)) {
      order.remainingSize = round(Math.max(0, order.originalSize - filled));
      order.status = order.remainingSize <= 1e-8 ? "filled" : "cancelled";
    } else if (status === "canceled" || status === "cancelled" || status === "rejected") {
      order.status = "cancelled";
    } else if (order.remainingSize <= 1e-8 && (filled > 0 || status === "executed")) {
      order.status = "filled";
    } else if (status === "resting") {
      order.status = filled > 0 ? "partial" : "open";
    }
    const locallyFilled = this.state.fills
      .filter((fill) => fill.orderId === order.id)
      .reduce((sum, fill) => sum + fill.size, 0);
    if (locallyFilled + 1e-8 >= (this.expectedFillCounts.get(order.id) ?? 0)) {
      this.unconfirmedOrderReservations.delete(order.id);
      this.expectedFillCounts.delete(order.id);
    }
    await this.persist();
    this.notifyExecutionWake(marketSlug, "order");
  }

  private notifyExecutionWake(
    marketSlug: string,
    source: "book" | "fill" | "order",
  ): void {
    if (!this.executionWakeHandler || this.invalidMarkets.has(marketSlug)) return;
    const wake = this.executionWakeHandler;
    void Promise.resolve(wake(marketSlug)).catch((error) => {
      log("Kalshi WebSocket execution wake failed", {
        market: marketSlug,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async close(): Promise<void> {
    this.stream.close();
    await Promise.all(this.executionQueues.values());
    await this.persistenceQueue;
  }

  private async reconcile(event: UpDownEvent): Promise<void> {
    const ticker = event.market.externalMarketId ?? event.market.id;
    if (!ticker) return;
    const [remoteOrders, remoteFills] = await Promise.all([
      this.client.getOrders(ticker),
      this.client.getFills(ticker),
    ]);
    const localOrders = this.state.orders.filter(
      (order) => order.conditionId === ticker,
    );
    const localById = new Map(localOrders.map((order) => [order.id, order]));
    const previousFillCount = this.state.fills.length;
    for (const fill of remoteFills) {
      const order = localById.get(fill.order_id);
      if (order) addFill(this.state.fills, order, fill);
    }
    const remoteById = new Map(
      remoteOrders.map((order) => [order.order_id, order]),
    );
    for (const order of localOrders) {
      const filled = this.state.fills
        .filter((fill) => fill.orderId === order.id)
        .reduce((sum, fill) => sum + fill.size, 0);
      order.remainingSize = round(Math.max(0, order.originalSize - filled));
      const remote = remoteById.get(order.id);
      const remoteFilled = Number(remote?.fill_count_fp);
      const expected = Math.max(this.expectedFillCounts.get(order.id) ?? 0,
        Number.isFinite(remoteFilled) ? remoteFilled : 0);
      if (order.remainingSize <= 1e-8) order.status = "filled";
      else if (remote?.status === "resting") {
        order.status = filled > 0 ? "partial" : "open";
      } else if (remote?.status === "canceled" || remote?.status === "cancelled") {
        order.status = "cancelled";
      } else if (
        order.orderPolicy === "fak" ||
        order.orderPolicy === "fok" ||
        Date.now() - Date.parse(order.createdAt) > 2_000
      ) {
        order.status = "cancelled";
      }
      if (filled + 1e-8 >= expected) {
        this.unconfirmedOrderReservations.delete(order.id);
        this.expectedFillCounts.delete(order.id);
        if (remote && ["canceled", "cancelled", "executed"].includes(remote.status) && Number.isFinite(remoteFilled)) {
          this.pendingV13Cancellations.delete(order.id);
        }
      } else this.expectedFillCounts.set(order.id, expected);
    }
    await this.persist();
    if (this.state.fills.length > previousFillCount) {
      this.notifyExecutionWake(event.slug, "fill");
    }
  }

  private async persist(): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      const serialized = JSON.stringify({ ...this.state,
        expectedFillCounts: [...this.expectedFillCounts],
        pendingV13Cancellations: [...this.pendingV13Cancellations] });
      await writeFile(temporaryPath, serialized, "utf8");
      try {
        await rename(temporaryPath, this.statePath);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await writeFile(this.statePath, serialized, "utf8");
        await rm(temporaryPath, { force: true });
      }
    };
    this.persistenceQueue = this.persistenceQueue.then(
      operation,
      operation,
    );
    await this.persistenceQueue;
  }
}

function addFill(
  fills: PaperFill[],
  order: PaperOrder,
  remote: KalshiFill,
): void {
  const id = fillKey(remote);
  if (fills.some((fill) => fill.id === id)) return;
  const parsed = parseKalshiTokenId(order.tokenId);
  if (!parsed) return;
  const size = Number(remote.count_fp);
  const price = Number(
    parsed.outcome === "yes"
      ? remote.yes_price_dollars
      : remote.no_price_dollars,
  );
  if (!Number.isFinite(size) || !Number.isFinite(price) || size <= 0) return;
  fills.push({
    id,
    orderId: order.id,
    marketSlug: order.marketSlug,
    tokenId: order.tokenId,
    outcome: order.outcome,
    price,
    size,
    fee: Math.max(0, Number(remote.fee_cost) || 0),
    liquidity: remote.is_taker ? "taker" : "maker",
    side: order.side ?? "BUY",
    timestamp:
      remote.created_time ??
      new Date((remote.ts ?? Date.now() / 1_000) * 1_000).toISOString(),
  });
}

function fillKey(fill: {
  fill_id?: string;
  trade_id: string;
  order_id: string;
}): string {
  return fill.trade_id
    ? `${fill.trade_id}:${fill.order_id}`
    : fill.fill_id || `${fill.order_id}:unknown`;
}

function parseBookLevels(
  value: unknown,
  ascending: boolean,
): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((level) => {
      if (!level || typeof level !== "object") return null;
      const record = level as Record<string, unknown>;
      const price = Number(record.price);
      const size = Number(record.size);
      return Number.isFinite(price) && Number.isFinite(size) && size > 0
        ? { price, size }
        : null;
    })
    .filter((level): level is { price: number; size: number } => level !== null)
    .sort((left, right) =>
      ascending ? left.price - right.price : right.price - left.price,
    );
}

function derivePositions(fills: PaperFill[]): PaperPosition[] {
  const result = new Map<string, PaperPosition>();
  for (const fill of fills) {
    const sign = (fill.side ?? "BUY") === "SELL" ? -1 : 1;
    const existing = result.get(fill.tokenId);
    if (existing) {
      existing.shares = round(existing.shares + sign * fill.size);
      existing.totalCost = round(existing.totalCost + sign * fill.price * fill.size);
    } else {
      result.set(fill.tokenId, {
        marketSlug: fill.marketSlug,
        tokenId: fill.tokenId,
        outcome: fill.outcome,
        shares: sign * fill.size,
        totalCost: round(sign * fill.price * fill.size),
      });
    }
  }
  return [...result.values()];
}
