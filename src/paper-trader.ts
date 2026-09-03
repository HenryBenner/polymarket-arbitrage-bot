import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClobClient } from "@polymarket/clob-client-v2";
import type { BotConfig } from "./config.js";
import { KalshiClient, kalshiTokenId } from "./kalshi-api.js";
import { KalshiMarketStream } from "./kalshi-market-stream.js";
import { exactKalshiDepthCost, exactKalshiFee, exactKalshiOrderFee } from "./kalshi-fees.js";
import { ladderV13SellGuard } from "./ladder-v13-inventory.js";
import { ladderV14BuyGuard, ladderV14SellGuard } from "./ladder-v14-inventory.js";
import { log, logThrottled } from "./logger.js";
import { MarketStream, type MarketStreamEvent } from "./market-stream.js";
import {
  minimumOrderRejection,
  validateOrderMinimum,
} from "./utils/order-validation.js";
import { AppendOnlyJsonl } from "./utils/append-only-jsonl.js";
import type {
  GammaMarket,
  MarketExecutionSnapshot,
  OrderBookLevel,
  OrderExecutor,
  OrderResult,
  PaperFill,
  PaperOrder,
  PaperPosition,
  PaperSettlement,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";

export const PAPER_CHECKPOINT_INTERVAL_MS = 5_000;
export const PAPER_HEALTH_INTERVAL_MS = 30_000;
export const PAPER_MAX_MAKER_EVENT_AGE_MS = 1_000;

interface PaperState {
  version: 1;
  startingBalance: number;
  cash: number;
  orders: PaperOrder[];
  fills: PaperFill[];
  positions: PaperPosition[];
  settlements: PaperSettlement[];
  seenEventKeys: string[];
  feeAccumulators?: Record<string, number>;
  /** Accounting-only metrics used when V14 paper capital constraints are off. */
  theoreticalCash?: number;
  grossCapitalDeployed?: number;
}

interface MarketContext {
  event: UpDownEvent;
  books: Map<string, TokenBook>;
  liquidity: Map<string, OrderBookLevel[]>;
  marketDataValid: boolean;
  streamBacked: boolean;
  lastEventTimestampMs: number;
}

interface PriceChange {
  asset_id?: string;
  price?: string;
  size?: string;
  side?: string;
}

interface PaperTraderOptions {
  stream?: Pick<MarketStream, "subscribe" | "close"> &
    Partial<Pick<MarketStream, "unsubscribe">>;
  feeLoader?: (
    conditionId: string,
  ) => Promise<{
    rate: number;
    makerRate?: number;
    exponent: number;
    rebateRate?: number;
  }>;
  settlementLoader?: (
    event: UpDownEvent,
  ) => Promise<{ winningTokenId: string } | null>;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketEventTimestampMs(event: Record<string, unknown>): number | null {
  const raw = event.source_timestamp ?? event.timestamp ?? event.ts;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1_000 : raw;
  if (typeof raw === "string") {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1_000 : numeric;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeRebateRate(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value > 100 && value <= 10_000) return value / 10_000;
  if (value > 1 && value <= 100) return value / 100;
  return Math.min(1, Math.max(0, value));
}

function parseLevels(value: unknown, ascending: boolean): OrderBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((level) => {
      if (!level || typeof level !== "object") return null;
      const price = parseNumber((level as Record<string, unknown>).price);
      const size = parseNumber((level as Record<string, unknown>).size);
      return price === null || size === null ? null : { price, size };
    })
    .filter((level): level is OrderBookLevel => level !== null && level.size > 0)
    .sort((left, right) =>
      ascending ? left.price - right.price : right.price - left.price,
    );
}

function emptyState(startingBalance: number): PaperState {
  return {
    version: 1,
    startingBalance,
    cash: startingBalance,
    orders: [],
    fills: [],
    positions: [],
    settlements: [],
    seenEventKeys: [],
    feeAccumulators: {},
    theoreticalCash: startingBalance,
    grossCapitalDeployed: 0,
  };
}

export class PaperTrader implements OrderExecutor {
  private state: PaperState;
  private readonly statePath: string;
  private readonly eventLogPath: string;
  private readonly stream: Pick<MarketStream, "subscribe" | "close"> &
    Partial<Pick<MarketStream, "unsubscribe">>;
  private readonly publicClient: ClobClient | null;
  private readonly kalshiClient: KalshiClient | null;
  private readonly contexts = new Map<string, MarketContext>();
  private readonly tokenToMarket = new Map<string, string>();
  private readonly fallbackChecks = new Map<string, number>();
  private readonly settlementTimers = new Map<string, NodeJS.Timeout>();
  private readonly seenEvents = new Set<string>();
  private readonly feeConfigs = new Map<
    string,
    { rate: number; makerRate: number; exponent: number; rebateRate: number }
  >();
  private readonly loggedFeeMarkets = new Set<string>();
  private readonly ordersByMarket = new Map<string, PaperOrder[]>();
  private readonly fillsByMarket = new Map<string, PaperFill[]>();
  private readonly positionsByMarket = new Map<string, PaperPosition[]>();
  private readonly settlementsByMarket = new Map<string, PaperSettlement>();
  private readonly orderByTradeKey = new Map<string, PaperOrder>();
  private readonly orderById = new Map<string, PaperOrder>();
  private readonly openOrders = new Set<PaperOrder>();
  private readonly reportStateByMarket = new Map<
    string,
    { signature: string; loggedAt: number }
  >();
  private executionWakeHandler:
    | ((marketSlug: string) => void | Promise<void>)
    | undefined;
  private marketTelemetryHandler:
    | ((event: Record<string, unknown>) => void | Promise<void>)
    | undefined;
  private settlementHandler:
    | ((settlement: PaperSettlement) => void | Promise<void>)
    | undefined;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private executionQueue: Promise<void> = Promise.resolve();
  private eventLog: AppendOnlyJsonl | undefined;
  private checkpointTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private stateDirty = false;
  private stateReady = false;
  private stateRevision = 0;
  private checkpointsPending = 0;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly pendingSettlements = new Set<Promise<void>>();
  private processingLagMs = 0;
  private lagTotal = 0;
  private lagCount = 0;
  private lagMax = 0;
  private eventsProcessed = 0;
  private fillsProcessed = 0;
  private staleEventsSkipped = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly options: PaperTraderOptions = {},
  ) {
    this.state = emptyState(config.paperStartingUsdc);
    this.statePath = join(config.paperStatePath, "paper-state.json");
    this.eventLogPath = join(config.paperStatePath, "paper-events.jsonl");
    this.stream =
      options.stream ??
      (config.exchange === "kalshi"
        ? new KalshiMarketStream(config, (event) =>
            this.ingestMarketEvent(event),
          )
        : new MarketStream((event) => this.ingestMarketEvent(event)));
    this.publicClient =
      config.exchange === "polymarket"
        ? new ClobClient({
            host: config.clobHost,
            chain: config.chainId,
          })
        : null;
    this.kalshiClient =
      config.exchange === "kalshi" ? new KalshiClient(config) : null;
  }

  async init(): Promise<void> {
    let needsCheckpoint = false;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as PaperState;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported paper state version: ${parsed.version}`);
      }
      this.state = parsed;
      this.state.positions ??= this.derivePositions(parsed.fills);
      this.state.feeAccumulators ??= {};
      this.state.theoreticalCash ??= this.state.startingBalance;
      this.state.grossCapitalDeployed ??= 0;
      for (const key of parsed.seenEventKeys) this.seenEvents.add(key);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") throw error;
      needsCheckpoint = true;
    }
    this.stateReady = true;
    if (this.closing) return;
    this.eventLog = await AppendOnlyJsonl.open(this.eventLogPath, (error) => {
      log("Paper event log failed", { error: error.message });
    });
    if (this.closing) {
      await this.eventLog.close();
      return;
    }
    // Compact checkpoints created by older versions as well as new settlements.
    if (this.pruneSettledState()) needsCheckpoint = true;
    this.rebuildStateIndexes();
    if (needsCheckpoint) await this.persist();
    if (this.closing) return;
    this.checkpointTimer = setInterval(() => {
      if (!this.stateDirty || this.checkpointsPending > 0) return;
      void this.persist().catch((error) => this.recordError("checkpoint", error));
    }, PAPER_CHECKPOINT_INTERVAL_MS);
    this.checkpointTimer.unref();
    this.healthTimer = setInterval(() => this.recordHealth(), PAPER_HEALTH_INTERVAL_MS);
    this.healthTimer.unref();

    log("Paper account loaded", {
      startingUsdc: this.state.startingBalance,
      cashUsdc: round(this.state.cash, 4),
      openOrders: this.openOrders.size,
      fills: this.state.fills.length,
    });
  }

  setMarketTelemetryHandler(
    handler: (event: Record<string, unknown>) => void | Promise<void>,
  ): void {
    this.marketTelemetryHandler = handler;
  }

  setSettlementHandler(
    handler: (settlement: PaperSettlement) => void | Promise<void>,
  ): void {
    this.settlementHandler = handler;
  }

  setExecutionWakeHandler(
    handler: (marketSlug: string) => void | Promise<void>,
  ): void {
    this.executionWakeHandler = handler;
  }

  async observeMarket(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    if (this.closing || this.settlementsByMarket.has(event.slug)) return;
    const existingContext = this.contexts.get(event.slug);
    const nextContext: MarketContext = {
      event,
      books: new Map(books.map((book) => [book.tokenId, book])),
      liquidity: new Map(
        books.map((book) => [
          book.tokenId,
          book.asks.map((level) => ({ ...level })),
        ]),
      ),
      marketDataValid: true,
      streamBacked: false,
      lastEventTimestampMs: existingContext?.lastEventTimestampMs ?? 0,
    };
    if (
      existingContext &&
      (existingContext.streamBacked || !existingContext.marketDataValid)
    ) {
      existingContext.event = event;
    } else {
      this.contexts.set(event.slug, nextContext);
    }
    for (const book of books) this.tokenToMarket.set(book.tokenId, event.slug);
    this.stream.subscribe(books.map((book) => book.tokenId));
    await this.loadFeeConfig(event);
    if (!this.loggedFeeMarkets.has(event.slug)) {
      const fees = this.feeConfig(event.market);
      this.loggedFeeMarkets.add(event.slug);
      log("Paper market fee assumptions", {
        market: event.slug,
        series: event.market.seriesTicker,
        takerRate: fees.rate,
        makerRate: fees.makerRate,
        exponent: fees.exponent,
      });
    }
    this.scheduleSettlementFallback(event);

    if (Date.now() / 1000 >= event.windowEnd) {
      await this.checkSettlement(event);
    }
  }

  async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
    return this.serializeExecution(() => this.placeBuyLocked(opportunity));
  }

  async placeBuys(opportunities: readonly TradeOpportunity[]): Promise<OrderResult[]> {
    return this.serializeExecution(() => {
      if (opportunities.length === 0) return [];
      const slug = opportunities[0]!.event.slug;
      if (opportunities.some((opportunity) => opportunity.event.slug !== slug)) {
        throw new Error("Paper batch orders must belong to one market");
      }
      const required = opportunities.reduce((sum, opportunity) => {
        const fees = this.feeConfig(opportunity.event.market);
        const rate = opportunity.orderPolicy === "post_only"
          ? fees.makerRate : Math.max(fees.rate, fees.makerRate);
        const fee = this.config.exchange === "kalshi"
          ? exactKalshiOrderFee({ price: opportunity.price, size: opportunity.size, rate, exponent: fees.exponent })
          : opportunity.size * rate * Math.pow(opportunity.price * (1 - opportunity.price), fees.exponent);
        return sum + opportunity.price * opportunity.size + fee;
      }, 0);
      const unlimitedV14 = opportunities.every(
        (opportunity) => opportunity.strategyMode === "ladder_v14",
      );
      if (!unlimitedV14 && required > this.availableCash() + 1e-8) {
        throw new Error(`Paper balance too low: $${this.availableCash().toFixed(2)} available, $${required.toFixed(2)} required`);
      }
      const results: OrderResult[] = [];
      for (const opportunity of opportunities) results.push(this.placeBuyLocked(opportunity));
      return results;
    });
  }

  async placeSell(opportunity: TradeOpportunity): Promise<OrderResult> {
    return this.serializeExecution(() => this.placeSellLocked(opportunity));
  }

  private placeBuyLocked(
    opportunity: TradeOpportunity,
  ): OrderResult {
    if (this.settlementsByMarket.has(opportunity.event.slug)) {
      return { dryRun: true, accepted: false, tokenId: opportunity.token.tokenId,
        side: "BUY", price: opportunity.price, size: opportunity.size,
        response: { paper: true, reason: "market_settled" } };
    }
    const existing = this.orderByTradeKey.get(opportunity.tradeKey);
    if (existing) {
      return {
        dryRun: true,
        accepted: true,
        tokenId: existing.tokenId,
        side: "BUY",
        price: existing.limitPrice,
        size: existing.originalSize,
        response: { paper: true, duplicate: true, orderId: existing.id },
      };
    }

    if (this.config.ladderV14VolumeFirstMode && opportunity.strategyMode === "ladder_v14") {
      const reason = ladderV14BuyGuard(this.getMarketExecutionSnapshot(opportunity.event.slug), opportunity);
      if (reason) return { dryRun: true, accepted: false, tokenId: opportunity.token.tokenId,
        side: "BUY", price: opportunity.price, size: opportunity.size,
        response: { paper: true, status: "rejected", reason } };
    }
    const minimumFailure = validateOrderMinimum(opportunity);
    if (minimumFailure) {
      return minimumOrderRejection(opportunity, minimumFailure, true);
    }

    const context = this.contexts.get(opportunity.event.slug);
    const currentBook = context?.books.get(opportunity.token.tokenId);
    if (
      opportunity.orderPolicy === "post_only" &&
      currentBook?.bestAsk !== null &&
      currentBook?.bestAsk !== undefined &&
      opportunity.price + 1e-9 >= currentBook.bestAsk
    ) {
      return {
        dryRun: true,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
        response: {
          paper: true,
          status: "rejected",
          reason: "post_only_would_cross",
        },
      };
    }
    const asks =
      context?.liquidity.get(opportunity.token.tokenId) ??
      opportunity.token.asks.map((level) => ({ ...level }));
    const feeConfig = this.feeConfig(opportunity.event.market);
    const feeRate =
      opportunity.orderPolicy === "post_only"
        ? feeConfig.makerRate
        : Math.max(feeConfig.rate, feeConfig.makerRate);
    const estimatedFee = this.config.exchange === "kalshi"
      ? exactKalshiOrderFee({
          price: opportunity.price,
          size: opportunity.size,
          rate: feeRate,
          exponent: feeConfig.exponent,
        })
      : opportunity.size * feeRate * Math.pow(
          opportunity.price * (1 - opportunity.price), feeConfig.exponent,
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
        dryRun: true,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
        response: {
          paper: true,
          status: "rejected",
          reason: "per_market_cap",
          capitalCommitted: round(capitalCommitted, 4),
          prospectiveCapital: round(projectedCommitment, 4),
          capUsdc: this.config.ladderMaxUsdcPerMarket,
        },
      };
    }
    const unlimitedV14 = opportunity.strategyMode === "ladder_v14";
    const available = unlimitedV14 ? Number.MAX_SAFE_INTEGER : this.availableCash();
    if (!unlimitedV14 && reserveNeeded > available + 1e-8) {
      throw new Error(
        `Paper balance too low: $${available.toFixed(2)} available, ` +
          `$${reserveNeeded.toFixed(2)} required`,
      );
    }
    let fokCanFill = opportunity.orderPolicy !== "fok";
    if (opportunity.orderPolicy === "fok") {
      if (this.config.exchange === "kalshi") {
        const depth = exactKalshiDepthCost({
          levels: asks.filter((level) => level.price <= opportunity.price + 1e-9),
          size: opportunity.size,
          rate: feeConfig.rate,
          exponent: feeConfig.exponent,
        });
        fokCanFill = depth !== null && depth.total <= available + 1e-8;
      } else {
        let remaining = opportunity.size;
        let totalCost = 0;
        for (const level of asks) {
          if (remaining <= 1e-8 || level.price > opportunity.price + 1e-9) break;
          const selected = Math.min(remaining, level.size);
          if (selected <= 1e-8) continue;
          const fee = selected * feeConfig.rate * Math.pow(
            level.price * (1 - level.price), feeConfig.exponent,
          );
          totalCost += selected * level.price + fee;
          remaining = round(remaining - selected);
        }
        fokCanFill = remaining <= 1e-8 && totalCost <= available + 1e-8;
      }
    }
    const queueAhead = (context?.books.get(opportunity.token.tokenId)?.bids ?? [])
      .filter((level) => Math.abs(level.price - opportunity.price) < 1e-9)
      .reduce((sum, level) => sum + level.size, 0);
    const now = new Date().toISOString();
    const order: PaperOrder = {
      id: `paper-${randomUUID()}`,
      tradeKey: opportunity.tradeKey,
      marketSlug: opportunity.event.slug,
      marketTitle: opportunity.event.title,
      conditionId: opportunity.event.market.conditionId,
      tokenId: opportunity.token.tokenId,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      originalSize: opportunity.size,
      remainingSize: opportunity.size,
      queueAhead,
      status: "open",
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
      createdAt: now,
      submittedMinutesLeft:
        (opportunity.event.windowEnd - Date.now() / 1000) / 60,
    };
    this.state.orders.push(order);
    this.indexOrder(order);
    this.record("order_submitted", order);

    if (opportunity.orderPolicy !== "post_only" && fokCanFill) {
      for (const level of asks) {
        if (
          order.remainingSize <= 1e-8 ||
          level.price > order.limitPrice + 1e-9
        ) {
          break;
        }
        const fillSize = Math.min(order.remainingSize, level.size);
        if (fillSize <= 1e-8) continue;
        this.applyFill(
          order,
          level.price,
          fillSize,
          "taker",
          feeConfig,
          now,
        );
        level.size = round(level.size - fillSize);
      }
      if (context) context.liquidity.set(order.tokenId, asks);
    }
    if (
      (opportunity.orderPolicy === "fak" ||
        opportunity.orderPolicy === "fok") &&
      order.remainingSize > 1e-8
    ) {
      order.status = "cancelled";
      this.refreshOpenOrder(order);
      this.record("order_cancelled", order);
    }
    this.schedulePersist();

    return {
      dryRun: true,
      accepted: true,
      tokenId: order.tokenId,
      side: "BUY",
      price: order.limitPrice,
      size: order.originalSize,
      response: {
        paper: true,
        orderId: order.id,
        status: order.status,
        filledSize: round(order.originalSize - order.remainingSize),
        queueAhead: round(order.queueAhead),
      },
    };
  }

  private placeSellLocked(
    opportunity: TradeOpportunity,
  ): OrderResult {
    if (this.settlementsByMarket.has(opportunity.event.slug)) {
      return { dryRun: true, accepted: false, tokenId: opportunity.token.tokenId,
        side: "SELL", price: opportunity.price, size: opportunity.size,
        response: { paper: true, reason: "market_settled" } };
    }
    if (opportunity.strategyMode === "ladder_v13") {
      const snapshot = this.getMarketExecutionSnapshot(opportunity.event.slug);
      const failure = validateOrderMinimum(opportunity);
      const reason = failure?.reason ?? (opportunity.orderPolicy !== "fak" ? "v13_sale_requires_ioc" :
        snapshot ? ladderV13SellGuard(snapshot, opportunity.token.tokenId, opportunity.size) : "missing_market_snapshot");
      if (reason) return { dryRun: true, accepted: false, tokenId: opportunity.token.tokenId,
        side: "SELL", price: opportunity.price, size: opportunity.size,
        response: { paper: true, status: "rejected", reason } };
    }
    if (opportunity.strategyMode === "ladder_v14") {
      const snapshot = this.getMarketExecutionSnapshot(opportunity.event.slug);
      const failure = validateOrderMinimum(opportunity);
      const reason = failure?.reason ??
        (opportunity.orderPolicy !== "fak"
          ? "v14_sale_requires_ioc"
          : snapshot
            ? ladderV14SellGuard(snapshot, opportunity.token.tokenId, opportunity.size)
            : "missing_market_snapshot");
      if (reason) return {
        dryRun: true,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "SELL",
        price: opportunity.price,
        size: opportunity.size,
        response: { paper: true, status: "rejected", reason },
      };
    }
    const existing = this.orderByTradeKey.get(opportunity.tradeKey);
    if (existing) {
      return {
        dryRun: true,
        accepted: true,
        tokenId: existing.tokenId,
        side: "SELL",
        price: existing.limitPrice,
        size: existing.originalSize,
        response: { paper: true, duplicate: true, orderId: existing.id },
      };
    }
    const position = (
      this.positionsByMarket.get(opportunity.event.slug) ?? []
    ).find((candidate) => candidate.tokenId === opportunity.token.tokenId);
    if (!position || position.shares + 1e-8 < opportunity.size) {
      return {
        dryRun: true,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "SELL",
        price: opportunity.price,
        size: opportunity.size,
        response: {
          paper: true,
          status: "rejected",
          reason: "position_too_small",
        },
      };
    }
    const context = this.contexts.get(opportunity.event.slug);
    const book =
      context?.books.get(opportunity.token.tokenId) ?? opportunity.token;
    const bids = book.bids.map((level) => ({ ...level })).sort((a, b) => b.price - a.price);
    const feeConfig = this.feeConfig(opportunity.event.market);
    const now = new Date().toISOString();
    const order: PaperOrder = {
      id: `paper-${randomUUID()}`,
      tradeKey: opportunity.tradeKey,
      marketSlug: opportunity.event.slug,
      marketTitle: opportunity.event.title,
      conditionId: opportunity.event.market.conditionId,
      tokenId: opportunity.token.tokenId,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      originalSize: opportunity.size,
      remainingSize: opportunity.size,
      queueAhead: 0,
      status: "open",
      side: "SELL",
      phaseId: opportunity.phaseId,
      pairId: opportunity.pairId,
      orderPolicy: opportunity.orderPolicy ?? "fak",
      createdAt: now,
      submittedMinutesLeft:
        (opportunity.event.windowEnd - Date.now() / 1_000) / 60,
    };
    this.state.orders.push(order);
    this.indexOrder(order);
    this.record("order_submitted", order);
    for (const level of bids) {
      if (
        order.remainingSize <= 1e-8 ||
        level.price + 1e-9 < order.limitPrice
      ) {
        break;
      }
      const fillSize = Math.min(order.remainingSize, level.size);
      if (fillSize <= 1e-8) continue;
      this.applySellFill(order, level.price, fillSize, feeConfig, now);
      level.size = round(level.size - fillSize);
    }
    book.bids = bids.filter((level) => level.size > 1e-8);
    book.bestBid = book.bids[0]?.price ?? null;
    if (order.remainingSize > 1e-8) {
      order.status = "cancelled";
      this.refreshOpenOrder(order);
      this.record("order_cancelled", order);
    }
    this.schedulePersist();
    return {
      dryRun: true,
      accepted: true,
      tokenId: order.tokenId,
      side: "SELL",
      price: order.limitPrice,
      size: order.originalSize,
      response: {
        paper: true,
        orderId: order.id,
        status: order.status,
        filledSize: round(order.originalSize - order.remainingSize),
      },
    };
  }

  private serializeExecution<T>(
    operation: () => T,
  ): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Paper trader is closed"));
    const result = this.executionQueue.then(operation, operation);
    this.executionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    await this.serializeExecution(() =>
      this.cancelOrdersLocked(orderIds),
    );
  }

  private cancelOrdersLocked(orderIds: string[]): void {
    if (orderIds.length === 0) return;
    for (const orderId of orderIds) {
      const order = this.orderById.get(orderId);
      if (
        order &&
        (order.status === "open" || order.status === "partial")
      ) {
        order.status = "cancelled";
        this.refreshOpenOrder(order);
        this.record("order_cancelled", order);
      }
    }
    this.schedulePersist();
  }

  async amendOrder(
    orderId: string,
    opportunity: TradeOpportunity,
  ): Promise<OrderResult> {
    return this.serializeExecution(() =>
      this.amendOrderLocked(orderId, opportunity),
    );
  }

  private amendOrderLocked(
    orderId: string,
    opportunity: TradeOpportunity,
  ): OrderResult {
    const order = this.orderById.get(orderId);
    if (
      !order ||
      (order.status !== "open" && order.status !== "partial") ||
      (order.side ?? "BUY") !== "BUY"
    ) {
      return {
        dryRun: true,
        accepted: false,
        tokenId: opportunity.token.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
        response: { paper: true, status: "rejected", reason: "order_not_open" },
      };
    }
    if (this.config.ladderV14VolumeFirstMode && opportunity.strategyMode === "ladder_v14") {
      const reason = ladderV14BuyGuard(this.getMarketExecutionSnapshot(opportunity.event.slug), opportunity, orderId);
      if (reason) return { dryRun: true, accepted: false, tokenId: opportunity.token.tokenId,
        side: "BUY", price: opportunity.price, size: opportunity.size,
        response: { paper: true, status: "rejected", reason } };
    }
    const alreadyFilled = round(order.originalSize - order.remainingSize);
    const context = this.contexts.get(order.marketSlug);
    const asks =
      context?.liquidity.get(order.tokenId) ??
      opportunity.token.asks.map((level) => ({ ...level }));
    const feeConfig = this.feeConfig(opportunity.event.market);
    const oldReserve = order.limitPrice * order.remainingSize;
    const newReserve = opportunity.price * opportunity.size;
    if (
      opportunity.strategyMode !== "ladder_v14" &&
      newReserve > this.availableCash() + oldReserve + 1e-8
    ) {
      return {
        dryRun: true,
        accepted: false,
        tokenId: order.tokenId,
        side: "BUY",
        price: opportunity.price,
        size: opportunity.size,
        response: { paper: true, status: "rejected", reason: "balance_too_low" },
      };
    }
    const previousTradeKey = order.tradeKey;
    order.limitPrice = opportunity.price;
    order.tradeKey = opportunity.tradeKey;
    this.orderByTradeKey.delete(previousTradeKey);
    this.orderByTradeKey.set(order.tradeKey, order);
    order.originalSize = round(alreadyFilled + opportunity.size);
    order.remainingSize = opportunity.size;
    order.orderPolicy = opportunity.orderPolicy ?? "gtc";
    order.pairId = opportunity.pairId;
    order.pairLockRole = opportunity.pairLockRole;
    order.referenceTokenId = opportunity.referenceTokenId;
    order.referenceAllInPrice = opportunity.referenceAllInPrice;
    order.plannedAllInPairCost = opportunity.plannedAllInPairCost;
    order.plannedNetEdgePerPair = opportunity.plannedNetEdgePerPair;
    order.queueAhead = (context?.books.get(order.tokenId)?.bids ?? [])
      .filter((level) => Math.abs(level.price - opportunity.price) < 1e-9)
      .reduce((sum, level) => sum + level.size, 0);
    const now = new Date().toISOString();
    this.record("order_amended", order);
    for (const level of asks) {
      if (
        order.remainingSize <= 1e-8 ||
        level.price > order.limitPrice + 1e-9
      ) {
        break;
      }
      const fillSize = Math.min(order.remainingSize, level.size);
      if (fillSize <= 1e-8) continue;
      this.applyFill(order, level.price, fillSize, "taker", feeConfig, now);
      level.size = round(level.size - fillSize);
    }
    if (context) context.liquidity.set(order.tokenId, asks);
    this.schedulePersist();
    return {
      dryRun: true,
      accepted: true,
      tokenId: order.tokenId,
      side: "BUY",
      price: order.limitPrice,
      size: opportunity.size,
      response: {
        paper: true,
        orderId: order.id,
        status: order.status,
        filledSize: round(order.originalSize - order.remainingSize),
      },
    };
  }

  reportMarket(marketSlug: string): void {
    if (this.config.strategyMode === "ladder_v14") return;
    const orders = this.ordersByMarket.get(marketSlug) ?? [];
    if (orders.length === 0) return;
    const fills = this.fillsByMarket.get(marketSlug) ?? [];
    const signature = `${orders.length}:${fills.length}:${orders
      .map((order) => `${order.status}:${order.remainingSize}`)
      .join("|")}:${this.settlementsByMarket.has(marketSlug)}`;
    const previousReport = this.reportStateByMarket.get(marketSlug);
    const now = Date.now();
    const unchangedReportIntervalMs =
      this.config.strategyMode === "ladder_v11" ||
      this.config.strategyMode === "ladder_v12" ||
      this.config.strategyMode === "ladder_v13"
        ? 300_000
        : 30_000;
    if (
      previousReport?.signature === signature &&
      now - previousReport.loggedAt < unchangedReportIntervalMs
    ) {
      return;
    }
    this.reportStateByMarket.set(marketSlug, { signature, loggedAt: now });
    const outcomeTotals = new Map<
      string,
      { shares: number; cost: number; fees: number }
    >();
    for (const fill of fills) {
      const aggregate = outcomeTotals.get(fill.outcome) ?? {
        shares: 0,
        cost: 0,
        fees: 0,
      };
      const direction = fill.side === "SELL" ? -1 : 1;
      aggregate.shares += direction * fill.size;
      aggregate.cost += direction * fill.size * fill.price;
      aggregate.fees += fill.fee;
      outcomeTotals.set(fill.outcome, aggregate);
    }

    const shares = [...outcomeTotals.values()].map((value) => value.shares);
    const guaranteedPayout = shares.length >= 2 ? Math.min(...shares) : 0;
    const maximumPayout = shares.length > 0 ? Math.max(...shares) : 0;
    const used = [...outcomeTotals.values()].reduce(
      (sum, value) => sum + value.cost + value.fees,
      0,
    );
    const openCommitted = orders
      .filter(
        (order) =>
          order.status === "open" || order.status === "partial",
      )
      .reduce(
        (sum, order) =>
          sum +
          ((order.side ?? "BUY") === "BUY"
            ? order.limitPrice * order.remainingSize
            : 0),
        0,
      );
    const committed = used + openCommitted;
    const outcomeValues = [...outcomeTotals.entries()];
    const conservativeMatchedCost = (outcome: string, sharesToMatch: number) => {
      let remaining = sharesToMatch;
      let cost = 0;
      const lots = fills
        .filter(
          (fill) =>
            fill.outcome === outcome &&
            fill.size > 0 &&
            (fill.side ?? "BUY") === "BUY",
        )
        .map((fill) => ({
          size: fill.size,
          unitCost: (fill.price * fill.size + fill.fee) / fill.size,
        }))
        .sort((left, right) => right.unitCost - left.unitCost);
      for (const lot of lots) {
        if (remaining <= 1e-8) break;
        const used = Math.min(lot.size, remaining);
        cost += used * lot.unitCost;
        remaining -= used;
      }
      return remaining <= 1e-8 ? cost : null;
    };
    const matchedCosts = outcomeValues
      .slice(0, 2)
      .map(([outcome]) => conservativeMatchedCost(outcome, guaranteedPayout));
    const effectivePairCost =
      guaranteedPayout > 0 &&
      matchedCosts.length === 2 &&
      matchedCosts.every((value) => value !== null)
        ? matchedCosts.reduce((sum, value) => sum + (value ?? 0), 0) /
          guaranteedPayout
        : null;
    log("Paper cycle status", {
      market: marketSlug,
      ordersSubmitted: orders.length,
      filled: orders.filter((order) => order.status === "filled").length,
      partial: orders.filter((order) => order.status === "partial").length,
      unfilled: orders.filter((order) => order.status === "open").length,
      capitalCommitted: round(committed, 4),
      remainingMarketCapacity: this.config.strategyMode === "ladder_v13"
        ? round(this.availableCash(), 4)
        : round(
            Math.max(0, this.config.ladderMaxUsdcPerMarket - committed),
            4,
          ),
      capitalUsed: round(used, 4),
      byOutcome: [...outcomeTotals.entries()].map(([outcome, value]) => ({
        outcome,
        shares: round(value.shares, 4),
        averagePrice:
          value.shares > 0 ? round(value.cost / value.shares, 4) : null,
      })),
      guaranteedPayout: round(guaranteedPayout, 4),
      outcomeDependentPayout: round(maximumPayout - guaranteedPayout, 4),
      unmatchedShares: round(maximumPayout - guaranteedPayout, 4),
      fees: round(
        fills.reduce((sum, fill) => sum + fill.fee, 0),
        6,
      ),
      makerFeeEquivalent: round(
        fills.reduce(
          (sum, fill) => sum + (fill.makerFeeEquivalent ?? 0),
          0,
        ),
        6,
      ),
      estimatedMakerRebate: round(
        fills.reduce(
          (sum, fill) => sum + (fill.estimatedMakerRebate ?? 0),
          0,
        ),
        6,
      ),
      matchedShares: round(guaranteedPayout, 4),
      lockedPayout: round(guaranteedPayout, 4),
      effectivePairedCost:
        effectivePairCost === null ? null : round(effectivePairCost, 6),
      lockedEdgePerShare:
        effectivePairCost === null ? null : round(1 - effectivePairCost, 6),
      lockedEdgeUsdc:
        effectivePairCost === null
          ? null
          : round(guaranteedPayout * (1 - effectivePairCost), 4),
      feeAssumptions: (() => {
        const context = this.contexts.get(marketSlug);
        if (!context) return null;
        const fees = this.feeConfig(context.event.market);
        return {
          series: context.event.market.seriesTicker,
          takerRate: fees.rate,
          makerRate: fees.makerRate,
          exponent: fees.exponent,
        };
      })(),
      settledPnl:
        this.settlementsByMarket.get(marketSlug)?.realizedPnl ?? null,
      profileComparison: {
        presetPriceLevels:
          this.config.strategyMode === "odahoa_static_maker"
            ? "odahoa_static_maker"
            : this.config.strategyMode === "ladder_v5"
              ? "ladder_v5 late 10/90 + 15/85"
              : this.config.strategyMode === "ladder_v5.5"
                ? "ladder_v5.5 phased dynamic confirmed-fill hedge"
                : this.config.strategyMode === "ladder_v6"
                  ? "ladder_v6 paired makers / maker-FOK completion"
                  : this.config.strategyMode === "ladder_v10"
                    ? "ladder_v10 regime-gated V7 / strict FOK completion"
                  : this.config.strategyMode === "ladder_v11"
                    ? "ladder_v11 BRTI-only low-reversal 40/40 ladder"
                  : this.config.strategyMode === "ladder_v12"
                    ? "ladder_v12 BRTI 0/20/40 cheap-first completion ladder"
                  : this.config.strategyMode === "ladder_v13"
                    ? "ladder_v13 dynamic microprice pair-arbitrage maker"
                  : this.config.strategyMode === "ladder_v7"
                    ? "ladder_v7 fixed cheap maker / capped favorite FAK"
                    : this.config.strategyMode === "ladder_v8"
                      ? "ladder_v8 Odahoa-sized complementary maker grid"
                      : this.config.strategyMode === "ladder_v9"
                        ? "ladder_v9 staged entry / completion / rescue"
                        : `${this.config.ladderPreset} public-fill approximation`,
        firstVisibleFillMinutesLeft:
          fills.length > 0
            ? round(
                orders.find((order) => order.id === fills[0]?.orderId)
                  ?.submittedMinutesLeft ?? 0,
                2,
              )
            : null,
      },
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.stream.close();
    for (const timer of this.settlementTimers.values()) clearTimeout(timer);
    this.settlementTimers.clear();
    await this.executionQueue;
    const settlements = await Promise.allSettled([...this.pendingSettlements]);
    // Attempt both outputs even if a disk error affects one of them.
    const logResult = await Promise.allSettled([this.eventLog?.close()]);
    // Do not overwrite an unreadable/unsupported checkpoint after init fails.
    const checkpointResult = await Promise.allSettled([this.stateReady ? this.persist() : undefined]);
    const failures = [...settlements, ...logResult, ...checkpointResult].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Paper shutdown save failed");
  }

  snapshot(): Readonly<PaperState> {
    return structuredClone({ ...this.state, seenEventKeys: [...this.seenEvents] });
  }

  getMarketExecutionSnapshot(
    marketSlug: string,
  ): Readonly<MarketExecutionSnapshot> | null {
    const context = this.contexts.get(marketSlug);
    if (!context) return null;
    const orders = this.ordersByMarket.get(marketSlug) ?? [];
    const openOrders = orders.filter(
      (order) => order.status === "open" || order.status === "partial",
    );
    const fills = this.fillsByMarket.get(marketSlug) ?? [];
    const positions = this.positionsByMarket.get(marketSlug) ?? [];
    const capitalUsed = fills.reduce(
      (sum, fill) =>
        sum +
        (fill.side === "SELL"
          ? -fill.price * fill.size + fill.fee
          : fill.price * fill.size + fill.fee),
      0,
    );
    const openCommitted = openOrders.reduce(
      (sum, order) =>
        sum +
        ((order.side ?? "BUY") === "BUY"
          ? order.limitPrice * order.remainingSize
          : 0),
      0,
    );
    const feeConfig = this.feeConfig(context.event.market);
    const books = [...context.books.values()].map((book) => ({
      ...book,
      bids: book.bids.map((level) => ({ ...level })),
      asks: (context.liquidity.get(book.tokenId) ?? book.asks).map((level) => ({
        ...level,
      })),
    }));
    const v14Paper = this.config.strategyMode === "ladder_v14";
    const markedInventoryValue = positions.reduce((sum, position) => {
      const book = books.find((candidate) => candidate.tokenId === position.tokenId);
      return sum + position.shares * (book?.bestBid ?? 0);
    }, 0);
    const remainingInventoryCost = positions.reduce(
      (sum, position) => sum + position.totalCost,
      0,
    );
    const realizedPnl = this.state.settlements.reduce(
      (sum, settlement) => sum + settlement.realizedPnl,
      0,
    );
    return structuredClone({
      marketSlug,
      marketDataValid: context.marketDataValid,
      orders,
      openOrders,
      fills,
      positions,
      books,
      capitalUsed: round(capitalUsed),
      openCommitted: round(openCommitted),
      capitalCommitted: round(capitalUsed + openCommitted),
      availableCash: v14Paper ? Number.MAX_SAFE_INTEGER : this.availableCash(),
      capitalConstraint: !v14Paper,
      hypotheticalStartingBalance: this.state.startingBalance,
      grossCapitalDeployed: this.state.grossCapitalDeployed,
      theoreticalCash: this.state.theoreticalCash,
      markedInventoryValue: round(markedInventoryValue),
      realizedPnl: round(realizedPnl),
      unrealizedPnl: round(markedInventoryValue - remainingInventoryCost),
      totalFees: round(fills.reduce((sum, fill) => sum + fill.fee, 0)),
      estimatedMakerRebate: round(
        fills.reduce(
          (sum, fill) => sum + (fill.estimatedMakerRebate ?? 0),
          0,
        ),
      ),
      takerFeeRate: feeConfig.rate,
      makerFeeRate: feeConfig.makerRate,
      takerFeeExponent: feeConfig.exponent,
      settledPnl:
        this.settlementsByMarket.get(marketSlug)?.realizedPnl ?? null,
    });
  }

  async ingestMarketEvent(event: MarketStreamEvent): Promise<void> {
    if (this.closing) return;
    const receivedAtMs = Date.now();
    let settlement: Promise<void> | undefined;
    const ingest = (): void => {
      this.processingLagMs = Math.max(0, Date.now() - receivedAtMs);
      this.lagTotal += this.processingLagMs;
      this.lagCount += 1;
      this.lagMax = Math.max(this.lagMax, this.processingLagMs);
      this.eventsProcessed += 1;
      // Check before chronology/deduplication so stale trades are counted even
      // when a newer book has already arrived. Never consume their queue volume.
      if (event.event_type === "last_trade_price") {
        const atMs = marketEventTimestampMs(event);
        const eventAgeMs = atMs === null ? 0 : Date.now() - atMs;
        if (eventAgeMs > PAPER_MAX_MAKER_EVENT_AGE_MS) {
          this.staleEventsSkipped += 1;
          this.record("stale_event_skipped", {
            tokenId: event.asset_id, eventTimestampMs: atMs, eventAgeMs,
          });
          return;
        }
      }
      if (!this.acceptMonotonicEvent(event)) return;
      if (event.event_type === "market_resolved") {
        const tokenId = String(event.winning_asset_id ?? event.asset_id ?? "");
        if (tokenId) settlement = this.settleWinningToken(tokenId);
        return;
      }
      this.handleStreamEvent(event);
      // The V14 telemetry callback updates RAM. Do not hold execution behind
      // asynchronous observers, and make fresh telemetry visible before waking.
      try {
        const telemetry = this.marketTelemetryHandler?.(event);
        if (telemetry) void telemetry.catch((error) => this.recordError("telemetry", error));
      } catch (error) {
        this.recordError("telemetry", error);
      }
      this.notifyExecutionWake(event);
    };
    if (
      this.config.strategyMode === "ladder_v13" ||
      this.config.strategyMode === "ladder_v14"
    ) await this.serializeExecution(ingest);
    else ingest();
    // Settlement is an awaited durability boundary, outside the RAM queue so
    // another market's book/fills can keep advancing while it writes.
    await settlement;
  }

  private acceptMonotonicEvent(event: MarketStreamEvent): boolean {
    const atMs = marketEventTimestampMs(event);
    if (atMs === null) return true;
    const tokenIds = new Set<string>();
    const direct = String(event.asset_id ?? "");
    if (direct) tokenIds.add(direct);
    if (Array.isArray(event.price_changes)) {
      for (const change of event.price_changes as PriceChange[]) {
        const id = String(change.asset_id ?? direct);
        if (id) tokenIds.add(id);
      }
    }
    if (Array.isArray(event.books)) {
      for (const book of event.books as MarketStreamEvent[]) {
        const id = String(book.asset_id ?? "");
        if (id) tokenIds.add(id);
      }
    }
    const contexts = [...tokenIds]
      .map((id) => this.tokenToMarket.get(id))
      .filter((slug): slug is string => Boolean(slug))
      .map((slug) => this.contexts.get(slug))
      .filter((context): context is MarketContext => Boolean(context));
    if (contexts.some((context) => atMs + 1e-6 < context.lastEventTimestampMs)) return false;
    for (const context of contexts) context.lastEventTimestampMs = Math.max(context.lastEventTimestampMs, atMs);
    return true;
  }

  private availableCash(): number {
    const reserved = [...this.openOrders]
      .filter((order) => (order.side ?? "BUY") === "BUY")
      .reduce(
        (sum, order) => sum + order.remainingSize * order.limitPrice,
        0,
      );
    return round(this.state.cash - reserved);
  }

  private marketCapitalCommitted(marketSlug: string): number {
    const capitalUsed = (this.fillsByMarket.get(marketSlug) ?? [])
      .reduce(
        (sum, fill) =>
          sum +
          (fill.side === "SELL"
            ? -fill.price * fill.size + fill.fee
            : fill.price * fill.size + fill.fee),
        0,
      );
    const openCommitted = (this.ordersByMarket.get(marketSlug) ?? [])
      .filter(
        (order) =>
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

  private feeConfig(market: GammaMarket): {
    rate: number;
    makerRate: number;
    exponent: number;
    rebateRate: number;
  } {
    const cached = this.feeConfigs.get(market.conditionId);
    if (cached) return cached;
    const rawRate = market.feeSchedule?.rate ?? 0;
    return {
      rate: rawRate > 1 ? rawRate / 10_000 : rawRate,
      makerRate: market.feeSchedule?.makerRate ?? 0,
      exponent: market.feeSchedule?.exponent ?? 1,
      rebateRate: normalizeRebateRate(
        market.feeSchedule?.rebateRate,
        0,
      ),
    };
  }

  private applyFill(
    order: PaperOrder,
    price: number,
    size: number,
    liquidity: "taker" | "maker",
    feeConfig: {
      rate: number;
      makerRate: number;
      exponent: number;
      rebateRate: number;
    },
    timestamp: string,
  ): void {
    const actualSize = round(Math.min(size, order.remainingSize));
    if (actualSize <= 0) return;
    const feeRate =
      liquidity === "taker" ? feeConfig.rate : feeConfig.makerRate;
    const kalshiFee = this.config.exchange === "kalshi"
      ? exactKalshiFee({
          price,
          size: actualSize,
          rate: feeRate,
          exponent: feeConfig.exponent,
          side: "BUY",
          accumulator: this.state.feeAccumulators?.[order.id] ?? 0,
        })
      : null;
    if (kalshiFee) {
      this.state.feeAccumulators ??= {};
      this.state.feeAccumulators[order.id] = kalshiFee.accumulator;
    }
    const fee = kalshiFee?.netFee ?? round(
      actualSize * feeRate * Math.pow(price * (1 - price), feeConfig.exponent),
      5,
    );
    const makerFeeEquivalent =
      liquidity === "maker"
        ? round(
            actualSize *
              feeConfig.rate *
              Math.pow(price * (1 - price), feeConfig.exponent),
            5,
          )
        : 0;
    const estimatedMakerRebate =
      liquidity === "maker"
        ? round(makerFeeEquivalent * feeConfig.rebateRate, 5)
        : 0;
    const cost = round(actualSize * price);
    const unlimitedV14 = order.pairId?.startsWith("ladder-v14:") ?? false;
    if (!unlimitedV14 && cost + fee > this.state.cash + 1e-8) return;

    const fill: PaperFill = {
      id: `fill-${randomUUID()}`,
      orderId: order.id,
      marketSlug: order.marketSlug,
      tokenId: order.tokenId,
      outcome: order.outcome,
      price,
      size: actualSize,
      fee,
      makerFeeEquivalent,
      estimatedMakerRebate,
      liquidity,
      side: "BUY",
      timestamp,
    };
    this.state.fills.push(fill);
    this.indexFill(fill);
    const position = (this.positionsByMarket.get(order.marketSlug) ?? []).find(
      (item) =>
        item.tokenId === order.tokenId,
    );
    if (position) {
      position.shares = round(position.shares + actualSize);
      position.totalCost = round(position.totalCost + cost);
    } else {
      const nextPosition: PaperPosition = {
        marketSlug: order.marketSlug,
        tokenId: order.tokenId,
        outcome: order.outcome,
        shares: actualSize,
        totalCost: cost,
      };
      this.state.positions.push(nextPosition);
      this.indexPosition(nextPosition);
    }
    if (unlimitedV14) {
      this.state.theoreticalCash = round(
        (this.state.theoreticalCash ?? this.state.startingBalance) - cost - fee,
      );
      this.state.grossCapitalDeployed = round(
        (this.state.grossCapitalDeployed ?? 0) + cost + fee,
      );
    } else {
      this.state.cash = round(this.state.cash - cost - fee);
    }
    order.remainingSize = round(order.remainingSize - actualSize);
    order.status =
      order.remainingSize <= 1e-8
        ? "filled"
        : order.remainingSize < order.originalSize
          ? "partial"
          : "open";
    this.refreshOpenOrder(order);
    this.fillsProcessed += 1;
    this.schedulePersist();
    this.record("fill", fill);
  }

  private applySellFill(
    order: PaperOrder,
    price: number,
    size: number,
    feeConfig: {
      rate: number;
      makerRate: number;
      exponent: number;
      rebateRate: number;
    },
    timestamp: string,
  ): void {
    const position = (this.positionsByMarket.get(order.marketSlug) ?? []).find(
      (candidate) =>
        candidate.tokenId === order.tokenId,
    );
    const actualSize = round(
      Math.min(size, order.remainingSize, position?.shares ?? 0),
    );
    if (actualSize <= 0 || !position) return;
    const kalshiFee = this.config.exchange === "kalshi"
      ? exactKalshiFee({
          price,
          size: actualSize,
          rate: feeConfig.rate,
          exponent: feeConfig.exponent,
          side: "SELL",
          accumulator: this.state.feeAccumulators?.[order.id] ?? 0,
        })
      : null;
    if (kalshiFee) {
      this.state.feeAccumulators ??= {};
      this.state.feeAccumulators[order.id] = kalshiFee.accumulator;
    }
    const fee = kalshiFee?.netFee ?? round(
      actualSize * feeConfig.rate * Math.pow(price * (1 - price), feeConfig.exponent),
      5,
    );
    const proceeds = round(actualSize * price - fee);
    const averageCost =
      position.shares > 0 ? position.totalCost / position.shares : 0;
    const fill: PaperFill = {
      id: `fill-${randomUUID()}`,
      orderId: order.id,
      marketSlug: order.marketSlug,
      tokenId: order.tokenId,
      outcome: order.outcome,
      price,
      size: actualSize,
      fee,
      liquidity: "taker",
      side: "SELL",
      timestamp,
    };
    this.state.fills.push(fill);
    this.indexFill(fill);
    position.shares = round(Math.max(0, position.shares - actualSize));
    position.totalCost = round(
      Math.max(0, position.totalCost - averageCost * actualSize),
    );
    if (order.pairId?.startsWith("ladder-v14:")) {
      this.state.theoreticalCash = round(
        (this.state.theoreticalCash ?? this.state.startingBalance) + proceeds,
      );
    } else {
      this.state.cash = round(this.state.cash + proceeds);
    }
    order.remainingSize = round(order.remainingSize - actualSize);
    order.status = order.remainingSize <= 1e-8 ? "filled" : "partial";
    this.refreshOpenOrder(order);
    this.fillsProcessed += 1;
    this.schedulePersist();
    this.record("fill", fill);
  }

  private handleStreamEvent(event: MarketStreamEvent): void {
    const eventType = String(event.event_type ?? "");
    if (eventType === "market_books") {
      const books = Array.isArray(event.books)
        ? (event.books as MarketStreamEvent[])
        : [];
      for (const book of books) this.handleBookEvent(book);
      for (const book of books) {
        const tokenId = String(book.asset_id ?? "");
        const marketSlug = this.tokenToMarket.get(tokenId);
        const context = marketSlug ? this.contexts.get(marketSlug) : undefined;
        if (context) {
          context.marketDataValid = true;
          context.streamBacked = true;
        }
      }
      return;
    }
    if (eventType === "market_books_invalid") {
      const tickers = Array.isArray(event.market_tickers)
        ? event.market_tickers.map(String)
        : [];
      for (const ticker of tickers) {
        const marketSlug = this.tokenToMarket.get(kalshiTokenId(ticker, "yes"));
        const context = marketSlug ? this.contexts.get(marketSlug) : undefined;
        if (context) context.marketDataValid = false;
      }
      return;
    }
    if (eventType === "book") {
      this.handleBookEvent(event);
      return;
    }
    if (eventType === "price_change") {
      this.handlePriceChanges(event);
      return;
    }
    if (eventType === "last_trade_price") {
      this.handleTradeEvent(event);
      return;
    }
  }

  private notifyExecutionWake(
    event: MarketStreamEvent,
  ): void {
    if (!this.executionWakeHandler) return;
    const tokenIds = new Set<string>();
    const direct = String(event.asset_id ?? "");
    if (direct) tokenIds.add(direct);
    if (Array.isArray(event.price_changes)) {
      for (const change of event.price_changes as PriceChange[]) {
        const tokenId = String(change.asset_id ?? "");
        if (tokenId) tokenIds.add(tokenId);
      }
    }
    if (Array.isArray(event.books)) {
      for (const book of event.books as MarketStreamEvent[]) {
        const tokenId = String(book.asset_id ?? "");
        if (tokenId) tokenIds.add(tokenId);
      }
    }
    const marketSlugs = new Set<string>();
    for (const tokenId of tokenIds) {
      const marketSlug = this.tokenToMarket.get(tokenId);
      if (marketSlug) marketSlugs.add(marketSlug);
    }
    for (const marketSlug of marketSlugs) {
      if (this.contexts.get(marketSlug)?.marketDataValid === false) continue;
      if (this.closing || this.settlementsByMarket.has(marketSlug)) continue;
      try {
        const wake = this.executionWakeHandler(marketSlug);
        if (wake) void wake.catch((error) => this.recordError("execution_wake", error));
      } catch (error) {
        this.recordError("execution_wake", error);
      }
    }
  }

  private releaseSettledMarket(marketSlug: string): void {
    const context = this.contexts.get(marketSlug);
    if (!context) return;
    const tokenIds = [...context.books.keys()];
    for (const tokenId of tokenIds) {
      if (this.tokenToMarket.get(tokenId) === marketSlug) this.tokenToMarket.delete(tokenId);
    }
    this.stream.unsubscribe?.(tokenIds);
    this.contexts.delete(marketSlug);
    this.fallbackChecks.delete(marketSlug);
    const timer = this.settlementTimers.get(marketSlug);
    if (timer) clearTimeout(timer);
    this.settlementTimers.delete(marketSlug);
    this.feeConfigs.delete(context.event.market.conditionId);
    this.loggedFeeMarkets.delete(marketSlug);
    this.reportStateByMarket.delete(marketSlug);
  }

  private handleBookEvent(event: MarketStreamEvent): void {
    const tokenId = String(event.asset_id ?? "");
    const marketSlug = this.tokenToMarket.get(tokenId);
    const context = marketSlug ? this.contexts.get(marketSlug) : undefined;
    if (!context) return;
    const asks = parseLevels(event.asks, true);
    const bids = parseLevels(event.bids, false);
    const previous = context.books.get(tokenId);
    if (previous) {
      previous.asks = asks;
      previous.bids = bids;
      previous.bestAsk = asks[0]?.price ?? null;
      previous.bestBid = bids[0]?.price ?? null;
      previous.timestamp = String(event.timestamp ?? Date.now());
    }
    context.liquidity.set(tokenId, asks.map((level) => ({ ...level })));
  }

  private handlePriceChanges(event: MarketStreamEvent): void {
    const changes = Array.isArray(event.price_changes)
      ? (event.price_changes as PriceChange[])
      : [];
    for (const change of changes) {
      const tokenId = String(change.asset_id ?? event.asset_id ?? "");
      const marketSlug = this.tokenToMarket.get(tokenId);
      const context = marketSlug ? this.contexts.get(marketSlug) : undefined;
      if (!context) continue;
      const price = parseNumber(change.price);
      const size = parseNumber(change.size);
      if (price === null || size === null) continue;
      const side = String(change.side ?? "").toUpperCase();
      const book = context.books.get(tokenId);
      if (!book) continue;
      const levels = side === "BUY" ? book.bids : book.asks;
      const index = levels.findIndex(
        (level) => Math.abs(level.price - price) < 1e-9,
      );
      if (size <= 0 && index >= 0) levels.splice(index, 1);
      else if (index >= 0) levels[index] = { price, size };
      else if (size > 0) levels.push({ price, size });
      levels.sort((left, right) =>
        side === "BUY"
          ? right.price - left.price
          : left.price - right.price,
      );
      book.bestBid = book.bids[0]?.price ?? null;
      book.bestAsk = book.asks[0]?.price ?? null;
      if (side !== "BUY") {
        context.liquidity.set(
          tokenId,
          book.asks.map((level) => ({ ...level })),
        );
      }
    }
  }

  private handleTradeEvent(event: MarketStreamEvent): void {
    const tokenId = String(event.asset_id ?? "");
    const side = String(event.side ?? "").toUpperCase();
    const price = parseNumber(event.price);
    const size = parseNumber(event.size);
    if (!tokenId || side !== "SELL" || price === null || size === null) return;
    const atMs = marketEventTimestampMs(event) ?? Date.now();

    const marketSlug = this.tokenToMarket.get(tokenId);
    const orders = (marketSlug ? this.ordersByMarket.get(marketSlug) : undefined)
      ?.filter(
        (order) =>
          order.tokenId === tokenId &&
          (order.status === "open" || order.status === "partial") &&
          order.limitPrice + 1e-9 >= price &&
          atMs + 1e-6 >= Date.parse(order.createdAt),
      )
      .sort(
        (left, right) =>
          right.limitPrice - left.limitPrice ||
          left.createdAt.localeCompare(right.createdAt),
      ) ?? [];
    // With no eligible resting paper order, this trade is telemetry only. It
    // must not serialize and rewrite the entire historical execution ledger.
    if (orders.length === 0) return;

    const eventKey = [
      tokenId,
      event.timestamp ?? "",
      price,
      size,
      side,
      event.transaction_hash ?? "",
    ].join(":");
    if (this.seenEvents.has(eventKey)) return;
    this.seenEvents.add(eventKey);
    if (this.seenEvents.size > 2_000) {
      const oldest = this.seenEvents.values().next().value as string | undefined;
      if (oldest) this.seenEvents.delete(oldest);
    }

    let remainingTradeSize = size;
    for (const order of orders) {
      if (remainingTradeSize <= 1e-8) break;
      const queueConsumed = Math.min(order.queueAhead, remainingTradeSize);
      order.queueAhead = round(order.queueAhead - queueConsumed);
      remainingTradeSize = round(remainingTradeSize - queueConsumed);
      if (remainingTradeSize <= 1e-8) continue;
      const fillSize = Math.min(order.remainingSize, remainingTradeSize);
      this.applyFill(
        order,
        order.limitPrice,
        fillSize,
        "maker",
        this.feeConfigs.get(order.conditionId) ??
          this.feeConfig(
            this.contexts.get(order.marketSlug)?.event.market ?? {
              question: order.marketTitle,
              conditionId: order.conditionId,
              slug: order.marketSlug,
              clobTokenIds: "[]",
              outcomes: "[]",
              negRisk: false,
              orderPriceMinTickSize: 0.01,
              active: true,
              closed: false,
            },
          ),
        new Date(atMs).toISOString(),
      );
      remainingTradeSize = round(remainingTradeSize - fillSize);
    }
    this.schedulePersist();
  }

  private async checkSettlement(event: UpDownEvent): Promise<void> {
    if (this.closing || this.settlementsByMarket.has(event.slug)) {
      return;
    }
    const lastCheck = this.fallbackChecks.get(event.slug) ?? 0;
    if (Date.now() - lastCheck < 30_000 || !event.market.id) return;
    this.fallbackChecks.set(event.slug, Date.now());

    try {
      if (this.options.settlementLoader) {
        const result = await this.options.settlementLoader(event);
        if (result && !this.closing) await this.settleWinningToken(result.winningTokenId);
        return;
      }
      if (this.config.exchange === "kalshi" && this.kalshiClient) {
        const ticker = event.market.externalMarketId ?? event.market.id;
        if (!ticker) return;
        const market = await this.kalshiClient.getMarket(ticker);
        if (
          this.closing ||
          !market ||
          (market.status !== "finalized" && market.status !== "settled") ||
          (market.result !== "yes" && market.result !== "no")
        ) {
          return;
        }
        await this.settleWinningToken(kalshiTokenId(ticker, market.result));
        return;
      }
      const url = new URL(
        `/markets/${encodeURIComponent(event.market.id)}`,
        this.config.gammaApiHost,
      );
      const response = await fetch(url);
      if (!response.ok) return;
      const market = (await response.json()) as GammaMarket;
      if (this.closing || !market.closed || !market.outcomePrices) return;
      const prices = JSON.parse(market.outcomePrices) as string[];
      const tokenIds = JSON.parse(market.clobTokenIds) as string[];
      const winningIndex = prices.findIndex((price) => Number(price) >= 0.999);
      const winningTokenId = tokenIds[winningIndex];
      if (winningTokenId) await this.settleWinningToken(winningTokenId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logThrottled("Paper settlement check failed", event.slug, {
        exchange: this.config.exchange,
        market: event.slug,
        error: message,
      });
    }
  }

  private scheduleSettlementFallback(event: UpDownEvent): void {
    if (
      this.closing ||
      this.settlementTimers.has(event.slug) ||
      this.settlementsByMarket.has(event.slug)
    ) {
      return;
    }
    const firstDelay = Math.max(0, event.windowEnd * 1000 - Date.now() + 2_000);
    const schedule = (delay: number): void => {
      const timer = setTimeout(() => {
        void this.checkSettlement(event).finally(() => {
          if (
            !this.closing && !this.settlementsByMarket.has(event.slug)
          ) {
            schedule(30_000);
          } else {
            this.settlementTimers.delete(event.slug);
          }
        });
      }, Math.min(delay, 2_147_483_647));
      this.settlementTimers.set(event.slug, timer);
    };
    schedule(firstDelay);
  }

  private async loadFeeConfig(event: UpDownEvent): Promise<void> {
    if (this.feeConfigs.has(event.market.conditionId)) return;
    try {
      if (this.options.feeLoader) {
        const loaded = await this.options.feeLoader(event.market.conditionId);
        this.feeConfigs.set(event.market.conditionId, {
          ...loaded,
          makerRate:
            loaded.makerRate ?? event.market.feeSchedule?.makerRate ?? 0,
          rebateRate: normalizeRebateRate(
            loaded.rebateRate ?? event.market.feeSchedule?.rebateRate,
            event.market.feeSchedule?.rebateRate ??
              (event.slug.startsWith("btc-updown-15m") ? 0.2 : 0),
          ),
        });
        return;
      }
      if (this.config.exchange === "kalshi") {
        this.feeConfigs.set(event.market.conditionId, {
          rate:
            event.market.feeSchedule?.rate ??
            this.config.kalshiTakerFeeRate,
          makerRate:
            event.market.feeSchedule?.makerRate ??
            this.config.kalshiMakerFeeRate,
          exponent: event.market.feeSchedule?.exponent ?? 1,
          rebateRate: 0,
        });
        return;
      }
      if (!this.publicClient) {
        throw new Error("Polymarket public client is not initialized");
      }
      const details = await this.publicClient.getClobMarketInfo(
        event.market.conditionId,
      );
      const rawRate = details.fd?.r ?? 0;
      this.feeConfigs.set(event.market.conditionId, {
        rate: rawRate > 1 ? rawRate / 10_000 : rawRate,
        makerRate: 0,
        exponent: details.fd?.e ?? 1,
        rebateRate: normalizeRebateRate(
          event.market.feeSchedule?.rebateRate,
          event.slug.startsWith("btc-updown-15m") ? 0.2 : 0,
        ),
      });
    } catch (error) {
      const fallback = event.slug.startsWith("btc-updown-15m") ? 0.07 : 0;
      this.feeConfigs.set(event.market.conditionId, {
        rate: fallback,
        makerRate:
          this.config.exchange === "kalshi"
            ? this.config.kalshiMakerFeeRate
            : 0,
        exponent: 1,
        rebateRate: event.slug.startsWith("btc-updown-15m") ? 0.2 : 0,
      });
      const message = error instanceof Error ? error.message : String(error);
      log("Paper fee lookup failed; using category fallback", {
        market: event.slug,
        fallbackRate: fallback,
        error: message,
      });
    }
  }

  private settleWinningToken(winningTokenId: string): Promise<void> {
    const settlement = this.settleMarket(winningTokenId);
    this.pendingSettlements.add(settlement);
    const cleanup = () => { this.pendingSettlements.delete(settlement); };
    void settlement.then(cleanup, cleanup);
    return settlement;
  }

  private async settleMarket(winningTokenId: string): Promise<void> {
    const marketSlug = this.tokenToMarket.get(winningTokenId);
    if (!marketSlug) return;
    if (this.settlementsByMarket.has(marketSlug)) {
      return;
    }
    const marketFills = this.fillsByMarket.get(marketSlug) ?? [];
    const winningFills = marketFills.filter(
      (fill) => fill.tokenId === winningTokenId,
    );
    const payout = round(
      winningFills.reduce(
        (sum, fill) =>
          sum + (fill.side === "SELL" ? -fill.size : fill.size),
        0,
      ),
    );
    const totalCost = round(
      marketFills.reduce(
        (sum, fill) =>
          sum +
          (fill.side === "SELL"
            ? -fill.price * fill.size
            : fill.price * fill.size),
        0,
      ),
    );
    const totalFees = round(
      marketFills.reduce((sum, fill) => sum + fill.fee, 0),
    );
    const estimatedMakerRebate = round(
      marketFills.reduce(
        (sum, fill) => sum + (fill.estimatedMakerRebate ?? 0),
        0,
      ),
    );
    const winningOutcome =
      winningFills[0]?.outcome ??
      this.contexts
        .get(marketSlug)
        ?.books.get(winningTokenId)?.outcome ??
      "Unknown";
    const settlement: PaperSettlement = {
      marketSlug,
      winningTokenId,
      winningOutcome,
      payout,
      totalCost,
      totalFees,
      estimatedMakerRebate,
      adjustedPnl: round(
        payout - totalCost - totalFees + estimatedMakerRebate,
      ),
      realizedPnl: round(payout - totalCost - totalFees),
      settledAt: new Date().toISOString(),
    };
    this.state.settlements.push(settlement);
    this.settlementsByMarket.set(marketSlug, settlement);
    const v14Market = (this.ordersByMarket.get(marketSlug) ?? []).some(
      (order) => order.pairId?.startsWith("ladder-v14:"),
    );
    if (v14Market) {
      this.state.theoreticalCash = round(
        (this.state.theoreticalCash ?? this.state.startingBalance) + payout,
      );
    } else {
      this.state.cash = round(this.state.cash + payout);
    }
    for (const order of this.ordersByMarket.get(marketSlug) ?? []) {
      if (order.status === "open" || order.status === "partial") {
        order.status = "cancelled";
        this.refreshOpenOrder(order);
        this.record("order_cancelled", order);
      }
    }
    this.record("settlement", settlement);
    this.schedulePersist();
    await this.eventLog?.flush();
    await this.persist();
    try {
      // History learners must see the fills before the active ledger is pruned.
      await this.settlementHandler?.(settlement);
    } finally {
      this.pruneSettledState(new Set([marketSlug]));
      this.releaseSettledMarket(marketSlug);
      await this.persist();
    }
  }

  private record(
    type: string,
    payload: PaperOrder | PaperFill | PaperSettlement | Record<string, unknown>,
  ): void {
    this.eventLog?.write({ type, timestamp: new Date().toISOString(), payload });
  }

  private recordError(operation: string, error: unknown): void {
    const payload = { operation, error: error instanceof Error ? error.message : String(error) };
    this.record("error", payload);
    log("Paper trader error", payload);
  }

  private recordHealth(): void {
    this.record("health", {
      processingLagMs: this.processingLagMs,
      averageLag: this.lagCount ? round(this.lagTotal / this.lagCount, 3) : 0,
      maxLag: this.lagMax,
      openOrders: this.openOrders.size,
      fillsProcessed: this.fillsProcessed,
      eventsProcessed: this.eventsProcessed,
      staleEventsSkipped: this.staleEventsSkipped,
      logQueueSize: this.eventLog?.queueSize ?? 0,
      stateDirty: this.stateDirty,
    });
    this.lagTotal = 0;
    this.lagCount = 0;
    this.lagMax = 0;
  }

  private pruneSettledState(
    settled = new Set(this.state.settlements.map((item) => item.marketSlug)),
  ): boolean {
    const removedOrders = this.state.orders.filter((order) => settled.has(order.marketSlug));
    const removedTokens = new Set(this.state.positions
      .filter((position) => settled.has(position.marketSlug)).map((position) => position.tokenId));
    const oldSize = this.state.orders.length + this.state.fills.length + this.state.positions.length;
    this.state.orders = this.state.orders.filter((order) => !settled.has(order.marketSlug));
    this.state.fills = this.state.fills.filter((fill) => !settled.has(fill.marketSlug));
    this.state.positions = this.state.positions.filter((position) => !settled.has(position.marketSlug));
    for (const order of removedOrders) {
      removedTokens.add(order.tokenId);
      this.openOrders.delete(order);
      this.orderById.delete(order.id);
      this.orderByTradeKey.delete(order.tradeKey);
      if (this.state.feeAccumulators) delete this.state.feeAccumulators[order.id];
    }
    for (const slug of settled) {
      this.ordersByMarket.delete(slug);
      this.fillsByMarket.delete(slug);
      this.positionsByMarket.delete(slug);
    }
    for (const key of this.seenEvents) {
      if ([...removedTokens].some((token) => key.startsWith(`${token}:`))) this.seenEvents.delete(key);
    }
    const changed = oldSize !== this.state.orders.length + this.state.fills.length + this.state.positions.length;
    if (changed) this.schedulePersist();
    return changed;
  }

  private derivePositions(fills: PaperFill[]): PaperPosition[] {
    const positions = new Map<string, PaperPosition>();
    for (const fill of fills) {
      const key = `${fill.marketSlug}:${fill.tokenId}`;
      const position = positions.get(key) ?? {
        marketSlug: fill.marketSlug,
        tokenId: fill.tokenId,
        outcome: fill.outcome,
        shares: 0,
        totalCost: 0,
      };
      if (fill.side === "SELL") {
        const averageCost =
          position.shares > 0 ? position.totalCost / position.shares : 0;
        position.shares = round(Math.max(0, position.shares - fill.size));
        position.totalCost = round(
          Math.max(0, position.totalCost - averageCost * fill.size),
        );
      } else {
        position.shares = round(position.shares + fill.size);
        position.totalCost = round(position.totalCost + fill.price * fill.size);
      }
      positions.set(key, position);
    }
    return [...positions.values()];
  }

  private rebuildStateIndexes(): void {
    this.ordersByMarket.clear();
    this.fillsByMarket.clear();
    this.positionsByMarket.clear();
    this.settlementsByMarket.clear();
    this.orderByTradeKey.clear();
    this.orderById.clear();
    this.openOrders.clear();
    for (const order of this.state.orders) this.indexOrder(order);
    for (const fill of this.state.fills) this.indexFill(fill);
    for (const position of this.state.positions) this.indexPosition(position);
    for (const settlement of this.state.settlements) {
      this.settlementsByMarket.set(settlement.marketSlug, settlement);
    }
  }

  private indexOrder(order: PaperOrder): void {
    const orders = this.ordersByMarket.get(order.marketSlug) ?? [];
    orders.push(order);
    this.ordersByMarket.set(order.marketSlug, orders);
    this.orderByTradeKey.set(order.tradeKey, order);
    this.orderById.set(order.id, order);
    this.refreshOpenOrder(order);
  }

  private indexFill(fill: PaperFill): void {
    const fills = this.fillsByMarket.get(fill.marketSlug) ?? [];
    fills.push(fill);
    this.fillsByMarket.set(fill.marketSlug, fills);
  }

  private indexPosition(position: PaperPosition): void {
    const positions = this.positionsByMarket.get(position.marketSlug) ?? [];
    positions.push(position);
    this.positionsByMarket.set(position.marketSlug, positions);
  }

  private refreshOpenOrder(order: PaperOrder): void {
    if (order.status === "open" || order.status === "partial") {
      this.openOrders.add(order);
    } else {
      this.openOrders.delete(order);
    }
  }

  private schedulePersist(): void {
    this.stateDirty = true;
    this.stateRevision += 1;
  }

  private persist(): Promise<void> {
    this.checkpointsPending += 1;
    const checkpoint = this.persistenceQueue.then(async () => {
      const revision = this.stateRevision;
      this.state.seenEventKeys = [...this.seenEvents];
      await this.writeCheckpoint(JSON.stringify(this.state));
      // A fill arriving during the write belongs to the next checkpoint.
      if (revision === this.stateRevision) this.stateDirty = false;
    }).catch((error) => {
      this.stateDirty = true;
      throw error;
    }).finally(() => { this.checkpointsPending -= 1; });
    // A failed checkpoint must not poison every subsequent save.
    this.persistenceQueue = checkpoint.catch(() => undefined);
    return checkpoint;
  }

  private async writeCheckpoint(serialized: string): Promise<void> {
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, serialized, "utf8");
    try {
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await writeFile(this.statePath, serialized, "utf8");
      await rm(temporaryPath, { force: true });
    }
  }
}
