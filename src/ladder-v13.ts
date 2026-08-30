import { LadderTracker } from "./ladder.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";

const EPSILON = 1e-8;
const V13_PREFIX = "ladder-v13:";

export const LADDER_V13_MAX_PAIRED_SHARES = 40;
export const LADDER_V13_MAX_UNPAIRED_SHARES = 10;
export const LADDER_V13_LATE_MAX_UNPAIRED_SHARES = 5;
export const LADDER_V13_CANDIDATE_EDGES = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1] as const;
export const LADDER_V13_BASE_EDGE = 0.02;

export interface LadderV13QuoteContext {
  secondsLeft: number;
  halfSpread: number;
  bookSpread: number;
  queueAhead: number;
  volatility: number;
  imbalance: number;
  orderFlow: number;
  quoteSize: number;
}

export interface LadderV13MarketFeatures {
  volatility: number;
  orderFlow: number;
}

export interface LadderV13FillEstimate {
  both: number;
  yesOnly: number;
  noOnly: number;
  neither: number;
  yesUnwindLoss: number;
  noUnwindLoss: number;
  expectedSecondsToPair: number;
  observations: number;
}

export interface LadderV13HistoricalModel {
  estimate(context: LadderV13QuoteContext): LadderV13FillEstimate;
}

export interface LadderV13HistoricalObservation {
  context: LadderV13QuoteContext;
  outcome: "both" | "yesOnly" | "noOnly" | "neither";
  unwindLoss?: number;
  secondsToPair?: number;
}

export interface LadderV13BayesianBucket {
  both: number;
  yesOnly: number;
  noOnly: number;
  neither: number;
  yesUnwindLossTotal: number;
  yesUnwindCount: number;
  noUnwindLossTotal: number;
  noUnwindCount: number;
  pairSecondsTotal: number;
  pairSecondsCount: number;
}

/**
 * A compact, serializable historical model. Buckets cover every V13 feature;
 * the Dirichlet prior is deliberately conservative so a cold start chooses a
 * deeper rung, while real observations quickly dominate it.
 */
export class LadderV13BayesianModel implements LadderV13HistoricalModel {
  private readonly buckets = new Map<string, LadderV13BayesianBucket>();

  constructor(
    state: Record<string, LadderV13BayesianBucket> = {},
    private readonly prior = { both: 2, yesOnly: 1, noOnly: 1, neither: 2 },
  ) {
    for (const [key, value] of Object.entries(state)) {
      this.buckets.set(key, { ...value });
    }
  }

  observe(observation: LadderV13HistoricalObservation): void {
    const key = historicalBucket(observation.context);
    const bucket = this.buckets.get(key) ?? emptyBucket();
    bucket[observation.outcome] += 1;
    if (observation.outcome === "yesOnly" && observation.unwindLoss !== undefined) {
      bucket.yesUnwindLossTotal += Math.max(0, observation.unwindLoss);
      bucket.yesUnwindCount += 1;
    }
    if (observation.outcome === "noOnly" && observation.unwindLoss !== undefined) {
      bucket.noUnwindLossTotal += Math.max(0, observation.unwindLoss);
      bucket.noUnwindCount += 1;
    }
    if (observation.outcome === "both" && observation.secondsToPair !== undefined) {
      bucket.pairSecondsTotal += Math.max(1, observation.secondsToPair);
      bucket.pairSecondsCount += 1;
    }
    this.buckets.set(key, bucket);
  }

