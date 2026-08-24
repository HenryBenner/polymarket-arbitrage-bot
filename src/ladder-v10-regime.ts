import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import {
  CoinbasePriceProvider,
  KalshiBrtiProvider,
  type RegimePricePoint,
  type RegimePriceProvider,
  type RegimePriceSource,
} from "./regime-price-stream.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperSettlement,
  TokenBook,
  UpDownEvent,
} from "./types.js";

const SCORE_VERSION = "v10-heuristic-1";
const V10_PREFIX = "ladder-v10:";
const EPSILON = 1e-9;
const FULL_FAVORITE_SHARES = 40;
const SHADOW_MAX_PAIR_COST = 0.9;
const SHADOW_RUNG_LOW_CENTS = 8;
const SHADOW_RUNG_HIGH_CENTS = 25;
const SHADOW_RUNG_COUNT = SHADOW_RUNG_HIGH_CENTS - SHADOW_RUNG_LOW_CENTS + 1;
const BINARY_EXPERIMENT_VERSION = "v10-binary-shadow-1";

export interface BookSample {
  timestampMs: number;
  upMid: number | null;
  cheapQueue: number;
  yesBidDepth: number;
  yesAskDepth: number;
  ofi: number;
  tradeFlow: number;
}

export interface OscillationFeatures {
  trendEfficiency: number;
  reversals: number;
  rangeDisplacement: number;
  realizedVolatility: number;
  volatilityRaw: number;
  marketGeometry: number;
  queueDepletion: number;
  flowAlternation: number;
  slowPairRegime: number;
}

export interface OscillationScore {
  valid: boolean;
  reason: string;
  source: RegimePriceSource;
  score: number;
  features: OscillationFeatures;
  rawFeatures: OscillationRawFeatures | null;
  coverage: number;
}

export interface OscillationRawFeatures {
  pathOscillationByWindow: number[];
  reversalRateByWindow: number[];
  rangeDisplacementByWindow: number[];
  volatilityByWindow: number[];
  cheapAsk: number;
  favoriteAsk: number;
  queueStart: number;
  queueEnd: number;
  queueDepletionRatio: number;
  flowNet: number;
  flowMagnitude: number;
  pairRates: { rate8: number; rate16: number; rate32: number };
}

interface CounterfactualFill {
  size: number;
  cost: number;
  fee: number;
}

export type ShadowCheapFillState =
  | "DEFINITE_FILL"
  | "QUEUE_FILL"
  | "UNCERTAIN"
  | "NO_FILL";

export interface ShadowRungMasks {
  eligible: number;
  crossed: number;
  queueCleared: number;
}

interface ShadowRungTracking extends ShadowRungMasks {
  touched: number;
  queueAhead: number[];
  volumeAtRung: number[];
}

export interface LadderV10ShadowResult {
  marketSlug: string;
  v10Score: number | null;
  legacyV10TargetShares: number;
  binaryV10TargetShares: number;
  v10Actual: { favoriteShares: number; pnl: number };
  legacyV10: { favoriteShares: number; pnl: number };
  shadowV7: { pnl: number };
  shadowDangerFilter: {
    triggered: boolean;
    favoritePrice: number | null;
    pnl: number;
  };
  shadowDynamicCheap: {
    favoritePrice: number | null;
    cheapTarget: number | null;
    fillState: ShadowCheapFillState;
    pnl: number;
  };
  rungMasks: ShadowRungMasks;
  favoriteDepthAt80: number;
  vwap40: number | null;
  vwap80: number | null;
  vwap120: number | null;
}

export interface LadderV10Decision {
  marketSlug: string;
  createdAt: string;
  scoreVersion: string;
  score: number | null;
  scoreValid: boolean;
  source: RegimePriceSource | "none";
  decisionReason: "adaptive" | "burn_in" | "v7_fallback";
  favoriteTargetShares: number;
  experimentVersion?: typeof BINARY_EXPERIMENT_VERSION;
  legacyV10TargetShares?: number;
  binaryV10TargetShares?: number;
  cheapTokenId: string;
  favoriteTokenId: string;
  features: OscillationFeatures | null;
  rawFeatures?: OscillationRawFeatures | null;
  counterfactualFavorite: CounterfactualFill;
  legacyCounterfactualFavorite?: CounterfactualFill;
  expectedFavoriteFillPrice?: number | null;
  dynamicCheapTarget?: number | null;
  favoriteDepthAt80?: number;
  vwap40?: number | null;
  vwap80?: number | null;
  vwap120?: number | null;
  shadowMakerFeeRate?: number;
  shadowFeeExponent?: number;
  shadowRungTracking?: ShadowRungTracking;
  shadowResult?: LadderV10ShadowResult;
  observedFills: PaperFill[];
  actualPnl?: number;
  counterfactualV7Pnl?: number;
  settledAt?: string;
}

interface CalibrationComparison {
  coverage: number;
  directionAgreement: number;
  correlation: number;
  pathTierAgreement: boolean;
}

interface RegimeState {
  version: 1;
  scoreVersion: string;
  completeMarkets: string[];
  volatilitySamples: number[];
  volatilityP10: number | null;
  volatilityP90: number | null;
  coinbaseComparisons: CalibrationComparison[];
  coinbaseEligible: boolean;
  pairHistory: Array<{ marketSlug: string; paired: boolean }>;
  decisions: Record<string, LadderV10Decision>;
}

interface MarketContext {
  event: UpDownEvent;
  books: TokenBook[];
  bookSamples: BookSample[];
  firstObservedSecondsLeft: number;
  sampleCount: number;
  lastSnapshotSecond: number;
  lastBidDepth: number | null;
  lastAskDepth: number | null;
  pendingTradeFlow: number;
  shadowRungTracking: ShadowRungTracking | null;
  shadowTradeKeys: Set<string>;
  latestSnapshot: MarketExecutionSnapshot | null;
  finalized: boolean;
}

