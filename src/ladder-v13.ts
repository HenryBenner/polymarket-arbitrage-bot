import { exactKalshiDepthCost, exactKalshiOrderFee } from "./kalshi-fees.js";
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
const MATERIAL_PROFIT_IMPROVEMENT_PER_SHARE = 0.005;
export const LADDER_V13_QUOTE_SHARES = 20;

export interface LadderV13OrderHazardContext {
  tokenId: string;
  queueAhead: number;
  distanceTicks: number;
  eligibleVolumePerSecond: number;
  quoteSize: number;
  horizonSeconds: number;
}

export interface LadderV13HazardEstimate {
  fillProbability: number;
  expectedFillSeconds: number;
  observations: number;
}

export interface LadderV13HazardObservation {
  context: LadderV13OrderHazardContext;
  exposureSeconds: number;
  filled: boolean;
  fillSeconds?: number;
}

export interface LadderV13HistoricalModel {
  estimate(context: LadderV13OrderHazardContext): LadderV13HazardEstimate;
  getObservationCount(): number;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function coldFillSeconds(context: LadderV13OrderHazardContext): number {
  const flow = Math.max(0.01, context.eligibleVolumePerSecond);
  return Math.max(0.25, (context.queueAhead + 0.5 * context.quoteSize) / flow);
}

/** Per-resting-order survival model. Cancelled orders contribute censored exposure. */
export class LadderV13FillHazardModel implements LadderV13HistoricalModel {
  private readonly observations: LadderV13HazardObservation[];

  constructor(observations: readonly LadderV13HazardObservation[] = []) {
    this.observations = observations.map((observation) => ({
      ...observation,
      context: { ...observation.context },
    }));
  }

  observe(observation: LadderV13HazardObservation): void {
    this.observations.push({
      ...observation,
      exposureSeconds: Math.max(0.01, observation.exposureSeconds),
      context: { ...observation.context },
    });
    if (this.observations.length > 10_000) this.observations.splice(0, 1_000);
  }

  estimate(context: LadderV13OrderHazardContext): LadderV13HazardEstimate {
    const baseline = coldFillSeconds(context);
    const comparable = this.observations.filter((observation) => {
      const candidate = observation.context;
      const sizeRatio = Math.max(candidate.quoteSize, context.quoteSize) /
        Math.max(EPSILON, Math.min(candidate.quoteSize, context.quoteSize));
      const flowRatio = Math.max(candidate.eligibleVolumePerSecond, context.eligibleVolumePerSecond, 0.01) /
        Math.max(0.01, Math.min(candidate.eligibleVolumePerSecond, context.eligibleVolumePerSecond));
      return candidate.tokenId === context.tokenId &&
        Math.abs(candidate.distanceTicks - context.distanceTicks) <= 2 &&
        sizeRatio <= 2 && flowRatio <= 4;
    });
    if (comparable.length === 0) {
      return {
        fillProbability: 1 - Math.exp(-context.horizonSeconds / baseline),
        expectedFillSeconds: baseline,
        observations: 0,
      };
    }
    const exposure = comparable.reduce(
      (sum, observation) => sum + Math.max(0.01, observation.exposureSeconds),
      baseline,
    );
    const fills = comparable.filter((observation) => observation.filled).length + 1;
    const empirical = exposure / fills;
    const expected = 0.7 * empirical + 0.3 * baseline;
    return {
      fillProbability: 1 - Math.exp(-context.horizonSeconds / expected),
      expectedFillSeconds: expected,
      observations: comparable.length,
    };
  }

  getObservationCount(): number {
    return this.observations.length;
  }