  estimate(context: LadderV13QuoteContext): LadderV13FillEstimate {
    const bucket = this.buckets.get(historicalBucket(context)) ?? emptyBucket();
    const total =
      bucket.both + bucket.yesOnly + bucket.noOnly + bucket.neither;
    const denominator =
      total + this.prior.both + this.prior.yesOnly +
      this.prior.noOnly + this.prior.neither;
    return {
      both: (bucket.both + this.prior.both) / denominator,
      yesOnly: (bucket.yesOnly + this.prior.yesOnly) / denominator,
      noOnly: (bucket.noOnly + this.prior.noOnly) / denominator,
      neither: (bucket.neither + this.prior.neither) / denominator,
      yesUnwindLoss: bucket.yesUnwindCount > 0
        ? bucket.yesUnwindLossTotal / bucket.yesUnwindCount
        : 0.05,
      noUnwindLoss: bucket.noUnwindCount > 0
        ? bucket.noUnwindLossTotal / bucket.noUnwindCount
        : 0.05,
      expectedSecondsToPair: bucket.pairSecondsCount > 0
        ? bucket.pairSecondsTotal / bucket.pairSecondsCount
        : Math.min(480, 45 + context.halfSpread * 3_000),
      observations: total,
    };
  }

  toJSON(): Record<string, LadderV13BayesianBucket> {
    return Object.fromEntries(
      [...this.buckets].map(([key, value]) => [key, { ...value }]),
    );
  }
}

export interface LadderV13Candidate {
  edgeRung: number;
  yesPrice: number;
  noPrice: number;
  pairEdge: number;
  requiredEdge: number;
  expectedValue: number;
  expectedSecondsToPair: number;
  efficiency: number;
  capitalEfficiency: number;
  estimate: LadderV13FillEstimate;
  context: LadderV13QuoteContext;
}

export interface LadderV13Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  flattenOpportunities: TradeOpportunity[];
  managementStage: string;
  center: number | null;
  adjustedCenter: number | null;
  selectedCandidate: LadderV13Candidate | null;
  candidates: LadderV13Candidate[];
  yesFilledShares: number;
  noFilledShares: number;
  pairedShares: number;
  unpairedShares: number;
  lockedPnl: number;
  maximumCompletionPrice: number | null;
  plannedPairCost: number | null;
  requiredEdge: number;
}

function emptyBucket(): LadderV13BayesianBucket {
  return {
    both: 0,
    yesOnly: 0,
    noOnly: 0,
    neither: 0,
    yesUnwindLossTotal: 0,
    yesUnwindCount: 0,
    noUnwindLossTotal: 0,
    noUnwindCount: 0,
    pairSecondsTotal: 0,
    pairSecondsCount: 0,
  };
}

function bin(value: number, width: number): number {
  return Math.round(value / width) * width;
}

function historicalBucket(context: LadderV13QuoteContext): string {
  const time = context.secondsLeft > 180 ? "early" : context.secondsLeft > 60 ? "late" : "final";
  return [
    time,
    bin(context.halfSpread, 0.01).toFixed(2),
    bin(context.bookSpread, 0.02).toFixed(2),
    bin(context.queueAhead, 10).toFixed(0),
    bin(context.volatility, 0.01).toFixed(2),
    bin(context.imbalance, 0.25).toFixed(2),
    bin(context.orderFlow, 0.25).toFixed(2),
    bin(context.quoteSize, 5).toFixed(0),
  ].join("|");
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorToTick(value: number, tick: number): number {
  return round(Math.floor((value + EPSILON) / tick) * tick, 4);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function isV13Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V13_PREFIX) ?? false;
}

function role(order: PaperOrder): string {
  return isV13Order(order) ? (order.pairId ?? "").slice(V13_PREFIX.length) : "";
}

function strategyFills(snapshot: MarketExecutionSnapshot): PaperFill[] {
  const ids = new Set(snapshot.orders.filter(isV13Order).map((order) => order.id));
  return snapshot.fills.filter((fill) => ids.has(fill.orderId));
}

function tokenShares(fills: readonly PaperFill[], tokenId: string): number {
  return round(
    fills.filter((fill) => fill.tokenId === tokenId)
      .reduce(
        (sum, fill) => sum + ((fill.side ?? "BUY") === "SELL" ? -fill.size : fill.size),
        0,
      ),
  );
}

