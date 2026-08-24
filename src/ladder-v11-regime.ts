import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig } from "./config.js";
import {
  favoriteTierForScore,
  scoreOscillation,
  type BookSample,
  type OscillationFeatures,
  type OscillationRawFeatures,
} from "./ladder-v10-regime.js";
import {
  LADDER_V11_CHEAP_PRICE,
  LADDER_V11_FAVORITE_MAX_PRICE,
  LADDER_V11_SIZE,
} from "./ladder-v11.js";
import { log } from "./logger.js";
import {
  KalshiBrtiProvider,
  type RegimePricePoint,
  type RegimePriceProvider,
} from "./regime-price-stream.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  PaperSettlement,
  TokenBook,
  UpDownEvent,
} from "./types.js";
import { appendRotatingJsonLine } from "./utils/rotating-jsonl.js";

const EPSILON = 1e-9;
const V11_PREFIX = "ladder-v11:";
const STATE_VERSION = 1;
const FEATURE_VERSION = "v10-heuristic-1";
export const LADDER_V11_MAX_REVERSALS = 0.1;
export const LADDER_V11_MAX_STORED_DECISION_AGE_MS = 1_000;
const LADDER_V11_BRTI_STALE_MS = 2_000;

export type LadderV11RejectionReason =
  | "NO_BRTI"
  | "INVALID_BRTI"
  | "REVERSALS_TOO_HIGH"
  | "FAVORITE_BELOW_FLOOR"
  | "FAVORITE_ABOVE_CAP"
  | "FAVORITE_CHANGED"
  | "INVALID_MARKET_BOOK"
  | "MARKET_ALREADY_TOO_LATE"
  | "MARKET_TOO_EARLY";

export interface ReversalThresholdTelemetry {
  rev05: boolean;
  rev10: boolean;
  rev15: boolean;
  rev20: boolean;
}

export interface CounterfactualFill {
  size: number;
  cost: number;
  fee: number;
}

export interface LadderV11DecisionSnapshot {
  marketSlug: string;
  decisionTimestamp: string;
  decisionTimestampMs: number;
  source: "brti" | "none";
  scoreInputsValid: boolean;
  v10Score: number | null;
  features: OscillationFeatures | null;
  rawFeatures: OscillationRawFeatures | null;
  brtiTimestamp: string | null;
  brtiTimestampMs: number | null;
  brtiAgeMs: number | null;
  cheapTokenId: string;
  cheapOutcome: string;
  cheapPrice: number | null;
  favoriteTokenId: string;
  favoriteOutcome: string;
  favoritePrice: number | null;
  eligible: boolean;
  decision: "FULL_TRADE" | "NO_TRADE";
  reason: "ELIGIBLE" | LadderV11RejectionReason;
  reversalThresholds: ReversalThresholdTelemetry;
  shadowV7Favorite: CounterfactualFill;
  shadowV10TargetShares: number;
  shadowV10Favorite: CounterfactualFill;
}

interface CheapShadowTracking {
  eligible: boolean;
  crossed: boolean;
  queueCleared: boolean;
  touched: boolean;
  queueAhead: number;
  volumeAtRung: number;
  tradeKeys: string[];
  makerFeeRate: number;
  feeExponent: number;
}

export interface LadderV11DecisionRecord {
  marketSlug: string;
  initialDecision: LadderV11DecisionSnapshot;
  finalDecision: LadderV11DecisionSnapshot;
  initialDecisionAt: string;
  finalDecisionAt: string;
  cheapOrderSubmittedAt?: string;
  orderSubmittedAt?: string;
  initialDecisionAgeMs: number;
  decisionAgeMs: number | null;
  staleDecisionRecalculated: boolean;
  executionRevalidated: boolean;
  initialFavorite: string;
  finalFavorite: string;
  initialFavoritePrice: number | null;
  finalFavoritePrice: number | null;
  reversalsAtInitial: number | null;
  reversalsAtExecution: number | null;
  qualified: boolean;
  observedFills: PaperFill[];
  favoriteFillBelow50Count: number;
  nonBrtiExecutionCount: number;
  cheapShadow: CheapShadowTracking;
  actualPnl?: number;
  counterfactualV7Pnl?: number;
  counterfactualV10Pnl?: number;
  winningTokenId?: string;
  settledAt?: string;
}

