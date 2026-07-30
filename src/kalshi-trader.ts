import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig } from "./config.js";
import {
  KalshiClient,
  parseKalshiTokenId,
  type KalshiFill,
} from "./kalshi-api.js";
import { log } from "./logger.js";
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
}

interface MarketContext {
  event: UpDownEvent;
  books: TokenBook[];
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
  private readonly loggedFeeMarkets = new Set<string>();
  private executionQueue: Promise<void> = Promise.resolve();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private lastAvailableCash = 0;

  constructor(private readonly config: BotConfig) {
    this.client = new KalshiClient(config);
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

  async observeMarket(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    this.contexts.set(event.slug, {
      event,
      books: books.map((book) => ({
        ...book,
        bids: book.bids.map((level) => ({ ...level })),
        asks: book.asks.map((level) => ({ ...level })),
      })),
    });
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
    if (!this.config.dryRun) await this.reconcile(event);
  }

  async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
    return this.serializeExecution(() => this.placeBuyLocked(opportunity));
  }

  private async placeBuyLocked(
    opportunity: TradeOpportunity,
  ): Promise<OrderResult> {
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
    const estimatedFee =
      opportunity.size *
      feeRate *
      Math.pow(
        opportunity.price * (1 - opportunity.price),
        exponent,
      );
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
    this.lastAvailableCash = await this.client.getBalance();
    if (reserveNeeded > this.lastAvailableCash + 1e-8) {
      throw new Error(
        `Kalshi balance too low: $${this.lastAvailableCash.toFixed(2)} available, ` +
          `$${reserveNeeded.toFixed(2)} required`,
      );
    }
    const timeInForce =
      opportunity.orderPolicy === "fok"
        ? "fill_or_kill"
        : opportunity.orderPolicy === "fak"
          ? "immediate_or_cancel"
          : "good_till_canceled";
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
      await this.reconcile(opportunity.event);
      this.lastAvailableCash = await this.client.getBalance();
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
    }
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    await this.serializeExecution(() =>
      this.cancelOrdersLocked(orderIds),
    );
  }

  private async cancelOrdersLocked(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0 || this.config.dryRun) return;
    for (const orderId of orderIds) {
      await this.client.cancelOrder(orderId);
      const order = this.state.orders.find((candidate) => candidate.id === orderId);
      if (order && (order.status === "open" || order.status === "partial")) {
        order.status = "cancelled";
      }
    }
    await this.persist();
    this.lastAvailableCash = await this.client.getBalance();
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
      (sum, fill) => sum + fill.price * fill.size + fill.fee,
      0,
    );
    const openCommitted = openOrders.reduce(
      (sum, order) => sum + order.limitPrice * order.remainingSize,
      0,
    );
    return structuredClone({
      marketSlug,
      orders,
      openOrders,
      fills,
      positions,
      books: context.books,
      capitalUsed: round(capitalUsed),
      openCommitted: round(openCommitted),
      capitalCommitted: round(capitalUsed + openCommitted),
      availableCash: this.lastAvailableCash,
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
    log("Kalshi ladder market status", {
      market: marketSlug,
      series: context?.event.market.seriesTicker,
      capitalCommitted: snapshot.capitalCommitted,
      remainingMarketCapacity: round(
        Math.max(
          0,
          this.config.ladderMaxUsdcPerMarket -
            snapshot.capitalCommitted,
        ),
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
      (sum, fill) => sum + fill.price * fill.size + fill.fee,
      0,
    );
    const openCommitted = this.state.orders
      .filter(
        (order) =>
          order.marketSlug === marketSlug &&
          (order.status === "open" || order.status === "partial"),
      )
      .reduce(
        (sum, order) =>
          sum + order.limitPrice * order.remainingSize,
        0,
      );
    return round(capitalUsed + openCommitted);
  }

  private serializeExecution<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = this.executionQueue.then(operation, operation);
    this.executionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      const serialized = JSON.stringify(this.state, null, 2);
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
  if (fills.some((fill) => fill.id === remote.fill_id)) return;
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
    id: remote.fill_id,
    orderId: order.id,
    marketSlug: order.marketSlug,
    tokenId: order.tokenId,
    outcome: order.outcome,
    price,
    size,
    fee: Math.max(0, Number(remote.fee_cost) || 0),
    liquidity: remote.is_taker ? "taker" : "maker",
    timestamp:
      remote.created_time ??
      new Date((remote.ts ?? Date.now() / 1_000) * 1_000).toISOString(),
  });
}

function derivePositions(fills: PaperFill[]): PaperPosition[] {
  const result = new Map<string, PaperPosition>();
  for (const fill of fills) {
    const existing = result.get(fill.tokenId);
    if (existing) {
      existing.shares = round(existing.shares + fill.size);
      existing.totalCost = round(existing.totalCost + fill.price * fill.size);
    } else {
      result.set(fill.tokenId, {
        marketSlug: fill.marketSlug,
        tokenId: fill.tokenId,
        outcome: fill.outcome,
        shares: fill.size,
        totalCost: round(fill.price * fill.size),
      });
    }
  }
  return [...result.values()];
}