function selectedLotCost(
  fills: readonly PaperFill[],
  tokenId: string,
  shares: number,
  consumeCheapest: boolean,
): number {
  let remaining = shares;
  let total = 0;
  const lots = fills
    .filter(
      (fill) => fill.tokenId === tokenId && (fill.side ?? "BUY") === "BUY",
    )
    .map((fill) => ({
      shares: fill.size,
      allIn: fill.price + (fill.size > EPSILON ? fill.fee / fill.size : 0),
    }))
    .sort((left, right) =>
      consumeCheapest ? left.allIn - right.allIn : right.allIn - left.allIn,
    );
  for (const lot of lots) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, lot.shares);
    total += selected * lot.allIn;
    remaining = round(remaining - selected);
  }
  return remaining <= EPSILON ? total : Number.POSITIVE_INFINITY;
}

function feePerShare(price: number, rate: number, exponent: number): number {
  return rate * Math.pow(price * (1 - price), exponent);
}

function midpoint(book: TokenBook): number | null {
  if (book.bestBid === null || book.bestAsk === null) return null;
  return (book.bestBid + book.bestAsk) / 2;
}

function microprice(book: TokenBook): number | null {
  if (book.bestBid === null || book.bestAsk === null) return null;
  const bidSize = book.bids[0]?.size ?? 0;
  const askSize = book.asks[0]?.size ?? 0;
  if (bidSize + askSize <= EPSILON) return midpoint(book);
  return (
    book.bestAsk * bidSize + book.bestBid * askSize
  ) / (bidSize + askSize);
}

/** Returns the common YES-space center, averaging both complementary books. */
export function ladderV13Center(yes: TokenBook, no: TokenBook): number | null {
  const yesCenter = microprice(yes);
  const noCenter = microprice(no);
  if (yesCenter === null && noCenter === null) return null;
  if (yesCenter === null) return clamp(1 - noCenter!, 0.01, 0.99);
  if (noCenter === null) return clamp(yesCenter, 0.01, 0.99);
  return clamp((yesCenter + (1 - noCenter)) / 2, 0.01, 0.99);
}

function bookImbalance(yes: TokenBook): number {
  const bid = yes.bids[0]?.size ?? 0;
  const ask = yes.asks[0]?.size ?? 0;
  return bid + ask <= EPSILON ? 0 : (bid - ask) / (bid + ask);
}

function requiredEdge(secondsLeft: number, unpaired: number): number {
  const timeRisk = secondsLeft <= 60 ? 0.03 : secondsLeft <= 180 ? 0.01 : 0;
  const inventoryRisk = 0.02 * clamp(unpaired / LADDER_V13_MAX_UNPAIRED_SHARES, 0, 1);
  return round(LADDER_V13_BASE_EDGE + timeRisk + inventoryRisk, 4);
}

function inventorySkew(secondsLeft: number, inventory: number): number {
  const lambda = secondsLeft <= 60 ? 0.08 : secondsLeft <= 180 ? 0.06 : 0.04;
  return lambda * inventory / LADDER_V13_MAX_UNPAIRED_SHARES;
}

function validMaker(book: TokenBook, price: number, size: number): boolean {
  return (
    size > EPSILON &&
    size + EPSILON >= book.minOrderSize &&
    price > 0 && price < 1 &&
    price * size + EPSILON >= 1 &&
    book.bestAsk !== null && price + EPSILON < book.bestAsk
  );
}

function exactAskCost(
  snapshot: MarketExecutionSnapshot,
  book: TokenBook,
  shares: number,
): { total: number; limit: number } | null {
  let remaining = shares;
  let total = 0;
  let limit = 0;
  for (const ask of [...book.asks].sort((left, right) => left.price - right.price)) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, ask.size);
    if (selected <= EPSILON) continue;
    total += selected * (
      ask.price + feePerShare(ask.price, snapshot.takerFeeRate, snapshot.takerFeeExponent)
    );
    limit = ask.price;
    remaining = round(remaining - selected);
  }
  return remaining <= EPSILON && limit > 0 ? { total, limit } : null;
}