interface RegimeEngineOptions {
  providers?: RegimePriceProvider[];
  now?: () => number;
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value));
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function correlation(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length < 3) return 0;
  const a = left.slice(0, length);
  const b = right.slice(0, length);
  const meanA = mean(a);
  const meanB = mean(b);
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let index = 0; index < length; index += 1) {
    const deltaA = a[index]! - meanA;
    const deltaB = b[index]! - meanB;
    numerator += deltaA * deltaB;
    denominatorA += deltaA * deltaA;
    denominatorB += deltaB * deltaB;
  }
  const denominator = Math.sqrt(denominatorA * denominatorB);
  return denominator <= EPSILON ? 0 : numerator / denominator;
}

function emptyFeatures(): OscillationFeatures {
  return {
    trendEfficiency: 0,
    reversals: 0,
    rangeDisplacement: 0,
    realizedVolatility: 0,
    volatilityRaw: 0,
    marketGeometry: 0,
    queueDepletion: 0,
    flowAlternation: 0,
    slowPairRegime: 0,
  };
}

function pointAtOrBefore(
  points: readonly RegimePricePoint[],
  timestampMs: number,
): RegimePricePoint | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point.timestampMs <= timestampMs) return point;
  }
  return null;
}

function windowPoints(
  points: readonly RegimePricePoint[],
  nowMs: number,
  windowSeconds: number,
): RegimePricePoint[] {
  const minimum = nowMs - windowSeconds * 1_000;
  return points.filter(
    (point) => point.timestampMs >= minimum && point.timestampMs <= nowMs,
  );
}

function windowPathFeatures(points: RegimePricePoint[]): {
  oscillation: number;
  rangeDisplacement: number;
  volatility: number;
} {
  if (points.length < 2) {
    return { oscillation: 0, rangeDisplacement: 0, volatility: 0 };
  }
  const prices = points.map((point) => point.price);
  let path = 0;
  let squaredReturns = 0;
  for (let index = 1; index < prices.length; index += 1) {
    path += Math.abs(prices[index]! - prices[index - 1]!);
    const value = Math.log(prices[index]! / prices[index - 1]!);
    squaredReturns += value * value;
  }
  const displacement = Math.abs(prices.at(-1)! - prices[0]!);
  const range = Math.max(...prices) - Math.min(...prices);
  const rangeBps = (range / prices[0]!) * 10_000;
  return {
    oscillation: path <= EPSILON ? 0 : clamp(1 - displacement / path),
    rangeDisplacement:
      rangeBps < 2 || range <= EPSILON ? 0 : clamp(1 - displacement / range),
    volatility: Math.sqrt(squaredReturns),
  };
}

function fiveSecondReturns(
  points: readonly RegimePricePoint[],
  nowMs: number,
  windowSeconds: number,
): number[] {
  const returns: number[] = [];
  const aligned = Math.floor(nowMs / 5_000) * 5_000;
  let previous = pointAtOrBefore(points, aligned - windowSeconds * 1_000);
  if (!previous) return returns;
  for (
    let timestamp = aligned - (windowSeconds - 5) * 1_000;
    timestamp <= aligned;
    timestamp += 5_000
  ) {
    const current = pointAtOrBefore(points, timestamp);
    if (!current) continue;
    returns.push(Math.log(current.price / previous.price));
    previous = current;
  }
  return returns;
}

function reversalRate(returns: number[]): number {
  const signs = returns
    .filter((value) => Math.abs(value) >= 0.0001)
    .map((value) => Math.sign(value));
  if (signs.length < 2) return 0;
  let changes = 0;
  for (let index = 1; index < signs.length; index += 1) {
    if (signs[index] !== signs[index - 1]) changes += 1;
  }
  return changes / (signs.length - 1);
}