export interface LadderV11State {
  version: typeof STATE_VERSION;
  featureVersion: typeof FEATURE_VERSION;
  pairHistory: Array<{ marketSlug: string; paired: boolean }>;
  decisions: Record<string, LadderV11DecisionRecord>;
}

interface MarketContext {
  event: UpDownEvent;
  books: TokenBook[];
  bookSamples: BookSample[];
  lastSnapshotSecond: number;
  lastBidDepth: number | null;
  lastAskDepth: number | null;
  pendingTradeFlow: number;
  latestSnapshot: MarketExecutionSnapshot | null;
}

export interface LadderV11RegimeOptions {
  providers?: RegimePriceProvider[];
  now?: () => number;
}

function emptyState(): LadderV11State {
  return {
    version: STATE_VERSION,
    featureVersion: FEATURE_VERSION,
    pairHistory: [],
    decisions: {},
  };
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function cloneBooks(books: readonly TokenBook[]): TokenBook[] {
  return books.map((book) => ({
    ...book,
    bids: book.bids.map((level) => ({ ...level })),
    asks: book.asks.map((level) => ({ ...level })),
  }));
}

function rankBooks(books: readonly TokenBook[]): {
  cheap: TokenBook;
  favorite: TokenBook;
} | null {
  const complete = books.filter((book) => book.bestAsk !== null);
  if (complete.length !== 2) return null;
  const ranked = [...complete].sort(
    (left, right) =>
      (left.bestAsk ?? 1) - (right.bestAsk ?? 1) ||
      left.outcomeIndex - right.outcomeIndex,
  );
  return ranked[0] && ranked[1]
    ? { cheap: ranked[0], favorite: ranked[1] }
    : null;
}

function topDepth(levels: TokenBook["bids"], best: number | null): number {
  if (best === null) return 0;
  return levels
    .filter((level) => Math.abs(level.price - best) <= 0.05 + EPSILON)
    .reduce((sum, level) => sum + level.size, 0);
}

function queueAt(book: TokenBook, price: number): number {
  return book.bids
    .filter((level) => Math.abs(level.price - price) <= EPSILON)
    .reduce((sum, level) => sum + level.size, 0);
}

function simulateFavorite(
  favorite: TokenBook,
  shares: number,
  snapshot: MarketExecutionSnapshot,
): CounterfactualFill {
  let remaining = shares;
  let size = 0;
  let cost = 0;
  let fee = 0;
  for (const level of favorite.asks) {
    if (
      level.price > LADDER_V11_FAVORITE_MAX_PRICE + EPSILON ||
      remaining <= EPSILON
    ) {
      break;
    }
    const selected = Math.min(remaining, level.size);
    size += selected;
    cost += selected * level.price;
    fee +=
      selected *
      snapshot.takerFeeRate *
      Math.pow(level.price * (1 - level.price), snapshot.takerFeeExponent);
    remaining -= selected;
  }
  return { size: round(size), cost: round(cost), fee: round(fee) };
}

function emptyFill(): CounterfactualFill {
  return { size: 0, cost: 0, fee: 0 };
}

function thresholds(reversals: number | null): ReversalThresholdTelemetry {
  return {
    rev05: reversals !== null && reversals <= 0.05 + EPSILON,
    rev10: reversals !== null && reversals <= 0.1 + EPSILON,
    rev15: reversals !== null && reversals <= 0.15 + EPSILON,
    rev20: reversals !== null && reversals <= 0.2 + EPSILON,
  };
}

function isV11Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V11_PREFIX) ?? false;
}

function orderRole(order: PaperOrder): string {
  return isV11Order(order) ? (order.pairId ?? "").slice(V11_PREFIX.length) : "";
}

function cheapShadowFor(
  book: TokenBook | null,
  snapshot: MarketExecutionSnapshot,
): CheapShadowTracking {
  return {
    eligible:
      book?.bestAsk !== null &&
      book?.bestAsk !== undefined &&
      LADDER_V11_CHEAP_PRICE + EPSILON < book.bestAsk,
    crossed: false,
    queueCleared: false,
    touched: false,
    queueAhead: book ? queueAt(book, LADDER_V11_CHEAP_PRICE) : 0,
    volumeAtRung: 0,
    tradeKeys: [],
    makerFeeRate: snapshot.makerFeeRate ?? 0,
    feeExponent: snapshot.takerFeeExponent,
  };
}