function exactBidProceeds(
  snapshot: MarketExecutionSnapshot,
  book: TokenBook,
  shares: number,
): { total: number; limit: number } | null {
  let remaining = shares;
  let total = 0;
  let limit = 1;
  for (const bid of [...book.bids].sort((left, right) => right.price - left.price)) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, bid.size);
    if (selected <= EPSILON) continue;
    total += selected * (
      bid.price - feePerShare(bid.price, snapshot.takerFeeRate, snapshot.takerFeeExponent)
    );
    limit = bid.price;
    remaining = round(remaining - selected);
  }
  return remaining <= EPSILON && limit < 1 ? { total, limit } : null;
}

function opportunity(
  event: UpDownEvent,
  token: TokenBook,
  price: number,
  size: number,
  tradeKey: string,
  orderRole: string,
  orderPolicy: NonNullable<TradeOpportunity["orderPolicy"]>,
  pairCost?: number,
): TradeOpportunity {
  return {
    kind: orderPolicy === "post_only" ? "maker" : "expensive",
    event,
    token,
    price,
    size,
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    strategyMode: "ladder_v13",
    phaseId: "15-0",
    pairId: `${V13_PREFIX}${orderRole}`,
    orderPolicy,
    pairLockRole: orderRole.startsWith("opening")
      ? "opening"
      : orderPolicy === "fok"
        ? "completion_taker"
        : "completion_maker",
    plannedAllInPairCost: pairCost,
    plannedNetEdgePerPair: pairCost === undefined ? undefined : round(1 - pairCost),
  };
}

function candidateQuotes(
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  yes: TokenBook,
  no: TokenBook,
  adjustedCenter: number,
  size: number,
  secondsLeft: number,
  model: LadderV13HistoricalModel,
  marketFeatures: LadderV13MarketFeatures,
): LadderV13Candidate[] {
  const tick = Number(tickSizeFromMarket(event.market));
  const makerRate = snapshot.makerFeeRate ?? 0;
  const exponent = snapshot.takerFeeExponent;
  const bookSpread = yes.bestAsk !== null && yes.bestBid !== null
    ? yes.bestAsk - yes.bestBid
    : 0;
  const imbalance = bookImbalance(yes);
  const requirement = requiredEdge(secondsLeft, 0);
  const candidates: LadderV13Candidate[] = [];
  for (const edgeRung of LADDER_V13_CANDIDATE_EDGES) {
    const halfSpread = edgeRung / 2;
    const yesPrice = floorToTick(adjustedCenter - halfSpread, tick);
    const noPrice = floorToTick(1 - adjustedCenter - halfSpread, tick);
    if (!validMaker(yes, yesPrice, size) || !validMaker(no, noPrice, size)) continue;
    const pairCost =
      yesPrice + noPrice +
      feePerShare(yesPrice, makerRate, exponent) +
      feePerShare(noPrice, makerRate, exponent);
    const pairEdge = round(1 - pairCost);
    if (pairEdge + EPSILON < requirement) continue;
    const context: LadderV13QuoteContext = {
      secondsLeft,
      halfSpread,
      bookSpread,
      queueAhead: [yes, no].reduce(
        (sum, book, index) => sum + book.bids
          .filter((level) => Math.abs(level.price - (index === 0 ? yesPrice : noPrice)) <= EPSILON)
          .reduce((levelSum, level) => levelSum + level.size, 0),
        0,
      ),
      volatility: marketFeatures.volatility,
      imbalance,
      orderFlow: marketFeatures.orderFlow,
      quoteSize: size,
    };
    const estimate = model.estimate(context);
    const expectedValue =
      estimate.both * pairEdge -
      estimate.yesOnly * estimate.yesUnwindLoss -
      estimate.noOnly * estimate.noUnwindLoss;
    if (expectedValue <= 0) continue;
    const expectedSeconds = Math.max(1, estimate.expectedSecondsToPair);
    const capitalAtRisk = Math.max(EPSILON, size * pairCost);
    candidates.push({
      edgeRung,
      yesPrice,
      noPrice,
      pairEdge,
      requiredEdge: requirement,
      expectedValue: round(expectedValue),
      expectedSecondsToPair: expectedSeconds,
      efficiency: expectedValue / expectedSeconds,
      capitalEfficiency: expectedValue / (capitalAtRisk * expectedSeconds),
      estimate,
      context,
    });
  }
  return candidates.sort(
    (left, right) =>
      right.expectedValue - left.expectedValue ||
      right.capitalEfficiency - left.capitalEfficiency,
  );
}

