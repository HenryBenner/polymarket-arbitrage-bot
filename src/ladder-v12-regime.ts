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
import { LADDER_V12_CHEAP_PRICE } from "./ladder-v12.js";
import {
  KalshiBrtiProvider,
  type RegimePricePoint,
  type RegimePriceProvider,
} from "./regime-price-stream.js";
import type {
  MarketExecutionSnapshot,
  PaperSettlement,
  TokenBook,
  UpDownEvent,
} from "./types.js";

const EPSILON = 1e-9;
const STATE_VERSION = 1;
const V12_PREFIX = "ladder-v12:";

export const LADDER_V12_MAX_STORED_DECISION_AGE_MS = 1_000;
export const LADDER_V12_BRTI_TRANSPORT_STALE_MS = 2_000;
export const LADDER_V12_BRTI_VALUE_STALE_MS = 10_000;

export type LadderV12DecisionReason =
  | "ELIGIBLE"
  | "SCORE_BELOW_ENTRY"
  | "NO_BRTI"
  | "INVALID_BRTI"
  | "INVALID_MARKET_BOOK"
  | "MARKET_ALREADY_TOO_LATE"
  | "MARKET_TOO_EARLY";

export interface LadderV12DecisionSnapshot {
  marketSlug: string;
  decisionTimestamp: string;
  decisionTimestampMs: number;
  source: "brti" | "none";
  scoreInputsValid: boolean;
  v10Score: number | null;
  targetShares: number;
  features: OscillationFeatures | null;
  rawFeatures: OscillationRawFeatures | null;
  brtiTimestamp: string | null;
  brtiTimestampMs: number | null;
  brtiAgeMs: number | null;
  brtiObservedAtMs: number | null;
  brtiObservedAgeMs: number | null;
  brtiSequenceValid: boolean | null;
  brtiCoverage: number | null;
  brtiScoreReason: string | null;
  cheapTokenId: string;
  cheapOutcome: string;
  cheapPrice: number | null;
  favoriteTokenId: string;
  favoriteOutcome: string;
  favoritePrice: number | null;
  entryEligible: boolean;
  reason: LadderV12DecisionReason;
}

interface LadderV12State {
  version: typeof STATE_VERSION;
  pairHistory: Array<{ marketSlug: string; paired: boolean }>;
  volatilitySamples: number[];
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
  latestDecision: LadderV12DecisionSnapshot | null;
}

export interface LadderV12RegimeOptions {
  providers?: RegimePriceProvider[];
  now?: () => number;
}

function emptyState(): LadderV12State {
  return { version: STATE_VERSION, pairHistory: [], volatilitySamples: [] };
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

function percentile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const fraction = index - low;
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction;
}