function actualCheapFill(record: LadderV11DecisionRecord): CounterfactualFill {
  const fills = record.observedFills.filter(
    (fill) => fill.tokenId === record.initialDecision.cheapTokenId,
  );
  return {
    size: round(fills.reduce((sum, fill) => sum + fill.size, 0)),
    cost: round(
      fills.reduce((sum, fill) => sum + fill.price * fill.size, 0),
    ),
    fee: round(fills.reduce((sum, fill) => sum + fill.fee, 0)),
  };
}

function shadowCheapFill(record: LadderV11DecisionRecord): CounterfactualFill {
  const actual =
    record.initialDecision.cheapTokenId === record.finalDecision.cheapTokenId
      ? actualCheapFill(record)
      : emptyFill();
  if (actual.size > EPSILON) return actual;
  const tracking = record.cheapShadow;
  if (!tracking.eligible || (!tracking.crossed && !tracking.queueCleared)) {
    return emptyFill();
  }
  return {
    size: LADDER_V11_SIZE,
    cost: LADDER_V11_SIZE * LADDER_V11_CHEAP_PRICE,
    fee: round(
      LADDER_V11_SIZE *
        tracking.makerFeeRate *
        Math.pow(
          LADDER_V11_CHEAP_PRICE * (1 - LADDER_V11_CHEAP_PRICE),
          tracking.feeExponent,
        ),
    ),
  };
}

function shadowPnl(
  winningTokenId: string,
  cheapTokenId: string,
  favoriteTokenId: string,
  cheap: CounterfactualFill,
  favorite: CounterfactualFill,
): number {
  const payout =
    (winningTokenId === cheapTokenId ? cheap.size : 0) +
    (winningTokenId === favoriteTokenId ? favorite.size : 0);
  return round(payout - cheap.cost - cheap.fee - favorite.cost - favorite.fee);
}