function sameOpening(
  order: PaperOrder,
  tokenId: string,
  price: number,
  size: number,
): boolean {
  return (
    role(order).startsWith("opening") &&
    order.tokenId === tokenId &&
    Math.abs(order.limitPrice - price) <= EPSILON &&
    Math.abs(order.remainingSize - size) <= EPSILON &&
    order.orderPolicy === "post_only"
  );
}

function nextSequence(snapshot: MarketExecutionSnapshot, prefix: string): number {
  return snapshot.orders.filter((order) => order.tradeKey.startsWith(prefix)).length + 1;
}

export async function planLadderV13(
  tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  model: LadderV13HistoricalModel = new LadderV13BayesianModel(),
  nowSeconds = Date.now() / 1_000,
  allowFlatten = false,
  marketFeatures: LadderV13MarketFeatures = { volatility: 0, orderFlow: 0 },
): Promise<LadderV13Plan> {
  const orders = snapshot.orders.filter(isV13Order);
  const openOrders = snapshot.openOrders.filter(isV13Order);
  const fills = strategyFills(snapshot);
  const books = [...snapshot.books].sort((left, right) => left.outcomeIndex - right.outcomeIndex);
  const yes = books[0];
  const no = books[1];
  const secondsLeft = event.windowEnd - nowSeconds;
  const yesShares = yes ? tokenShares(fills, yes.tokenId) : 0;
  const noShares = no ? tokenShares(fills, no.tokenId) : 0;
  const paired = round(Math.min(yesShares, noShares));
  const unpaired = round(Math.abs(yesShares - noShares));
  const pairedCost = paired <= EPSILON
    ? 0
    : selectedLotCost(fills, yes!.tokenId, paired, true) +
      selectedLotCost(fills, no!.tokenId, paired, true);
  const center = yes && no ? ladderV13Center(yes, no) : null;
  const inventory = yesShares - noShares;
  const adjustedCenter = center === null
    ? null
    : clamp(center - inventorySkew(secondsLeft, inventory), 0.01, 0.99);
  const base: LadderV13Plan = {
    cancelOrderIds: [],
    opportunities: [],
    flattenOpportunities: [],
    managementStage: "observing",
    center,
    adjustedCenter,
    selectedCandidate: null,
    candidates: [],
    yesFilledShares: yesShares,
    noFilledShares: noShares,
    pairedShares: paired,
    unpairedShares: unpaired,
    lockedPnl: round(paired - pairedCost),
    maximumCompletionPrice: null,
    plannedPairCost: null,
    requiredEdge: requiredEdge(secondsLeft, unpaired),
  };

  if (!yes || !no || center === null || adjustedCenter === null) {
    return {
      ...base,
      cancelOrderIds: openOrders.map((order) => order.id),
      managementStage: "invalid-book",
    };
  }
  if (secondsLeft <= 0) {
    return {
      ...base,
      cancelOrderIds: openOrders.map((order) => order.id),
      managementStage: "market-expired",
    };
  }
  if (
    paired > LADDER_V13_MAX_PAIRED_SHARES + EPSILON ||
    unpaired > LADDER_V13_MAX_UNPAIRED_SHARES + EPSILON
  ) {
    return {
      ...base,
      cancelOrderIds: openOrders.map((order) => order.id),
      managementStage: "inventory-invariant-blocked",
    };
  }

  // Once either side gets ahead, every order which could increase that side
  // is cancelled before a completion order is calculated from confirmed fills.
  if (unpaired > EPSILON) {
    const surplus = inventory > 0 ? yes : no;
    const deficient = inventory > 0 ? no : yes;
    const surplusOpen = openOrders.filter(
      (order) => (order.side ?? "BUY") === "BUY" && order.tokenId === surplus.tokenId,
    );
    if (surplusOpen.length > 0) {
      return {
        ...base,
        cancelOrderIds: surplusOpen.map((order) => order.id),
        managementStage: "cancel-imbalance-increasing-orders",
      };
    }
    const completionOpen = openOrders.filter(
      (order) => (order.side ?? "BUY") === "BUY" && order.tokenId === deficient.tokenId,
    );
    // Match the cheapest lots first and price completion against the remaining
    // expensive lots. This is conservative when fills from several cycles differ.
    const surplusCost = selectedLotCost(
      fills,
      surplus.tokenId,
      unpaired,
      false,
    ) / unpaired;
    const completionSize = unpaired;
    const required = requiredEdge(secondsLeft, unpaired);
    const takerDepth = exactAskCost(snapshot, deficient, completionSize);
    if (takerDepth) {
      const pairCost = surplusCost + takerDepth.total / completionSize;
      base.plannedPairCost = round(pairCost);
      if (pairCost <= 1 - required + EPSILON) {
        if (completionOpen.length > 0) {
          return {
            ...base,
            cancelOrderIds: completionOpen.map((order) => order.id),
            managementStage: "cancel-maker-before-fok",
          };
        }
        const signature = deficient.asks
          .filter((level) => level.price <= takerDepth.limit + EPSILON)
          .map((level) => `${level.price}:${level.size}`).join("|");
        const key = `${V13_PREFIX}${event.slug}:completion-fok:${deficient.tokenId}:${completionSize}:${signature}`;
        if (!tracker.has(key) && !orders.some((order) => order.tradeKey === key)) {
          return {
            ...base,
            opportunities: [opportunity(
              event,
              deficient,
              takerDepth.limit,
              completionSize,
              key,
              "completion-fok",
              "fok",
              pairCost,
            )],
            managementStage: "profitable-fok-completion",
          };
        }
      }
    }

    if (secondsLeft <= 15 && allowFlatten) {
      const sale = exactBidProceeds(snapshot, surplus, completionSize);
      if (sale && sale.limit * completionSize + EPSILON >= 1) {
        const signature = surplus.bids
          .filter((level) => level.price + EPSILON >= sale.limit)
          .map((level) => `${level.price}:${level.size}`).join("|");
        const key = `${V13_PREFIX}${event.slug}:flatten:${surplus.tokenId}:${completionSize}:${signature}`;
        if (!tracker.has(key) && !orders.some((order) => order.tradeKey === key)) {
          return {
            ...base,
            cancelOrderIds: completionOpen.map((order) => order.id),
            flattenOpportunities: completionOpen.length > 0
              ? []
              : [opportunity(
                  event,
                  surplus,
                  sale.limit,
                  completionSize,
                  key,
                  "flatten",
                  "fok",
                )],
            managementStage: completionOpen.length > 0
              ? "cancel-completion-before-flatten"
              : "final-seconds-flatten-residual",
          };
        }
      }
    }

    const tick = Number(tickSizeFromMarket(event.market));
    const makerRate = snapshot.makerFeeRate ?? 0;
    let maximum = floorToTick(1 - required - surplusCost, tick);
    while (
      maximum > tick &&
      surplusCost + maximum + feePerShare(maximum, makerRate, snapshot.takerFeeExponent) >
        1 - required + EPSILON
    ) {
      maximum = floorToTick(maximum - tick, tick);
    }
    const makerPrice = floorToTick(
      Math.min(maximum, (deficient.bestAsk ?? 0) - tick),
      tick,
    );
    base.maximumCompletionPrice = maximum > 0 ? maximum : null;
    base.plannedPairCost = makerPrice > 0
      ? round(surplusCost + makerPrice + feePerShare(
          makerPrice,
          makerRate,
          snapshot.takerFeeExponent,
        ))
      : base.plannedPairCost;
    const matching = completionOpen.find(
      (order) =>
        order.orderPolicy === "post_only" &&
        Math.abs(order.limitPrice - makerPrice) <= EPSILON &&
        Math.abs(order.remainingSize - completionSize) <= EPSILON,
    );
    const stale = completionOpen.filter((order) => order.id !== matching?.id);
    if (stale.length > 0) {
      return {
        ...base,
        cancelOrderIds: stale.map((order) => order.id),
        managementStage: "replace-completion-maker",
      };
    }
    if (matching) return { ...base, managementStage: "waiting-completion-maker" };
    if (validMaker(deficient, makerPrice, completionSize)) {
      const prefix = `${V13_PREFIX}${event.slug}:completion-maker:${deficient.tokenId}:`;
      const key = `${prefix}${makerPrice}:${completionSize}:${nextSequence(snapshot, prefix)}`;
      return {
        ...base,
        opportunities: [opportunity(
          event,
          deficient,
          makerPrice,
          completionSize,
          key,
          "completion-maker",
          "post_only",
          base.plannedPairCost ?? undefined,
        )],
        managementStage: secondsLeft <= 60
          ? "final-minute-profitable-completion-only"
          : "maker-completion",
      };
    }

    // V13 never turns a failed profitable completion into a directional bet.
    // In the final minute all resting exposure is removed; the executor may
    // later add a reduce-only sell path without changing pair construction.
    return {
      ...base,
      cancelOrderIds: completionOpen.map((order) => order.id),
      managementStage: secondsLeft <= 60
        ? "final-minute-unmatched-no-profitable-exit"
        : "wait-profitable-completion",
    };
  }

  if (secondsLeft <= 60 || paired >= LADDER_V13_MAX_PAIRED_SHARES - EPSILON) {
    return {
      ...base,
      cancelOrderIds: openOrders.map((order) => order.id),
      managementStage: secondsLeft <= 60 ? "final-minute-no-new-inventory" : "pair-cap-reached",
    };
  }

  const unmatchedLimit = secondsLeft <= 180
    ? LADDER_V13_LATE_MAX_UNPAIRED_SHARES
    : LADDER_V13_MAX_UNPAIRED_SHARES;
  const quoteSize = round(Math.min(
    unmatchedLimit,
    LADDER_V13_MAX_PAIRED_SHARES - paired,
  ));
  const candidates = candidateQuotes(
    event,
    snapshot,
    yes,
    no,
    adjustedCenter,
    quoteSize,
    secondsLeft,
    model,
    marketFeatures,
  );
  const selected = candidates[0] ?? null;
  base.candidates = candidates;
  base.selectedCandidate = selected;
  if (!selected) {
    return {
      ...base,
      cancelOrderIds: openOrders.map((order) => order.id),
      managementStage: "no-positive-ev-rung",
    };
  }

  const desired = [
    { book: yes, price: selected.yesPrice, label: "yes" },
    { book: no, price: selected.noPrice, label: "no" },
  ];
  const matching = desired.map((quote) =>
    openOrders.find((order) => sameOpening(order, quote.book.tokenId, quote.price, quoteSize)),
  );
  const matchingIds = new Set(matching.filter(Boolean).map((order) => order!.id));
  const stale = openOrders.filter(
    (order) => role(order).startsWith("opening") && !matchingIds.has(order.id),
  );
  if (stale.length > 0) {
    return {
      ...base,
      cancelOrderIds: stale.map((order) => order.id),
      managementStage: "requote-selected-rung",
    };
  }
  const missing = matching.findIndex((order) => order === undefined);
  if (missing < 0) return { ...base, managementStage: "quoting-selected-rung" };
  const quote = desired[missing]!;
  const prefix = `${V13_PREFIX}${event.slug}:opening:${quote.label}:`;
  const key = `${prefix}${selected.edgeRung}:${quote.price}:${quoteSize}:${nextSequence(snapshot, prefix)}`;
  if (tracker.has(key)) return { ...base, managementStage: "waiting-selected-rung" };
  return {
    ...base,
    opportunities: [opportunity(
      event,
      quote.book,
      quote.price,
      quoteSize,
      key,
      `opening-${quote.label}`,
      "post_only",
      1 - selected.pairEdge,
    )],
    managementStage: `post-${quote.label}-maker`,
  };
}