function sourceCoverage(
  points: readonly RegimePricePoint[],
  nowMs: number,
  seconds: number,
): number {
  const unique = new Set(
    windowPoints(points, nowMs, seconds).map((point) =>
      Math.floor(point.timestampMs / 1_000),
    ),
  );
  return clamp(unique.size / (seconds + 1));
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

export function scoreOscillation(input: {
  points: RegimePricePoint[];
  bookSamples: BookSample[];
  books: TokenBook[];
  cheap: TokenBook;
  favorite: TokenBook;
  nowMs: number;
  source: RegimePriceSource;
  volatilityP10: number | null;
  volatilityP90: number | null;
  pairHistory: boolean[];
  staleMs: number;
}): OscillationScore {
  const latest = input.points.at(-1);
  const coverage = sourceCoverage(input.points, input.nowMs, 120);
  if (
    !latest ||
    input.nowMs - latest.timestampMs > input.staleMs ||
    coverage < 0.95
  ) {
    return {
      valid: false,
      reason: !latest ? "missing_source" : coverage < 0.95 ? "insufficient_history" : "stale_source",
      source: input.source,
      score: 0,
      features: emptyFeatures(),
      rawFeatures: null,
      coverage,
    };
  }

  const windows = [30, 60, 120];
  const paths = windows.map((seconds) =>
    windowPathFeatures(windowPoints(input.points, input.nowMs, seconds)),
  );
  const volatilityRaw = mean(paths.map((path) => path.volatility));
  const p10 = input.volatilityP10 ?? 0;
  const p90 = input.volatilityP90 ?? 0.001;
  const realizedVolatility =
    p90 - p10 <= EPSILON ? 0 : clamp((volatilityRaw - p10) / (p90 - p10));

  const cheapAsk = input.cheap.bestAsk ?? 0.5;
  const favoriteAsk = input.favorite.bestAsk ?? 0.5;
  const distance = Math.max(0, cheapAsk - 0.1);
  const distanceScore = clamp((0.3 - distance) / 0.3);
  const favoriteScore = clamp((favoriteAsk - 0.5) / 0.2);

  const recentBooks = input.bookSamples.filter(
    (sample) => sample.timestampMs >= input.nowMs - 15_000,
  );
  const firstQueue = recentBooks[0]?.cheapQueue ?? 0;
  const lastQueue = recentBooks.at(-1)?.cheapQueue ?? firstQueue;
  const queueChange =
    firstQueue <= EPSILON
      ? lastQueue <= EPSILON
        ? 0
        : -1
      : (firstQueue - lastQueue) / firstQueue;
  const queueDepletion = clamp(0.5 + queueChange);

  const flow = recentBooks.map((sample) => sample.ofi + sample.tradeFlow);
  const flowMagnitude = flow.reduce((sum, value) => sum + Math.abs(value), 0);
  const flowAlternation =
    flowMagnitude <= EPSILON
      ? 0
      : clamp(1 - Math.abs(flow.reduce((sum, value) => sum + value, 0)) / flowMagnitude);

  const pairRate = (count: number): number => {
    const values = input.pairHistory.slice(-count);
    return values.length === 0
      ? 0
      : values.filter(Boolean).length / values.length;
  };
  const slowPairRegime = clamp(
    (0.5 * pairRate(8) + 0.3 * pairRate(16) + 0.2 * pairRate(32)) / 0.1,
  );

  const reversalRates = windows.map((seconds) =>
    reversalRate(fiveSecondReturns(input.points, input.nowMs, seconds)),
  );
  const rates = {
    rate8: pairRate(8),
    rate16: pairRate(16),
    rate32: pairRate(32),
  };
  const rawFeatures: OscillationRawFeatures = {
    pathOscillationByWindow: paths.map((path) => path.oscillation),
    reversalRateByWindow: reversalRates,
    rangeDisplacementByWindow: paths.map((path) => path.rangeDisplacement),
    volatilityByWindow: paths.map((path) => path.volatility),
    cheapAsk,
    favoriteAsk,
    queueStart: firstQueue,
    queueEnd: lastQueue,
    queueDepletionRatio: queueChange,
    flowNet: flow.reduce((sum, value) => sum + value, 0),
    flowMagnitude,
    pairRates: rates,
  };
  const features: OscillationFeatures = {
    trendEfficiency: mean(paths.map((path) => path.oscillation)),
    reversals: mean(reversalRates),
    rangeDisplacement: mean(paths.map((path) => path.rangeDisplacement)),
    realizedVolatility,
    volatilityRaw,
    marketGeometry: (2 * distanceScore + favoriteScore) / 3,
    queueDepletion,
    flowAlternation,
    slowPairRegime,
  };
  const score = Math.round(
    100 *
      (0.2 * features.trendEfficiency +
        0.15 * features.reversals +
        0.1 * features.rangeDisplacement +
        0.1 * features.realizedVolatility +
        0.15 * features.marketGeometry +
        0.1 * features.queueDepletion +
        0.1 * features.flowAlternation +
        0.1 * features.slowPairRegime),
  );
  return {
    valid: true,
    reason: "ok",
    source: input.source,
    score,
    features,
    rawFeatures,
    coverage,
  };
}

function emptyState(): RegimeState {
  return {
    version: 1,
    scoreVersion: SCORE_VERSION,
    completeMarkets: [],
    volatilitySamples: [],
    volatilityP10: null,
    volatilityP90: null,
    coinbaseComparisons: [],
    coinbaseEligible: false,
    pairHistory: [],
    decisions: {},
  };
}

function cloneBooks(books: readonly TokenBook[]): TokenBook[] {
  return books.map((book) => ({
    ...book,
    bids: book.bids.map((level) => ({ ...level })),
    asks: book.asks.map((level) => ({ ...level })),
  }));
}

export function favoriteTierForScore(
  score: number,
  low = 40,
  high = 70,
  midShares = 20,
  fullShares = 40,
): number {
  return score < low ? 0 : score < high ? midShares : fullShares;
}

export function binaryFavoriteTarget(legacyTargetShares: number): number {
  return legacyTargetShares <= EPSILON ? 0 : FULL_FAVORITE_SHARES;
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

function simulateFavorite(
  favorite: TokenBook,
  limit: number,
  shares: number,
  snapshot: MarketExecutionSnapshot,
): CounterfactualFill {
  let remaining = shares;
  let size = 0;
  let cost = 0;
  let fee = 0;
  for (const level of favorite.asks) {
    if (level.price > limit + EPSILON || remaining <= EPSILON) break;
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

function simulateVwap(book: TokenBook, shares: number, limit = 0.8): number | null {
  let remaining = shares;
  let cost = 0;
  for (const level of book.asks) {
    if (level.price > limit + EPSILON || remaining <= EPSILON) break;
    const selected = Math.min(remaining, level.size);
    cost += selected * level.price;
    remaining -= selected;
  }
  return remaining > EPSILON ? null : round(cost / shares);
}

function floorToCent(value: number): number {
  return Math.floor((value + EPSILON) * 100) / 100;
}

export function shadowDynamicCheapTarget(
  favoritePrice: number | null,
): number | null {
  return favoritePrice === null
    ? null
    : round(clamp(floorToCent(SHADOW_MAX_PAIR_COST - favoritePrice), 0.08, 0.25), 2);
}

export function classifyShadowCheapFill(
  target: number | null,
  tracking: {
    eligible: number;
    crossed: number;
    queueCleared: number;
    touched: number;
  } | null,
): ShadowCheapFillState {
  const index = target === null ? null : rungIndex(target);
  const bit = index === null ? 0 : rungBit(index);
  if (index === null || !tracking || (tracking.eligible & bit) === 0) {
    return "NO_FILL";
  }
  if ((tracking.crossed & bit) !== 0) return "DEFINITE_FILL";
  if ((tracking.queueCleared & bit) !== 0) return "QUEUE_FILL";
  return (tracking.touched & bit) !== 0 ? "UNCERTAIN" : "NO_FILL";
}

function rungIndex(price: number): number | null {
  const cents = Math.round(price * 100);
  return cents < SHADOW_RUNG_LOW_CENTS || cents > SHADOW_RUNG_HIGH_CENTS
    ? null
    : cents - SHADOW_RUNG_LOW_CENTS;
}

function rungPrice(index: number): number {
  return (SHADOW_RUNG_LOW_CENTS + index) / 100;
}

function rungBit(index: number): number {
  return 1 << index;
}

function initializeRungTracking(cheap: TokenBook): ShadowRungTracking {
  let eligible = 0;
  const queueAhead = Array.from({ length: SHADOW_RUNG_COUNT }, () => 0);
  for (let index = 0; index < SHADOW_RUNG_COUNT; index += 1) {
    const price = rungPrice(index);
    if (cheap.bestAsk !== null && price + EPSILON < cheap.bestAsk) {
      eligible |= rungBit(index);
      queueAhead[index] = queueAt(cheap, price);
    }
  }
  return {
    eligible,
    crossed: 0,
    queueCleared: 0,
    touched: 0,
    queueAhead,
    volumeAtRung: Array.from({ length: SHADOW_RUNG_COUNT }, () => 0),
  };
}

function copyRungTracking(tracking: ShadowRungTracking): ShadowRungTracking {
  return {
    eligible: tracking.eligible,
    crossed: tracking.crossed,
    queueCleared: tracking.queueCleared,
    touched: tracking.touched,
    queueAhead: [...tracking.queueAhead],
    volumeAtRung: [...tracking.volumeAtRung],
  };
}

function shadowPnl(input: {
  winningTokenId: string;
  cheapTokenId: string;
  favoriteTokenId: string;
  cheapSize: number;
  cheapCost: number;
  favorite: CounterfactualFill;
}): number {
  const payout =
    input.winningTokenId === input.cheapTokenId
      ? input.cheapSize
      : input.winningTokenId === input.favoriteTokenId
        ? input.favorite.size
        : 0;
  return round(payout - input.cheapCost - input.favorite.cost - input.favorite.fee);
}

function emptyFill(): CounterfactualFill {
  return { size: 0, cost: 0, fee: 0 };
}

export class LadderV10RegimeEngine {
  private state = emptyState();
  private readonly statePath: string;
  private readonly eventLogPath: string;
  private readonly contexts = new Map<string, MarketContext>();
  private readonly tickerToSlug = new Map<string, string>();
  private readonly points = new Map<RegimePriceSource, RegimePricePoint[]>([
    ["brti", []],
    ["coinbase", []],
    ["kalshi_proxy", []],
  ]);
  private readonly providers: RegimePriceProvider[];
  private readonly now: () => number;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private snapshotQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: BotConfig,
    options: RegimeEngineOptions = {},
  ) {
    this.statePath = join(config.paperStatePath, "ladder-v10-regime-state.json");
    this.eventLogPath = join(config.paperStatePath, "btc-regime-events.jsonl");
    this.providers =
      options.providers ??
      [new KalshiBrtiProvider(config), new CoinbasePriceProvider(config)];
    this.now = options.now ?? (() => Date.now());
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as RegimeState;
      if (parsed.version !== 1 || parsed.scoreVersion !== SCORE_VERSION) {
        throw new Error("Unsupported Ladder V10 regime state");
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
      provider.start((point) => this.addPoint(point));
    }
  }

  async close(): Promise<void> {
    for (const provider of this.providers) provider.close();
    await this.persistenceQueue;
    await this.snapshotQueue;
  }

  registerMarket(event: UpDownEvent, books: readonly TokenBook[]): boolean {
    const nowMs = this.now();
    // Scanner/execution wakes can arrive after a contract settles. Do not let
    // them recreate an expired context and resume one-second JSONL writes.
    if (event.windowEnd <= nowMs / 1_000) return false;
    for (const context of this.contexts.values()) {
      if (context.event.windowEnd <= nowMs / 1_000) this.removeContext(context);
    }
    const existing = this.contexts.get(event.slug);
    if (existing) {
      existing.event = event;
      existing.books = cloneBooks(books);
    } else {
      this.contexts.set(event.slug, {
        event,
        books: cloneBooks(books),
        bookSamples: [],
        firstObservedSecondsLeft: event.windowEnd - nowMs / 1_000,
        sampleCount: 0,
        lastSnapshotSecond: -1,
        lastBidDepth: null,
        lastAskDepth: null,
        pendingTradeFlow: 0,
        shadowRungTracking: null,
        shadowTradeKeys: new Set<string>(),
        latestSnapshot: null,
        finalized: false,
      });
    }
    const ticker = event.market.externalMarketId ?? event.market.id;
    if (ticker) this.tickerToSlug.set(ticker, event.slug);
    // V10 is BTC-only and can have at most the current contract plus one
    // handoff context. This is a hard memory guard against duplicate wakes.
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
      const assetId = String(event.asset_id);
      slug = [...this.contexts].find(([, context]) =>
        context.books.some((book) => book.tokenId === assetId),
      )?.[0];
    }
    const context = slug ? this.contexts.get(slug) : undefined;
    if (!context) return;
    if (event.event_type === "last_trade_price") {
      const size = Number(event.size);
      const price = Number(event.price);
      const tokenId = String(event.asset_id ?? "");
      const up = context.books.find((book) => book.outcome.toLowerCase() === "up");
      if (Number.isFinite(size)) {
        context.pendingTradeFlow += tokenId === up?.tokenId ? size : -size;
      }
      const decision = this.state.decisions[context.event.slug];
      const tracking = context.shadowRungTracking;
      if (
        decision?.experimentVersion === BINARY_EXPERIMENT_VERSION &&
        tracking &&
        tokenId === decision.cheapTokenId &&
        Number.isFinite(price) &&
        Number.isFinite(size) &&
        size > 0
      ) {
        const tradeKey = [
          event.transaction_hash ?? "",
          event.timestamp ?? "",
          tokenId,
          price,
          size,
        ].join(":");
        if (context.shadowTradeKeys.has(tradeKey)) return;
        context.shadowTradeKeys.add(tradeKey);
        if (context.shadowTradeKeys.size > 256) {
          const oldest = context.shadowTradeKeys.values().next().value as
            | string
            | undefined;
          if (oldest) context.shadowTradeKeys.delete(oldest);
        }
        for (let index = 0; index < SHADOW_RUNG_COUNT; index += 1) {
          const bit = rungBit(index);
          if ((tracking.eligible & bit) === 0) continue;
          const rung = rungPrice(index);
          if (price < rung - EPSILON) {
            tracking.touched |= bit;
            tracking.crossed |= bit;
          } else if (Math.abs(price - rung) <= EPSILON) {
            tracking.touched |= bit;
            tracking.volumeAtRung[index] = round(
              (tracking.volumeAtRung[index] ?? 0) + size,
            );
            if (
              tracking.volumeAtRung[index]! + EPSILON >=
              (tracking.queueAhead[index] ?? 0) + FULL_FAVORITE_SHARES
            ) {
              tracking.queueCleared |= bit;
            }
          }
        }
      }
    }
  }

  observeExecution(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
  ): void {
    if (!this.registerMarket(event, snapshot.books)) return;
    const context = this.contexts.get(event.slug);
    if (!context) return;
    context.latestSnapshot = snapshot;
    const decision = this.state.decisions[event.slug];
    if (!decision) return;
    if (
      decision.experimentVersion === BINARY_EXPERIMENT_VERSION &&
      context.shadowRungTracking
    ) {
      const cheap = snapshot.books.find(
        (book) => book.tokenId === decision.cheapTokenId,
      );
      if (cheap?.bestAsk !== null && cheap?.bestAsk !== undefined) {
        for (let index = 0; index < SHADOW_RUNG_COUNT; index += 1) {
          const bit = rungBit(index);
          if (
            (context.shadowRungTracking.eligible & bit) !== 0 &&
            cheap.bestAsk <= rungPrice(index) + EPSILON
          ) {
            context.shadowRungTracking.touched |= bit;
          }
        }
      }
    }
    const ids = new Set(
      snapshot.orders
        .filter((order) => order.pairId?.startsWith(V10_PREFIX))
        .map((order) => order.id),
    );
    const observedFills = snapshot.fills
      .filter((fill) => ids.has(fill.orderId))
      .map((fill) => ({ ...fill }));
    if (
      observedFills.length !== decision.observedFills.length ||
      observedFills.some(
        (fill, index) => fill.id !== decision.observedFills[index]?.id,
      )
    ) {
      decision.observedFills = observedFills;
    }
  }

  async sampleAll(
    snapshotFor: (marketSlug: string) => MarketExecutionSnapshot | null,
    nowMs = this.now(),
  ): Promise<void> {
    for (const context of this.contexts.values()) {
      if (nowMs / 1_000 > context.event.windowEnd && !context.finalized) {
        context.finalized = true;
        await this.finalizeMarket(context);
        this.removeContext(context);
        continue;
      }
      const snapshot = snapshotFor(context.event.slug);
      if (snapshot) this.observeExecution(context.event, snapshot);
      await this.sampleContext(context, nowMs);
    }
  }

  async decisionFor(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowSeconds = this.now() / 1_000,
  ): Promise<LadderV10Decision | null> {
    if (nowSeconds >= event.windowEnd) {
      return this.state.decisions[event.slug] ?? null;
    }
    this.observeExecution(event, snapshot);
    const context = this.contexts.get(event.slug);
    if (!context) return this.state.decisions[event.slug] ?? null;
    await this.sampleContext(context, nowSeconds * 1_000);
    const existing = this.state.decisions[event.slug];
    if (existing) return existing;
    const secondsLeft = event.windowEnd - nowSeconds;
    if (secondsLeft > 300 || secondsLeft <= 0) return null;
    const ranked = rankBooks(snapshot.books);
    if (!ranked) return null;

    const sourceScores = this.sourceScores(
      this.contexts.get(event.slug)!,
      ranked.cheap,
      ranked.favorite,
      nowSeconds * 1_000,
    );
    const selected =
      sourceScores.get("brti")?.valid
        ? sourceScores.get("brti")!
        : this.state.coinbaseEligible && sourceScores.get("coinbase")?.valid
          ? sourceScores.get("coinbase")!
          : sourceScores.get("kalshi_proxy")?.valid
            ? sourceScores.get("kalshi_proxy")!
            : null;
    const burnIn =
      this.state.completeMarkets.length < this.config.ladderV10BurnInMarkets;
    const normalizationValid =
      this.state.volatilityP10 !== null &&
      this.state.volatilityP90 !== null &&
      this.state.volatilityP90 - this.state.volatilityP10 > EPSILON;
    const adaptive = !burnIn && normalizationValid && selected?.valid === true;
    const legacyV10TargetShares = adaptive
      ? favoriteTierForScore(
          selected.score,
          this.config.ladderV10ScoreLow,
          this.config.ladderV10ScoreHigh,
          this.config.ladderV10MidShares,
          this.config.ladderV10TargetShares,
        )
      : this.config.ladderV10TargetShares;
    const favoriteTargetShares = binaryFavoriteTarget(legacyV10TargetShares);
    const counterfactualFavorite = simulateFavorite(
      ranked.favorite,
      this.config.ladderV10FavoritePrice,
      FULL_FAVORITE_SHARES,
      snapshot,
    );
    const legacyCounterfactualFavorite =
      legacyV10TargetShares > 0
        ? simulateFavorite(
            ranked.favorite,
            this.config.ladderV10FavoritePrice,
            legacyV10TargetShares,
            snapshot,
          )
        : emptyFill();
    const expectedFavoriteFillPrice =
      counterfactualFavorite.size > EPSILON
        ? round(counterfactualFavorite.cost / counterfactualFavorite.size)
        : null;
    const tracking = initializeRungTracking(ranked.cheap);
    context.shadowRungTracking = tracking;
    const decision: LadderV10Decision = {
      marketSlug: event.slug,
      createdAt: new Date(nowSeconds * 1_000).toISOString(),
      scoreVersion: SCORE_VERSION,
      score: selected?.score ?? null,
      scoreValid: selected?.valid ?? false,
      source: selected?.source ?? "none",
      decisionReason: burnIn
        ? "burn_in"
        : adaptive
          ? "adaptive"
          : "v7_fallback",
      favoriteTargetShares,
      experimentVersion: BINARY_EXPERIMENT_VERSION,
      legacyV10TargetShares,
      binaryV10TargetShares: favoriteTargetShares,
      cheapTokenId: ranked.cheap.tokenId,
      favoriteTokenId: ranked.favorite.tokenId,
      features: selected?.features ?? null,
      rawFeatures: selected?.rawFeatures ?? null,
      counterfactualFavorite,
      legacyCounterfactualFavorite,
      expectedFavoriteFillPrice,
      dynamicCheapTarget: shadowDynamicCheapTarget(expectedFavoriteFillPrice),
      favoriteDepthAt80: ranked.favorite.asks
        .filter((level) => level.price <= this.config.ladderV10FavoritePrice + EPSILON)
        .reduce((sum, level) => sum + level.size, 0),
      vwap40: simulateVwap(ranked.favorite, 40),
      vwap80: simulateVwap(ranked.favorite, 80),
      vwap120: simulateVwap(ranked.favorite, 120),
      shadowMakerFeeRate: snapshot.makerFeeRate ?? 0,
      shadowFeeExponent: snapshot.takerFeeExponent,
      observedFills: [],
    };
    this.state.decisions[event.slug] = decision;
    if (selected?.features) {
      this.state.volatilitySamples.push(selected.features.volatilityRaw);
    }
    const comparison = this.compareSources(sourceScores, nowSeconds * 1_000);
    if (comparison) this.state.coinbaseComparisons.push(comparison);
    await this.persist();
    await this.appendEventLog({ event: "decision", decision });
    log("Ladder V10 regime decision frozen", {
      market: event.slug,
      score: decision.score,
      source: decision.source,
      decisionReason: decision.decisionReason,
      legacyV10TargetShares,
      binaryV10TargetShares: favoriteTargetShares,
      favoriteTargetShares,
    });
    return decision;
  }

  async handleSettlement(settlement: PaperSettlement): Promise<void> {
    const decision = this.state.decisions[settlement.marketSlug];
    if (!decision || decision.settledAt) return;
    const contextTracking = this.contexts.get(settlement.marketSlug)
      ?.shadowRungTracking;
    const tracking = contextTracking
      ? copyRungTracking(contextTracking)
      : decision.shadowRungTracking
        ? copyRungTracking(decision.shadowRungTracking)
        : null;
    const cheapFills = decision.observedFills.filter(
      (fill) => fill.tokenId === decision.cheapTokenId,
    );
    const cheapSize = cheapFills.reduce((sum, fill) => sum + fill.size, 0);
    const cheapCost = cheapFills.reduce(
      (sum, fill) => sum + fill.price * fill.size + fill.fee,
      0,
    );
    const favorite = decision.counterfactualFavorite;
    const payout =
      settlement.winningTokenId === decision.cheapTokenId
        ? cheapSize
        : settlement.winningTokenId === decision.favoriteTokenId
          ? favorite.size
          : 0;
    decision.actualPnl = settlement.realizedPnl;
    decision.counterfactualV7Pnl = round(
      payout - cheapCost - favorite.cost - favorite.fee,
    );
    if (
      decision.experimentVersion === BINARY_EXPERIMENT_VERSION &&
      decision.legacyV10TargetShares !== undefined &&
      decision.binaryV10TargetShares !== undefined
    ) {
      const masks: ShadowRungMasks = {
        eligible: tracking?.eligible ?? 0,
        crossed: tracking?.crossed ?? 0,
        queueCleared: tracking?.queueCleared ?? 0,
      };
      const favoritePrice = decision.expectedFavoriteFillPrice ?? null;
      const dangerTriggered =
        favoritePrice !== null &&
        favoritePrice >= 0.6 &&
        favoritePrice < 0.7;
      const dangerFavorite = dangerTriggered ? emptyFill() : favorite;
      const dangerPnl = shadowPnl({
        winningTokenId: settlement.winningTokenId,
        cheapTokenId: decision.cheapTokenId,
        favoriteTokenId: decision.favoriteTokenId,
        cheapSize,
        cheapCost,
        favorite: dangerFavorite,
      });
      const target = decision.dynamicCheapTarget ?? null;
      const fillState = classifyShadowCheapFill(target, tracking);
      const dynamicCheapFilled =
        fillState === "DEFINITE_FILL" || fillState === "QUEUE_FILL";
      const dynamicCheapSize = dynamicCheapFilled ? FULL_FAVORITE_SHARES : 0;
      const dynamicCheapFee =
        dynamicCheapFilled && target !== null
          ? dynamicCheapSize *
            (decision.shadowMakerFeeRate ?? 0) *
            Math.pow(
              target * (1 - target),
              decision.shadowFeeExponent ?? 1,
            )
          : 0;
      const dynamicCheapCost =
        target === null
          ? 0
          : dynamicCheapSize * target + dynamicCheapFee;
      const dynamicPnl = shadowPnl({
        winningTokenId: settlement.winningTokenId,
        cheapTokenId: decision.cheapTokenId,
        favoriteTokenId: decision.favoriteTokenId,
        cheapSize: dynamicCheapSize,
        cheapCost: dynamicCheapCost,
        favorite,
      });
      const legacyFavorite = decision.legacyCounterfactualFavorite ?? emptyFill();
      const legacyPnl = shadowPnl({
        winningTokenId: settlement.winningTokenId,
        cheapTokenId: decision.cheapTokenId,
        favoriteTokenId: decision.favoriteTokenId,
        cheapSize,
        cheapCost,
        favorite: legacyFavorite,
      });
      const actualFavoriteShares = decision.observedFills
        .filter((fill) => fill.tokenId === decision.favoriteTokenId)
        .reduce((sum, fill) => sum + fill.size, 0);
      decision.shadowResult = {
        marketSlug: decision.marketSlug,
        v10Score: decision.score,
        legacyV10TargetShares: decision.legacyV10TargetShares,
        binaryV10TargetShares: decision.binaryV10TargetShares,
        v10Actual: {
          favoriteShares: round(actualFavoriteShares),
          pnl: settlement.realizedPnl,
        },
        legacyV10: {
          favoriteShares: legacyFavorite.size,
          pnl: legacyPnl,
        },
        shadowV7: { pnl: decision.counterfactualV7Pnl },
        shadowDangerFilter: {
          triggered: dangerTriggered,
          favoritePrice,
          pnl: dangerPnl,
        },
        shadowDynamicCheap: {
          favoritePrice,
          cheapTarget: target,
          fillState,
          pnl: dynamicPnl,
        },
        rungMasks: masks,
        favoriteDepthAt80: round(decision.favoriteDepthAt80 ?? 0),
        vwap40: decision.vwap40 ?? null,
        vwap80: decision.vwap80 ?? null,
        vwap120: decision.vwap120 ?? null,
      };
      delete decision.shadowRungTracking;
    }
    decision.settledAt = settlement.settledAt;
    await this.persist();
    await this.appendEventLog({
      event: "settlement",
      marketSlug: settlement.marketSlug,
      settlement,
      decision: {
        score: decision.score,
        source: decision.source,
        decisionReason: decision.decisionReason,
        favoriteTargetShares: decision.favoriteTargetShares,
        actualPnl: decision.actualPnl,
        counterfactualV7Pnl: decision.counterfactualV7Pnl,
        shadowResult: decision.shadowResult,
      },
    });
    log("Ladder V10 settled comparison", {
      market: settlement.marketSlug,
      decisionReason: decision.decisionReason,
      score: decision.score,
      actualPnl: decision.actualPnl,
      counterfactualV7Pnl: decision.counterfactualV7Pnl,
      pnlDifference: round(
        decision.actualPnl - decision.counterfactualV7Pnl,
      ),
    });
  }

  snapshotState(): RegimeState {
    return structuredClone(this.state);
  }

  private removeContext(context: MarketContext): void {
    this.contexts.delete(context.event.slug);
    const ticker = context.event.market.externalMarketId ?? context.event.market.id;
    if (ticker && this.tickerToSlug.get(ticker) === context.event.slug) {
      this.tickerToSlug.delete(ticker);
    }
  }

  private addPoint(point: RegimePricePoint): void {
    const points = this.points.get(point.source)!;
    const second = Math.floor(point.timestampMs / 1_000);
    const last = points.at(-1);
    if (last && Math.floor(last.timestampMs / 1_000) === second) points.pop();
    points.push(point);
    const cutoff = point.timestampMs - 180_000;
    while (points[0] && points[0].timestampMs < cutoff) points.shift();
  }

  private async sampleContext(
    context: MarketContext,
    nowMs: number,
  ): Promise<void> {
    const second = Math.floor(nowMs / 1_000);
    if (context.lastSnapshotSecond === second) return;
    context.lastSnapshotSecond = second;
    const books = context.latestSnapshot?.books ?? context.books;
    if (books.length !== 2) return;
    context.books = cloneBooks(books);
    const up = books.find((book) => book.outcome.toLowerCase() === "up") ?? books[0]!;
    const ranked = rankBooks(books);
    if (!ranked) return;
    const upMid =
      up.bestBid !== null && up.bestAsk !== null
        ? (up.bestBid + up.bestAsk) / 2
        : up.bestBid ?? up.bestAsk;
    if (upMid !== null) {
      this.addPoint({ source: "kalshi_proxy", timestampMs: nowMs, price: upMid });
    }
    const bidDepth = topDepth(up.bids, up.bestBid);
    const askDepth = topDepth(up.asks, up.bestAsk);
    const ofi =
      context.lastBidDepth === null || context.lastAskDepth === null
        ? 0
        : bidDepth - context.lastBidDepth - (askDepth - context.lastAskDepth);
    context.lastBidDepth = bidDepth;
    context.lastAskDepth = askDepth;
    const sample: BookSample = {
      timestampMs: nowMs,
      upMid,
      cheapQueue: queueAt(ranked.cheap, this.config.ladderV10CheapPrice),
      yesBidDepth: bidDepth,
      yesAskDepth: askDepth,
      ofi,
      tradeFlow: context.pendingTradeFlow,
    };
    context.pendingTradeFlow = 0;
    context.bookSamples.push(sample);
    while (context.bookSamples[0]?.timestampMs < nowMs - 180_000) {
      context.bookSamples.shift();
    }
    context.sampleCount += 1;
    // Per-second samples are intentionally memory-only. The decision and
    // settlement records retain the analysis trail without VPS log growth.
  }

  private async appendEventLog(event: Record<string, unknown>): Promise<void> {
    this.snapshotQueue = this.snapshotQueue.then(async () => {
      await mkdir(dirname(this.eventLogPath), { recursive: true });
      await appendFile(
        this.eventLogPath,
        `${JSON.stringify({ timestamp: new Date(this.now()).toISOString(), ...event })}\n`,
        "utf8",
      );
    });
    await this.snapshotQueue;
  }

  private sourceScores(
    context: MarketContext,
    cheap: TokenBook,
    favorite: TokenBook,
    nowMs: number,
  ): Map<RegimePriceSource, OscillationScore> {
    const result = new Map<RegimePriceSource, OscillationScore>();
    for (const source of ["brti", "coinbase", "kalshi_proxy"] as const) {
      result.set(
        source,
        scoreOscillation({
          points: this.points.get(source) ?? [],
          bookSamples: context.bookSamples,
          books: context.books,
          cheap,
          favorite,
          nowMs,
          source,
          volatilityP10: this.state.volatilityP10,
          volatilityP90: this.state.volatilityP90,
          pairHistory: this.state.pairHistory.map((item) => item.paired),
          staleMs: this.config.ladderV10SourceStaleMs,
        }),
      );
    }
    return result;
  }

  private compareSources(
    scores: Map<RegimePriceSource, OscillationScore>,
    nowMs: number,
  ): CalibrationComparison | null {
    const brti = scores.get("brti");
    const coinbase = scores.get("coinbase");
    if (!brti?.valid || !coinbase?.valid) return null;
    const brtiReturns = fiveSecondReturns(this.points.get("brti") ?? [], nowMs, 120);
    const coinbaseReturns = fiveSecondReturns(
      this.points.get("coinbase") ?? [],
      nowMs,
      120,
    );
    const paired = brtiReturns
      .map((value, index) => ({ left: value, right: coinbaseReturns[index] }))
      .filter(
        (item): item is { left: number; right: number } =>
          item.right !== undefined &&
          Math.abs(item.left) >= 0.0001 &&
          Math.abs(item.right) >= 0.0001,
      );
    const agreement =
      paired.length === 0
        ? 0
        : paired.filter((item) => Math.sign(item.left) === Math.sign(item.right)).length /
          paired.length;
    const tier = (score: number): number =>
      score < this.config.ladderV10ScoreLow
        ? 0
        : score < this.config.ladderV10ScoreHigh
          ? 1
          : 2;
    return {
      coverage: Math.min(brti.coverage, coinbase.coverage),
      directionAgreement: agreement,
      correlation: correlation(
        paired.map((item) => item.left),
        paired.map((item) => item.right),
      ),
      pathTierAgreement: tier(brti.score) === tier(coinbase.score),
    };
  }

  private async finalizeMarket(context: MarketContext): Promise<void> {
    const decision = this.state.decisions[context.event.slug];
    const complete =
      context.firstObservedSecondsLeft >= 840 && context.sampleCount >= 570;
    if (complete && !this.state.completeMarkets.includes(context.event.slug)) {
      this.state.completeMarkets.push(context.event.slug);
    }
    if (decision) {
      if (
        decision.experimentVersion === BINARY_EXPERIMENT_VERSION &&
        context.shadowRungTracking
      ) {
        decision.shadowRungTracking = copyRungTracking(
          context.shadowRungTracking,
        );
      }
      const cheapSize = decision.observedFills
        .filter((fill) => fill.tokenId === decision.cheapTokenId)
        .reduce((sum, fill) => sum + fill.size, 0);
      this.state.pairHistory.push({
        marketSlug: context.event.slug,
        paired: cheapSize > EPSILON && decision.counterfactualFavorite.size > EPSILON,
      });
      this.state.pairHistory = this.state.pairHistory.slice(-32);
    }
    if (
      this.state.completeMarkets.length >= this.config.ladderV10BurnInMarkets &&
      this.state.volatilityP10 === null &&
      this.state.volatilitySamples.length >= this.config.ladderV10BurnInMarkets
    ) {
      this.state.volatilityP10 = percentile(this.state.volatilitySamples, 0.1);
      this.state.volatilityP90 = percentile(this.state.volatilitySamples, 0.9);
      const comparisons = this.state.coinbaseComparisons.slice(
        -this.config.ladderV10BurnInMarkets,
      );
      this.state.coinbaseEligible =
        comparisons.length >= this.config.ladderV10BurnInMarkets &&
        mean(comparisons.map((item) => item.coverage)) >= 0.95 &&
        mean(comparisons.map((item) => item.directionAgreement)) >= 0.8 &&
        mean(comparisons.map((item) => item.correlation)) >= 0.8 &&
        mean(comparisons.map((item) => (item.pathTierAgreement ? 1 : 0))) >= 0.8;
      log("Ladder V10 burn-in completed", {
        markets: this.state.completeMarkets.length,
        volatilityP10: this.state.volatilityP10,
        volatilityP90: this.state.volatilityP90,
        coinbaseEligible: this.state.coinbaseEligible,
      });
    }
    await this.persist();
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