export class LadderV11RegimeEngine {
  private state = emptyState();
  private readonly statePath: string;
  private readonly eventLogPath: string;
  private readonly contexts = new Map<string, MarketContext>();
  private readonly tickerToSlug = new Map<string, string>();
  private readonly brtiPoints: RegimePricePoint[] = [];
  private readonly providers: RegimePriceProvider[];
  private readonly now: () => number;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private eventLogQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: BotConfig,
    options: LadderV11RegimeOptions = {},
  ) {
    this.statePath = join(config.paperStatePath, "ladder-v11-regime-state.json");
    this.eventLogPath = join(config.paperStatePath, "ladder-v11-events.jsonl");
    // V11 intentionally starts only the official BRTI provider. There is no
    // Coinbase or Kalshi-proxy provider in this engine.
    this.providers = options.providers ?? [new KalshiBrtiProvider(config)];
    this.now = options.now ?? (() => Date.now());
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as LadderV11State;
      if (
        parsed.version !== STATE_VERSION ||
        parsed.featureVersion !== FEATURE_VERSION
      ) {
        throw new Error("Unsupported Ladder V11 regime state");
      }
      this.state = parsed;
      for (const record of Object.values(this.state.decisions)) {
        record.executionRevalidated ??= false;
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") throw error;
      await this.persist();
    }
    for (const provider of this.providers) {
      if (provider.source !== "brti") {
        throw new Error("ladder_v11 only permits a BRTI price provider");
      }
      provider.start((point) => this.addPoint(point));
    }
  }

  async close(): Promise<void> {
    for (const provider of this.providers) provider.close();
    await this.persistenceQueue;
    await this.eventLogQueue;
  }

  registerMarket(event: UpDownEvent, books: readonly TokenBook[]): boolean {
    const nowMs = this.now();
    if (event.windowEnd <= nowMs / 1_000) return false;
    const existing = this.contexts.get(event.slug);
    if (existing) {
      existing.event = event;
      existing.books = cloneBooks(books);
    } else {
      this.contexts.set(event.slug, {
        event,
        books: cloneBooks(books),
        bookSamples: [],
        lastSnapshotSecond: -1,
        lastBidDepth: null,
        lastAskDepth: null,
        pendingTradeFlow: 0,
        latestSnapshot: null,
      });
    }
    const ticker = event.market.externalMarketId ?? event.market.id;
    if (ticker) this.tickerToSlug.set(ticker, event.slug);
    while (this.contexts.size > 2) {
      const oldest = [...this.contexts.values()].sort(
        (left, right) => left.event.windowEnd - right.event.windowEnd,
      )[0];
      if (!oldest) break;
      this.removeContext(oldest);
    }
    return true;
  }

  ingestTelemetry(event: Record<string, unknown>): void {
    const ticker = String(event.market_ticker ?? "");
    let slug = ticker ? this.tickerToSlug.get(ticker) : undefined;
    if (!slug && event.asset_id) {
      const tokenId = String(event.asset_id);
      slug = [...this.contexts].find(([, context]) =>
        context.books.some((book) => book.tokenId === tokenId),
      )?.[0];
    }
    const context = slug ? this.contexts.get(slug) : undefined;
    if (!context || event.event_type !== "last_trade_price") return;
    const size = Number(event.size);
    const price = Number(event.price);
    const tokenId = String(event.asset_id ?? "");
    const up = context.books.find((book) => book.outcome.toLowerCase() === "up");
    if (Number.isFinite(size)) {
      context.pendingTradeFlow += tokenId === up?.tokenId ? size : -size;
    }

    const record = this.state.decisions[context.event.slug];
    if (
      !record ||
      tokenId !== record.finalDecision.cheapTokenId ||
      !Number.isFinite(price) ||
      !Number.isFinite(size) ||
      size <= 0
    ) {
      return;
    }
    const tracking = record.cheapShadow;
    const tradeKey = [
      event.transaction_hash ?? "",
      event.timestamp ?? "",
      tokenId,
      price,
      size,
    ].join(":");
    if (tracking.tradeKeys.includes(tradeKey)) return;
    tracking.tradeKeys.push(tradeKey);
    tracking.tradeKeys = tracking.tradeKeys.slice(-256);
    if (price < LADDER_V11_CHEAP_PRICE - EPSILON) {
      tracking.touched = true;
      tracking.crossed = true;
    } else if (Math.abs(price - LADDER_V11_CHEAP_PRICE) <= EPSILON) {
      tracking.touched = true;
      tracking.volumeAtRung = round(tracking.volumeAtRung + size);
      if (
        tracking.volumeAtRung + EPSILON >=
        tracking.queueAhead + LADDER_V11_SIZE
      ) {
        tracking.queueCleared = true;
      }
    }
  }

  async sampleAll(
    snapshotFor: (marketSlug: string) => MarketExecutionSnapshot | null,
    nowMs = this.now(),
  ): Promise<void> {
    for (const context of this.contexts.values()) {
      if (nowMs / 1_000 > context.event.windowEnd) {
        this.removeContext(context);
        continue;
      }
      const snapshot = snapshotFor(context.event.slug);
      if (snapshot) await this.observeExecution(context.event, snapshot);
      this.sampleContext(context, nowMs);
    }
  }

  async evaluate(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    finalForExecution = false,
    nowMs = this.now(),
  ): Promise<LadderV11DecisionSnapshot> {
    this.registerMarket(event, snapshot.books);
    const context = this.contexts.get(event.slug);
    if (context) {
      context.latestSnapshot = snapshot;
      this.sampleContext(context, nowMs);
    }
    const existing = this.state.decisions[event.slug];
    // A normal execution wake never needs to recalculate a frozen decision.
    // The finalForExecution path intentionally bypasses this shortcut.
    if (existing && !finalForExecution) return existing.initialDecision;
    const result = this.calculateDecision(event, snapshot, nowMs);
    // Accumulate BRTI/book history before five minutes without freezing a
    // trade decision. The first persisted decision is the actual entry gate.
    if (!existing && result.reason === "MARKET_TOO_EARLY") return result;
    if (!existing) {
      const ranked = rankBooks(snapshot.books);
      const record: LadderV11DecisionRecord = {
        marketSlug: event.slug,
        initialDecision: result,
        finalDecision: result,
        initialDecisionAt: result.decisionTimestamp,
        finalDecisionAt: result.decisionTimestamp,
        initialDecisionAgeMs: 0,
        decisionAgeMs: null,
        staleDecisionRecalculated: false,
        executionRevalidated: false,
        initialFavorite: result.favoriteOutcome,
        finalFavorite: result.favoriteOutcome,
        initialFavoritePrice: result.favoritePrice,
        finalFavoritePrice: result.favoritePrice,
        reversalsAtInitial: result.features?.reversals ?? null,
        reversalsAtExecution: result.features?.reversals ?? null,
        qualified: false,
        observedFills: [],
        favoriteFillBelow50Count: 0,
        nonBrtiExecutionCount: 0,
        cheapShadow: cheapShadowFor(ranked?.cheap ?? null, snapshot),
      };
      this.state.decisions[event.slug] = record;
      await this.persist();
      await this.logDecision(result, finalForExecution ? "final" : "initial");
      return result;
    }

    if (finalForExecution) {
      const age = Math.max(0, nowMs - existing.initialDecision.decisionTimestampMs);
      let final = result;
      // A flipped market makes the already-resting cheap order the same token
      // as the new favorite. V11 aborts instead of creating one-sided size.
      if (
        result.eligible &&
        result.favoriteTokenId !== existing.initialDecision.favoriteTokenId
      ) {
        final = {
          ...result,
          eligible: false,
          decision: "NO_TRADE",
          reason: "FAVORITE_CHANGED",
        };
      }
      existing.finalDecision = final;
      existing.executionRevalidated = true;
      existing.finalDecisionAt = final.decisionTimestamp;
      existing.initialDecisionAgeMs = age;
      existing.staleDecisionRecalculated ||= age > LADDER_V11_MAX_STORED_DECISION_AGE_MS;
      existing.finalFavorite = final.favoriteOutcome;
      existing.finalFavoritePrice = final.favoritePrice;
      existing.reversalsAtExecution = final.features?.reversals ?? null;
      if (age > LADDER_V11_MAX_STORED_DECISION_AGE_MS) {
        await this.appendEventLog({
          event: "decision_recalculated",
          strategy: "ladder-v11",
          market: event.slug,
          decision: final.decision,
          reason: "STALE_DECISION_RECALCULATED",
          storedDecisionAgeMs: age,
        });
      }
      await this.persist();
      await this.logDecision(final, "final");
      return final;
    }
    return existing.initialDecision;
  }

  async recordOrderSubmitted(
    marketSlug: string,
    role: "cheap-maker" | "favorite-initial",
    decision: LadderV11DecisionSnapshot,
    submittedAtMs = this.now(),
  ): Promise<void> {
    const record = this.state.decisions[marketSlug];
    if (!record) return;
    const submittedAt = new Date(submittedAtMs).toISOString();
    if (role === "cheap-maker") {
      record.cheapOrderSubmittedAt = submittedAt;
      record.qualified = true;
      if (decision.source !== "brti") record.nonBrtiExecutionCount += 1;
    } else {
      record.orderSubmittedAt = submittedAt;
      record.decisionAgeMs = Math.max(
        0,
        submittedAtMs - decision.decisionTimestampMs,
      );
      record.qualified = true;
      if (decision.source !== "brti") record.nonBrtiExecutionCount += 1;
      await this.appendEventLog({
        event: "trade_executed",
        strategy: "ladder-v11",
        market: marketSlug,
        initialDecisionAt: record.initialDecisionAt,
        finalDecisionAt: record.finalDecisionAt,
        orderSubmittedAt: submittedAt,
        decisionAgeMs: record.decisionAgeMs,
        initialDecisionAgeMs: record.initialDecisionAgeMs,
        brtiAgeMs: decision.brtiAgeMs,
        initialFavorite: record.initialFavorite,
        finalFavorite: record.finalFavorite,
        initialFavoritePrice: record.initialFavoritePrice,
        finalFavoritePrice: record.finalFavoritePrice,
        reversalsAtInitial: record.reversalsAtInitial,
        reversalsAtExecution: record.reversalsAtExecution,
        reversalThresholds: decision.reversalThresholds,
        v10Score: decision.v10Score,
        shadowV10TargetShares: decision.shadowV10TargetShares,
      });
    }
    await this.persist();
  }

  async recordInvariantAbort(
    marketSlug: string,
    reason: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    log("V11 INVARIANT FAILURE: favorite token is no longer favorite", {
      market: marketSlug,
      reason,
      ...context,
    });
    await this.appendEventLog({
      event: "invariant_abort",
      strategy: "ladder-v11",
      market: marketSlug,
      reason,
      context,
    });
  }

  async observeExecution(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
  ): Promise<void> {
    if (!this.registerMarket(event, snapshot.books)) return;
    const context = this.contexts.get(event.slug);
    if (context) context.latestSnapshot = snapshot;
    const record = this.state.decisions[event.slug];
    if (!record) return;
    const cheap = snapshot.books.find(
      (book) => book.tokenId === record.finalDecision.cheapTokenId,
    );
    if (
      cheap?.bestAsk !== null &&
      cheap?.bestAsk !== undefined &&
      cheap.bestAsk <= LADDER_V11_CHEAP_PRICE + EPSILON
    ) {
      record.cheapShadow.touched = true;
    }

    const orders = snapshot.orders.filter(isV11Order);
    const ids = new Set(orders.map((order) => order.id));
    const fills = snapshot.fills
      .filter((fill) => ids.has(fill.orderId))
      .map((fill) => ({ ...fill }));
    const priorFillIds = new Set(record.observedFills.map((fill) => fill.id));
    let changed = fills.length !== record.observedFills.length;
    for (const fill of fills) {
      if (priorFillIds.has(fill.id)) continue;
      changed = true;
      const order = orders.find((candidate) => candidate.id === fill.orderId);
      if (order && orderRole(order) === "favorite-initial" && fill.price < 0.5) {
        record.favoriteFillBelow50Count += 1;
        const diagnostic = {
          strategy: "ladder-v11",
          market: event.slug,
          fill,
          order,
          record,
        };
        log("V11 INVARIANT FAILURE: favorite-initial filled below 50c", diagnostic);
        await this.appendEventLog({
          event: "invariant_failure",
          message: "V11 INVARIANT FAILURE: favorite-initial filled below 50c",
          ...diagnostic,
        });
      }
    }
    if (changed) {
      record.observedFills = fills;
      await this.persist();
    }
  }

  async handleSettlement(settlement: PaperSettlement): Promise<void> {
    const record = this.state.decisions[settlement.marketSlug];
    if (!record || record.settledAt) return;
    const cheap = shadowCheapFill(record);
    const final = record.finalDecision;
    record.actualPnl = settlement.realizedPnl;
    record.winningTokenId = settlement.winningTokenId;
    record.counterfactualV7Pnl = shadowPnl(
      settlement.winningTokenId,
      final.cheapTokenId,
      final.favoriteTokenId,
      cheap,
      final.shadowV7Favorite,
    );
    record.counterfactualV10Pnl = shadowPnl(
      settlement.winningTokenId,
      final.cheapTokenId,
      final.favoriteTokenId,
      cheap,
      final.shadowV10Favorite,
    );
    record.settledAt = settlement.settledAt;
    const favoriteSize = record.observedFills
      .filter((fill) => fill.tokenId === final.favoriteTokenId)
      .reduce((sum, fill) => sum + fill.size, 0);
    const cheapSize = record.observedFills
      .filter((fill) => fill.tokenId === record.initialDecision.cheapTokenId)
      .reduce((sum, fill) => sum + fill.size, 0);
    this.state.pairHistory.push({
      marketSlug: settlement.marketSlug,
      paired: favoriteSize > EPSILON && cheapSize > EPSILON,
    });
    this.state.pairHistory = this.state.pairHistory.slice(-32);
    await this.persist();
    await this.appendEventLog({
      event: "settlement",
      strategy: "ladder-v11",
      market: settlement.marketSlug,
      settlement,
      actualPnl: record.actualPnl,
      counterfactualV7Pnl: record.counterfactualV7Pnl,
      counterfactualV10Pnl: record.counterfactualV10Pnl,
    });
  }

  snapshotState(): LadderV11State {
    return structuredClone(this.state);
  }

  shouldSkipExecutionPass(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowSeconds = this.now() / 1_000,
  ): boolean {
    const record = this.state.decisions[event.slug];
    if (!record) return false;
    const strategyOrders = snapshot.orders.filter(isV11Order);
    const cheapOpen = snapshot.openOrders.some(
      (order) => isV11Order(order) && orderRole(order) === "cheap-maker",
    );
    const favoriteAttempted = strategyOrders.some(
      (order) => orderRole(order) === "favorite-initial",
    );
    const secondsLeft = event.windowEnd - nowSeconds;
    // Preserve the existing two-minute cheap-maker cancellation pass.
    if (secondsLeft <= 120) return !cheapOpen;
    if (!record.initialDecision.eligible) return true;
    if (favoriteAttempted) return true;
    return (
      record.executionRevalidated &&
      !record.finalDecision.eligible &&
      !cheapOpen
    );
  }

  private calculateDecision(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowMs: number,
  ): LadderV11DecisionSnapshot {
    const ranked = rankBooks(snapshot.books);
    const latest = this.brtiPoints.at(-1);
    const context = this.contexts.get(event.slug);
    const secondsLeft = event.windowEnd - nowMs / 1_000;
    // Before five minutes V11 only accumulates bounded in-memory history. It
    // does not need to run the full feature calculation on every book wake.
    const score = secondsLeft <= 300 && ranked
      ? scoreOscillation({
          points: this.brtiPoints,
          bookSamples: context?.bookSamples ?? [],
          books: context?.books ?? [...snapshot.books],
          cheap: ranked.cheap,
          favorite: ranked.favorite,
          nowMs,
          source: "brti",
          volatilityP10: null,
          volatilityP90: null,
          pairHistory: this.state.pairHistory.map((item) => item.paired),
          staleMs: LADDER_V11_BRTI_STALE_MS,
        })
      : null;
    const reversals = score?.valid ? score.features.reversals : null;
    let reason: LadderV11DecisionSnapshot["reason"] = "ELIGIBLE";
    if (secondsLeft > 300) reason = "MARKET_TOO_EARLY";
    else if (secondsLeft <= 120) reason = "MARKET_ALREADY_TOO_LATE";
    else if (!ranked) reason = "INVALID_MARKET_BOOK";
    else if (!latest || score?.reason === "missing_source") reason = "NO_BRTI";
    else if (!score?.valid) reason = "INVALID_BRTI";
    else if (score.features.reversals > LADDER_V11_MAX_REVERSALS + EPSILON) {
      reason = "REVERSALS_TOO_HIGH";
    } else if ((ranked.favorite.bestAsk ?? 0) < 0.5 - EPSILON) {
      reason = "FAVORITE_BELOW_FLOOR";
    } else if (
      (ranked.favorite.bestAsk ?? 1) >
      LADDER_V11_FAVORITE_MAX_PRICE + EPSILON
    ) {
      reason = "FAVORITE_ABOVE_CAP";
    }
    const eligible = reason === "ELIGIBLE";
    const favorite = ranked?.favorite;
    const cheap = ranked?.cheap;
    const shadowV10TargetShares = score?.valid
      ? favoriteTierForScore(score.score)
      : LADDER_V11_SIZE;
    return {
      marketSlug: event.slug,
      decisionTimestamp: new Date(nowMs).toISOString(),
      decisionTimestampMs: nowMs,
      source: score?.valid ? "brti" : "none",
      scoreInputsValid: score?.valid ?? false,
      v10Score: score?.valid ? score.score : null,
      features: score?.valid ? score.features : null,
      rawFeatures: score?.valid ? score.rawFeatures : null,
      brtiTimestamp: latest ? new Date(latest.timestampMs).toISOString() : null,
      brtiTimestampMs: latest?.timestampMs ?? null,
      brtiAgeMs: latest ? Math.max(0, nowMs - latest.timestampMs) : null,
      cheapTokenId: cheap?.tokenId ?? "",
      cheapOutcome: cheap?.outcome ?? "",
      cheapPrice: cheap?.bestAsk ?? null,
      favoriteTokenId: favorite?.tokenId ?? "",
      favoriteOutcome: favorite?.outcome ?? "",
      favoritePrice: favorite?.bestAsk ?? null,
      eligible,
      decision: eligible ? "FULL_TRADE" : "NO_TRADE",
      reason,
      reversalThresholds: thresholds(reversals),
      shadowV7Favorite: favorite
        ? simulateFavorite(favorite, LADDER_V11_SIZE, snapshot)
        : emptyFill(),
      shadowV10TargetShares,
      shadowV10Favorite:
        favorite && shadowV10TargetShares > 0
          ? simulateFavorite(favorite, shadowV10TargetShares, snapshot)
          : emptyFill(),
    };
  }

  private sampleContext(context: MarketContext, nowMs: number): void {
    const second = Math.floor(nowMs / 1_000);
    if (context.lastSnapshotSecond === second) return;
    context.lastSnapshotSecond = second;
    const books = context.latestSnapshot?.books ?? context.books;
    if (books.length !== 2) return;
    context.books = cloneBooks(books);
    const ranked = rankBooks(books);
    if (!ranked) return;
    const up =
      books.find((book) => book.outcome.toLowerCase() === "up") ?? books[0]!;
    const upMid =
      up.bestBid !== null && up.bestAsk !== null
        ? (up.bestBid + up.bestAsk) / 2
        : up.bestBid ?? up.bestAsk;
    const bidDepth = topDepth(up.bids, up.bestBid);
    const askDepth = topDepth(up.asks, up.bestAsk);
    const ofi =
      context.lastBidDepth === null || context.lastAskDepth === null
        ? 0
        : bidDepth - context.lastBidDepth - (askDepth - context.lastAskDepth);
    context.lastBidDepth = bidDepth;
    context.lastAskDepth = askDepth;
    context.bookSamples.push({
      timestampMs: nowMs,
      upMid,
      cheapQueue: queueAt(ranked.cheap, LADDER_V11_CHEAP_PRICE),
      yesBidDepth: bidDepth,
      yesAskDepth: askDepth,
      ofi,
      tradeFlow: context.pendingTradeFlow,
    });
    context.pendingTradeFlow = 0;
    while (context.bookSamples[0]?.timestampMs < nowMs - 180_000) {
      context.bookSamples.shift();
    }
  }

  private addPoint(point: RegimePricePoint): void {
    if (point.source !== "brti") return;
    const second = Math.floor(point.timestampMs / 1_000);
    const last = this.brtiPoints.at(-1);
    if (last && Math.floor(last.timestampMs / 1_000) === second) {
      this.brtiPoints.pop();
    }
    this.brtiPoints.push(point);
    const cutoff = point.timestampMs - 180_000;
    while (this.brtiPoints[0] && this.brtiPoints[0].timestampMs < cutoff) {
      this.brtiPoints.shift();
    }
  }

  private async logDecision(
    decision: LadderV11DecisionSnapshot,
    stage: "initial" | "final",
  ): Promise<void> {
    const payload = {
      strategy: "ladder-v11",
      market: decision.marketSlug,
      stage,
      source: decision.source,
      reversals: decision.features?.reversals ?? null,
      v10Score: decision.v10Score,
      trendEfficiency: decision.features?.trendEfficiency ?? null,
      rangeDisplacement: decision.features?.rangeDisplacement ?? null,
      volatility: decision.features?.realizedVolatility ?? null,
      queueDepletion: decision.features?.queueDepletion ?? null,
      flowAlternation: decision.features?.flowAlternation ?? null,
      slowPairRegime: decision.features?.slowPairRegime ?? null,
      reversalThresholds: decision.reversalThresholds,
      decision: decision.decision,
      reason: decision.reason,
      favoriteTokenId: decision.favoriteTokenId,
      favoritePrice: decision.favoritePrice,
      cheapTokenId: decision.cheapTokenId,
      brtiTimestamp: decision.brtiTimestamp,
      brtiAgeMs: decision.brtiAgeMs,
    };
    log("Ladder V11 decision", payload);
    await this.appendEventLog({ event: "decision", ...payload });
  }

  private removeContext(context: MarketContext): void {
    this.contexts.delete(context.event.slug);
    const ticker = context.event.market.externalMarketId ?? context.event.market.id;
    if (ticker && this.tickerToSlug.get(ticker) === context.event.slug) {
      this.tickerToSlug.delete(ticker);
    }
  }

  private async appendEventLog(event: Record<string, unknown>): Promise<void> {
    this.eventLogQueue = this.eventLogQueue.then(async () => {
      await appendRotatingJsonLine(
        this.eventLogPath,
        { timestamp: new Date(this.now()).toISOString(), ...event },
      );
    });
    await this.eventLogQueue;
  }

  private async persist(): Promise<void> {
    this.persistenceQueue = this.persistenceQueue.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      const serialized = JSON.stringify(this.state);
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
    });
    await this.persistenceQueue;
  }
}