export class LadderV12RegimeEngine {
  private state = emptyState();
  private readonly statePath: string;
  private readonly contexts = new Map<string, MarketContext>();
  private readonly completedContexts = new Map<
    string,
    Pick<MarketContext, "latestSnapshot" | "latestDecision">
  >();
  private readonly tickerToSlug = new Map<string, string>();
  private readonly brtiPoints: RegimePricePoint[] = [];
  private readonly providers: RegimePriceProvider[];
  private readonly now: () => number;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: BotConfig,
    options: LadderV12RegimeOptions = {},
  ) {
    this.statePath = join(config.paperStatePath, "ladder-v12-regime-state.json");
    this.providers = options.providers ?? [new KalshiBrtiProvider(config)];
    this.now = options.now ?? (() => Date.now());
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as LadderV12State;
      if (parsed.version !== STATE_VERSION) {
        throw new Error("Unsupported Ladder V12 regime state");
      }
      this.state = parsed;
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
        throw new Error("ladder_v12 only permits a BRTI price provider");
      }
      provider.start((point) => this.addPoint(point));
    }
  }

  async close(): Promise<void> {
    for (const provider of this.providers) provider.close();
    await this.persistenceQueue;
  }

  registerMarket(event: UpDownEvent, books: readonly TokenBook[]): boolean {
    if (event.windowEnd <= this.now() / 1_000) return false;
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
        latestDecision: null,
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
    const tokenId = String(event.asset_id ?? "");
    const up = context.books.find((book) => book.outcome.toLowerCase() === "up");
    if (Number.isFinite(size)) {
      context.pendingTradeFlow += tokenId === up?.tokenId ? size : -size;
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
      if (snapshot) this.observeExecution(context.event, snapshot);
      this.sampleContext(context, nowMs);
    }
  }

  observeExecution(event: UpDownEvent, snapshot: MarketExecutionSnapshot): void {
    if (!this.registerMarket(event, snapshot.books)) return;
    const context = this.contexts.get(event.slug);
    if (context) context.latestSnapshot = snapshot;
  }

  evaluate(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowMs = this.now(),
  ): LadderV12DecisionSnapshot {
    this.observeExecution(event, snapshot);
    const context = this.contexts.get(event.slug);
    if (context) this.sampleContext(context, nowMs);
    const ranked = rankBooks(snapshot.books);
    const latest = this.brtiPoints.at(-1);
    const latestObservedAtMs =
      latest?.observedAtMs ?? latest?.receivedAtMs ?? latest?.timestampMs;
    const secondsLeft = event.windowEnd - nowMs / 1_000;
    const volatilityP10 = percentile(this.state.volatilitySamples, 0.1);
    const volatilityP90 = percentile(this.state.volatilitySamples, 0.9);
    const score = secondsLeft <= 300 && ranked
      ? scoreOscillation({
          points: this.brtiPoints,
          bookSamples: context?.bookSamples ?? [],
          books: context?.books ?? [...snapshot.books],
          cheap: ranked.cheap,
          favorite: ranked.favorite,
          nowMs,
          source: "brti",
          volatilityP10,
          volatilityP90,
          pairHistory: this.state.pairHistory.map((item) => item.paired),
          staleMs: LADDER_V12_BRTI_TRANSPORT_STALE_MS,
          latestObservedAtMs,
          sourceValueStaleMs: LADDER_V12_BRTI_VALUE_STALE_MS,
          priceWindowNowMs: latest?.timestampMs,
        })
      : null;
    const rawTarget = score?.valid
      ? favoriteTierForScore(score.score, 40, 70, 20, 40)
      : 0;
    const targetShares = Math.max(0, Math.min(40, rawTarget));
    let reason: LadderV12DecisionReason = "ELIGIBLE";
    if (secondsLeft > 300) reason = "MARKET_TOO_EARLY";
    else if (secondsLeft <= 120) reason = "MARKET_ALREADY_TOO_LATE";
    else if (!ranked) reason = "INVALID_MARKET_BOOK";
    else if (!latest || score?.reason === "missing_source") reason = "NO_BRTI";
    else if (!score?.valid) reason = "INVALID_BRTI";
    else if (targetShares === 0) reason = "SCORE_BELOW_ENTRY";
    const decision: LadderV12DecisionSnapshot = {
      marketSlug: event.slug,
      decisionTimestamp: new Date(nowMs).toISOString(),
      decisionTimestampMs: nowMs,
      source: score?.valid ? "brti" : "none",
      scoreInputsValid: score?.valid ?? false,
      v10Score: score?.valid ? score.score : null,
      targetShares,
      features: score?.valid ? score.features : null,
      rawFeatures: score?.valid ? score.rawFeatures : null,
      brtiTimestamp: latest ? new Date(latest.timestampMs).toISOString() : null,
      brtiTimestampMs: latest?.timestampMs ?? null,
      brtiAgeMs: latest ? Math.max(0, nowMs - latest.timestampMs) : null,
      brtiObservedAtMs: latestObservedAtMs ?? null,
      brtiObservedAgeMs:
        latestObservedAtMs === undefined
          ? null
          : Math.max(0, nowMs - latestObservedAtMs),
      brtiSequenceValid: latest?.sequenceValid ?? null,
      brtiCoverage: score?.coverage ?? null,
      brtiScoreReason: score?.reason ?? null,
      cheapTokenId: ranked?.cheap.tokenId ?? "",
      cheapOutcome: ranked?.cheap.outcome ?? "",
      cheapPrice: ranked?.cheap.bestAsk ?? null,
      favoriteTokenId: ranked?.favorite.tokenId ?? "",
      favoriteOutcome: ranked?.favorite.outcome ?? "",
      favoritePrice: ranked?.favorite.bestAsk ?? null,
      entryEligible: reason === "ELIGIBLE",
      reason,
    };
    if (context) context.latestDecision = decision;
    return decision;
  }

  async handleSettlement(settlement: PaperSettlement): Promise<void> {
    const context = this.contexts.get(settlement.marketSlug);
    const completed = this.completedContexts.get(settlement.marketSlug);
    if (!context && !completed) return;
    const snapshot = context?.latestSnapshot ?? completed?.latestSnapshot ?? null;
    const orders = snapshot?.orders.filter(
      (order) => order.pairId?.startsWith(V12_PREFIX),
    ) ?? [];
    const ids = new Set(orders.map((order) => order.id));
    const filledTokens = new Set(
      (snapshot?.fills ?? [])
        .filter((fill) => ids.has(fill.orderId) && fill.size > EPSILON)
        .map((fill) => fill.tokenId),
    );
    this.state.pairHistory.push({
      marketSlug: settlement.marketSlug,
      paired: filledTokens.size === 2,
    });
    this.state.pairHistory = this.state.pairHistory.slice(-64);
    const volatility =
      context?.latestDecision?.features?.volatilityRaw ??
      completed?.latestDecision?.features?.volatilityRaw;
    if (volatility !== undefined && Number.isFinite(volatility)) {
      this.state.volatilitySamples.push(round(volatility));
      this.state.volatilitySamples = this.state.volatilitySamples.slice(-512);
    }
    await this.persist();
    if (context) this.removeContext(context);
    this.completedContexts.delete(settlement.marketSlug);
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
    const up = books.find((book) => book.outcome.toLowerCase() === "up") ?? books[0]!;
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
      cheapQueue: queueAt(ranked.cheap, LADDER_V12_CHEAP_PRICE),
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

  private removeContext(context: MarketContext): void {
    if (context.latestSnapshot || context.latestDecision) {
      this.completedContexts.set(context.event.slug, {
        latestSnapshot: context.latestSnapshot,
        latestDecision: context.latestDecision,
      });
      while (this.completedContexts.size > 8) {
        const oldest = this.completedContexts.keys().next().value;
        if (!oldest) break;
        this.completedContexts.delete(oldest);
      }
    }
    this.contexts.delete(context.event.slug);
    const ticker = context.event.market.externalMarketId ?? context.event.market.id;
    if (ticker && this.tickerToSlug.get(ticker) === context.event.slug) {
      this.tickerToSlug.delete(ticker);
    }
  }

  private async persist(): Promise<void> {
    this.persistenceQueue = this.persistenceQueue.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(this.state), "utf8");
      try {
        await rename(temporaryPath, this.statePath);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await rm(this.statePath, { force: true });
        await rename(temporaryPath, this.statePath);
      }
    });
    await this.persistenceQueue;
  }
}