  toJSON(): LadderV13HazardObservation[] {
    return this.observations.map((observation) => ({
      ...observation,
      context: { ...observation.context },
    }));
  }
}

export interface LadderV13MarketFeatures {
  eligibleVolumePerSecondByToken: Record<string, number>;
}

export interface LadderV13Candidate {
  yesPrice: number;
  noPrice: number;
  size: number;
  pairEdge: number;
  pairProfit: number;
  pairCost: number;
  profitRate: number;
  residualRiskRate: number;
  expectedSecondsToPair: number;
  bothFillProbability: number;
  yesEstimate: LadderV13HazardEstimate;
  noEstimate: LadderV13HazardEstimate;
  yesContext: LadderV13OrderHazardContext;
  noContext: LadderV13OrderHazardContext;
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

function floorToTick(value: number, tick: number): number {
  return round(Math.floor((value + EPSILON) / tick) * tick, 4);
}

function midpoint(book: TokenBook): number | null {
  return book.bestBid === null || book.bestAsk === null
    ? null
    : (book.bestBid + book.bestAsk) / 2;
}

function microprice(book: TokenBook): number | null {
  if (book.bestBid === null || book.bestAsk === null) return null;
  const bidSize = book.bids[0]?.size ?? 0;
  const askSize = book.asks[0]?.size ?? 0;
  return bidSize + askSize <= EPSILON
    ? midpoint(book)
    : (book.bestAsk * bidSize + book.bestBid * askSize) / (bidSize + askSize);
}

export function ladderV13Center(yes: TokenBook, no: TokenBook): number | null {
  const yesCenter = microprice(yes);
  const noCenter = microprice(no);
  if (yesCenter === null && noCenter === null) return null;
  if (yesCenter === null) return clamp(1 - noCenter!, 0.01, 0.99);
  if (noCenter === null) return clamp(yesCenter, 0.01, 0.99);
  return clamp((yesCenter + 1 - noCenter) / 2, 0.01, 0.99);
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
  return round(fills.filter((fill) => fill.tokenId === tokenId).reduce(
    (sum, fill) => sum + ((fill.side ?? "BUY") === "SELL" ? -fill.size : fill.size),
    0,
  ));
}

function selectedLotCost(fills: readonly PaperFill[], tokenId: string, shares: number): number {
  let remaining = shares;
  let total = 0;
  const lots = fills
    .filter((fill) => fill.tokenId === tokenId && (fill.side ?? "BUY") === "BUY")
    .map((fill) => ({
      shares: fill.size,
      allIn: fill.price + (fill.size > EPSILON ? fill.fee / fill.size : 0),
    }))
    .sort((left, right) => right.allIn - left.allIn);
  for (const lot of lots) {
    const selected = Math.min(remaining, lot.shares);
    total += selected * lot.allIn;
    remaining = round(remaining - selected);
    if (remaining <= EPSILON) break;
  }
  return remaining <= EPSILON ? total : Number.POSITIVE_INFINITY;
}

function validMaker(book: TokenBook, price: number, size: number): boolean {
  return size > EPSILON && size + EPSILON >= book.minOrderSize &&
    price > 0 && price < 1 && price * size + EPSILON >= 1 &&
    book.bestAsk !== null && price + EPSILON < book.bestAsk;
}

function levels(book: TokenBook, tick: number): number[] {
  if (book.bestBid === null || book.bestAsk === null) return [];
  const result: number[] = [];
  for (let price = floorToTick(book.bestBid, tick); price < book.bestAsk - EPSILON; price = round(price + tick, 4)) {
    if (price > 0 && price < 1) result.push(price);
  }
  return result;
}

function queueAhead(book: TokenBook, price: number): number {
  return book.bids.filter((level) => Math.abs(level.price - price) <= EPSILON)
    .reduce((sum, level) => sum + level.size, 0);
}

function distanceTicks(book: TokenBook, price: number, tick: number): number {
  return Math.max(0, Math.round(((book.bestBid ?? price) - price) / tick));
}

function affordableSize(snapshot: MarketExecutionSnapshot, yesPrice: number, noPrice: number): number {
  const rate = snapshot.makerFeeRate ?? 0;
  const exponent = snapshot.takerFeeExponent;
  let size = Math.max(0, Math.floor(LADDER_V13_QUOTE_SHARES));
  while (size > 0) {
    const total = size * (yesPrice + noPrice) +
      exactKalshiOrderFee({ price: yesPrice, size, rate, exponent }) +
      exactKalshiOrderFee({ price: noPrice, size, rate, exponent });
    if (total <= snapshot.availableCash + EPSILON) return size;
    size -= 1;
  }
  return 0;
}

function candidate(
  snapshot: MarketExecutionSnapshot,
  yes: TokenBook,
  no: TokenBook,
  yesPrice: number,
  noPrice: number,
  size: number,
  secondsLeft: number,
  tick: number,
  model: LadderV13HistoricalModel,
  features: LadderV13MarketFeatures,
): LadderV13Candidate | null {
  if (!validMaker(yes, yesPrice, size) || !validMaker(no, noPrice, size)) return null;
  const rate = snapshot.makerFeeRate ?? 0;
  const exponent = snapshot.takerFeeExponent;
  const fee = exactKalshiOrderFee({ price: yesPrice, size, rate, exponent }) +
    exactKalshiOrderFee({ price: noPrice, size, rate, exponent });
  const pairCost = size * (yesPrice + noPrice) + fee;
  const pairProfit = size - pairCost;
  if (pairProfit <= EPSILON) return null;
  const horizon = Math.max(0.25, secondsLeft);
  const yesContext: LadderV13OrderHazardContext = {
    tokenId: yes.tokenId,
    queueAhead: queueAhead(yes, yesPrice),
    distanceTicks: distanceTicks(yes, yesPrice, tick),
    eligibleVolumePerSecond: features.eligibleVolumePerSecondByToken[yes.tokenId] ?? 0,
    quoteSize: size,
    horizonSeconds: horizon,
  };
  const noContext: LadderV13OrderHazardContext = {
    tokenId: no.tokenId,
    queueAhead: queueAhead(no, noPrice),
    distanceTicks: distanceTicks(no, noPrice, tick),
    eligibleVolumePerSecond: features.eligibleVolumePerSecondByToken[no.tokenId] ?? 0,
    quoteSize: size,
    horizonSeconds: horizon,
  };
  const yesEstimate = model.estimate(yesContext);
  const noEstimate = model.estimate(noContext);
  const both = yesEstimate.fillProbability * noEstimate.fillProbability;
  const seconds = Math.max(0.25, yesEstimate.expectedFillSeconds, noEstimate.expectedFillSeconds);
  const oneSided = yesEstimate.fillProbability * (1 - noEstimate.fillProbability) +
    noEstimate.fillProbability * (1 - yesEstimate.fillProbability);
  const residualRiskRate = oneSided * 0.05 * size / horizon;
  return {
    yesPrice,
    noPrice,
    size,
    pairEdge: round(pairProfit / size),
    pairProfit: round(pairProfit),
    pairCost: round(pairCost),
    profitRate: round(pairProfit * both / seconds - residualRiskRate),
    residualRiskRate: round(residualRiskRate),
    expectedSecondsToPair: seconds,
    bothFillProbability: both,
    yesEstimate,
    noEstimate,
    yesContext,
    noContext,
  };
}

function candidates(
  snapshot: MarketExecutionSnapshot,
  yes: TokenBook,
  no: TokenBook,
  secondsLeft: number,
  tick: number,
  model: LadderV13HistoricalModel,
  features: LadderV13MarketFeatures,
): LadderV13Candidate[] {
  const result: LadderV13Candidate[] = [];
  for (const yesPrice of levels(yes, tick)) {
    for (const noPrice of levels(no, tick)) {
      const size = affordableSize(snapshot, yesPrice, noPrice);
      const value = candidate(snapshot, yes, no, yesPrice, noPrice, size, secondsLeft, tick, model, features);
      if (value) result.push(value);
    }
  }
  const cold = model.getObservationCount() === 0;
  return result.sort((left, right) => cold
    ? (right.yesPrice + right.noPrice) - (left.yesPrice + left.noPrice) || right.pairProfit - left.pairProfit
    : right.profitRate - left.profitRate || right.pairProfit - left.pairProfit);
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
      : orderPolicy === "fok" ? "completion_taker" : "completion_maker",
    plannedAllInPairCost: pairCost,
    plannedNetEdgePerPair: pairCost === undefined ? undefined : round(1 - pairCost),
  };
}

function envelopeSafe(snapshot: MarketExecutionSnapshot, orders: readonly PaperOrder[]): boolean {
  const buys = orders.filter((order) => (order.side ?? "BUY") === "BUY" && role(order).startsWith("opening"));
  const tokens = [...new Set(buys.map((order) => order.tokenId))];
  if (tokens.length !== 2) return false;
  const byToken = tokens.map((tokenId) => buys.filter((order) => order.tokenId === tokenId));
  const size = Math.min(
    byToken[0]!.reduce((sum, order) => sum + order.remainingSize, 0),
    byToken[1]!.reduce((sum, order) => sum + order.remainingSize, 0),
  );
  if (size <= EPSILON) return false;
  const yesPrice = Math.max(...byToken[0]!.map((order) => order.limitPrice));
  const noPrice = Math.max(...byToken[1]!.map((order) => order.limitPrice));
  const fee = exactKalshiOrderFee({ price: yesPrice, size, rate: snapshot.makerFeeRate ?? 0, exponent: snapshot.takerFeeExponent }) +
    exactKalshiOrderFee({ price: noPrice, size, rate: snapshot.makerFeeRate ?? 0, exponent: snapshot.takerFeeExponent });
  return size * (yesPrice + noPrice) + fee < size - EPSILON;
}

function nextCycle(snapshot: MarketExecutionSnapshot): number {
  return snapshot.orders.filter((order) => role(order).startsWith("opening")).length / 2 + 1;
}

function priceEnvelopeSafe(
  snapshot: MarketExecutionSnapshot,
  yesPrice: number,
  noPrice: number,
  size: number,
): boolean {
  const fee = exactKalshiOrderFee({
    price: yesPrice, size, rate: snapshot.makerFeeRate ?? 0,
    exponent: snapshot.takerFeeExponent,
  }) + exactKalshiOrderFee({
    price: noPrice, size, rate: snapshot.makerFeeRate ?? 0,
    exponent: snapshot.takerFeeExponent,
  });
  return size * (yesPrice + noPrice) + fee < size - EPSILON;
}

export async function planLadderV13(
  tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  model: LadderV13HistoricalModel = new LadderV13FillHazardModel(),
  nowSeconds = Date.now() / 1_000,
  _allowFlatten = false,
  features: LadderV13MarketFeatures = { eligibleVolumePerSecondByToken: {} },
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
  const pairedCost = paired <= EPSILON || !yes || !no ? 0
    : selectedLotCost(fills, yes.tokenId, paired) + selectedLotCost(fills, no.tokenId, paired);
  const center = yes && no ? ladderV13Center(yes, no) : null;
  const base: LadderV13Plan = {
    cancelOrderIds: [], opportunities: [], flattenOpportunities: [],
    managementStage: "observing", center, adjustedCenter: center,
    selectedCandidate: null, candidates: [],
    yesFilledShares: yesShares, noFilledShares: noShares,
    pairedShares: paired, unpairedShares: unpaired,
    lockedPnl: round(paired - pairedCost), maximumCompletionPrice: null,
    plannedPairCost: null, requiredEdge: 0,
  };
  if (!yes || !no || center === null) {
    return { ...base, cancelOrderIds: openOrders.map((order) => order.id), managementStage: "invalid-book" };
  }
  if (secondsLeft <= 0) {
    return { ...base, cancelOrderIds: openOrders.map((order) => order.id), managementStage: "market-expired" };
  }

  if (unpaired > EPSILON) {
    const surplus = yesShares > noShares ? yes : no;
    const deficient = yesShares > noShares ? no : yes;
    const surplusOpen = openOrders.filter((order) => (order.side ?? "BUY") === "BUY" && order.tokenId === surplus.tokenId);
    if (surplusOpen.length) {
      return { ...base, cancelOrderIds: surplusOpen.map((order) => order.id), managementStage: "cancel-imbalance-increasing-orders" };
    }
    const completionOpen = openOrders.filter((order) => (order.side ?? "BUY") === "BUY" && order.tokenId === deficient.tokenId);
    const entryCost = selectedLotCost(fills, surplus.tokenId, unpaired);
    const taker = exactKalshiDepthCost({
      levels: deficient.asks, size: unpaired,
      rate: snapshot.takerFeeRate, exponent: snapshot.takerFeeExponent,
    });
    if (taker && entryCost + taker.total < unpaired - EPSILON) {
      const pairCost = (entryCost + taker.total) / unpaired;
      if (completionOpen.length) {
        return { ...base, cancelOrderIds: completionOpen.map((order) => order.id), plannedPairCost: pairCost, managementStage: "cancel-maker-before-fok" };
      }
      const key = `${V13_PREFIX}${event.slug}:completion-fok:${deficient.tokenId}:${unpaired}:${taker.limitPrice}`;
      if (!tracker.has(key) && !orders.some((order) => order.tradeKey === key)) {
        return {
          ...base, plannedPairCost: pairCost,
          opportunities: [opportunity(event, deficient, taker.limitPrice, unpaired, key, "completion-fok", "fok", pairCost)],
          managementStage: "profitable-fok-completion",
        };
      }
    }
    const tick = Number(tickSizeFromMarket(event.market));
    let makerPrice = 0;
    for (const price of levels(deficient, tick)) {
      const fee = exactKalshiOrderFee({ price, size: unpaired, rate: snapshot.makerFeeRate ?? 0, exponent: snapshot.takerFeeExponent });
      if (entryCost + price * unpaired + fee < unpaired - EPSILON) makerPrice = price;
    }
    base.maximumCompletionPrice = makerPrice || null;
    if (makerPrice > 0) base.plannedPairCost = (entryCost + makerPrice * unpaired + exactKalshiOrderFee({
      price: makerPrice, size: unpaired, rate: snapshot.makerFeeRate ?? 0, exponent: snapshot.takerFeeExponent,
    })) / unpaired;
    const matching = completionOpen.find((order) => order.orderPolicy === "post_only" &&
      Math.abs(order.limitPrice - makerPrice) <= EPSILON && Math.abs(order.remainingSize - unpaired) <= EPSILON);
    const stale = completionOpen.filter((order) => order.id !== matching?.id);
    if (stale.length) return { ...base, cancelOrderIds: stale.map((order) => order.id), managementStage: "replace-completion-maker" };
    if (matching) return { ...base, managementStage: "waiting-completion-maker" };
    if (validMaker(deficient, makerPrice, unpaired)) {
      const key = `${V13_PREFIX}${event.slug}:completion-maker:${deficient.tokenId}:${makerPrice}:${unpaired}:${orders.length + 1}`;
      return {
        ...base,
        opportunities: [opportunity(event, deficient, makerPrice, unpaired, key, "completion-maker", "post_only", base.plannedPairCost ?? undefined)],
        managementStage: "maker-completion",
      };
    }
    return { ...base, cancelOrderIds: completionOpen.map((order) => order.id), managementStage: "wait-profitable-completion" };
  }

  const tick = Number(tickSizeFromMarket(event.market));
  const available = candidates(snapshot, yes, no, secondsLeft, tick, model, features);
  const selected = available[0] ?? null;
  base.candidates = available;
  base.selectedCandidate = selected;
  const opening = openOrders.filter((order) => role(order).startsWith("opening"));
  if (!selected) {
    return { ...base, cancelOrderIds: envelopeSafe(snapshot, opening) ? [] : opening.map((order) => order.id), managementStage: "no-profitable-quote" };
  }
  if (opening.length) {
    if (!envelopeSafe(snapshot, opening)) {
      return { ...base, cancelOrderIds: opening.map((order) => order.id), managementStage: "unsafe-pair-envelope" };
    }
    const highestByToken = new Map<string, number>();
    for (const order of opening) highestByToken.set(order.tokenId, Math.max(highestByToken.get(order.tokenId) ?? 0, order.limitPrice));
    const currentYes = highestByToken.get(yes.tokenId) ?? 0;
    const currentNo = highestByToken.get(no.tokenId) ?? 0;
    const currentSize = Math.min(...opening.map((order) => order.remainingSize));
    const current = candidate(snapshot, yes, no, currentYes, currentNo, currentSize, secondsLeft, tick, model, features);
    const materiallyBetter = current && selected.profitRate > current.profitRate * 1.5 + 0.00001 &&
      selected.pairProfit > current.pairProfit + MATERIAL_PROFIT_IMPROVEMENT_PER_SHARE * currentSize;
    const distinct = Math.abs(selected.yesPrice - currentYes) > EPSILON ||
      Math.abs(selected.noPrice - currentNo) > EPSILON;
    const combinedYes = Math.max(currentYes, selected.yesPrice);
    const combinedNo = Math.max(currentNo, selected.noPrice);
    if (
      materiallyBetter && distinct &&
      priceEnvelopeSafe(snapshot, combinedYes, combinedNo, selected.size)
    ) {
      const cycle = nextCycle(snapshot);
      const pairCost = selected.pairCost / selected.size;
      const yesKey = `${V13_PREFIX}${event.slug}:opening:yes:${cycle}:${selected.yesPrice}:${selected.size}`;
      const noKey = `${V13_PREFIX}${event.slug}:opening:no:${cycle}:${selected.noPrice}:${selected.size}`;
      return {
        ...base,
        opportunities: [
          opportunity(event, yes, selected.yesPrice, selected.size, yesKey, `opening-yes:${cycle}`, "post_only", pairCost),
          opportunity(event, no, selected.noPrice, selected.size, noKey, `opening-no:${cycle}`, "post_only", pairCost),
        ],
        managementStage: "batch-overlapping-improved-pair",
      };
    }
    return { ...base, managementStage: "sticky-profitable-quotes" };
  }

  const cycle = nextCycle(snapshot);
  const pairCost = selected.pairCost / selected.size;
  const yesKey = `${V13_PREFIX}${event.slug}:opening:yes:${cycle}:${selected.yesPrice}:${selected.size}`;
  const noKey = `${V13_PREFIX}${event.slug}:opening:no:${cycle}:${selected.noPrice}:${selected.size}`;
  if (tracker.has(yesKey) || tracker.has(noKey)) return { ...base, managementStage: "waiting-batch-opening" };
  return {
    ...base,
    opportunities: [
      opportunity(event, yes, selected.yesPrice, selected.size, yesKey, `opening-yes:${cycle}`, "post_only", pairCost),
      opportunity(event, no, selected.noPrice, selected.size, noKey, `opening-no:${cycle}`, "post_only", pairCost),
    ],
    managementStage: "batch-opening-pair",
  };
}
