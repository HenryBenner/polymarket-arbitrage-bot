import type { BotConfig } from "./config.js";
import {
  exactKalshiDepthCost,
  exactKalshiDepthProceeds,
  exactKalshiOrderFee,
} from "./kalshi-fees.js";
import { ladderV14Inventory } from "./ladder-v14-inventory.js";
import {
  ladderV14DistancePenalty,
  ladderV14EffectiveFlow,
  type LadderV14ConditionalContext,
  type LadderV14ConditionalModel,
} from "./ladder-v14-model.js";
import type {
  MarketExecutionSnapshot,
  PaperOrder,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";

const EPSILON = 1e-8;
const V14_PREFIX = "ladder-v14:";
const round = (value: number, places = 8): number => {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export interface LadderV14MarketFeatures {
  eligibleVolumePerSecondByToken: Record<string, number>;
  volatilityByToken: Record<string, number>;
  midpointByToken: Record<string, number | null>;
}

export interface LadderV14Candidate {
  selectionMode: "ev" | "volume";
  priorityScore: number;
  tokenId: string;
  outcome: string;
  price: number;
  size: number;
  expectedValue: number;
  marginalValue: number;
  expectedValuePerShare: number;
  expectedProfitRate: number;
  expectedExposureSeconds: number;
  fillProbability: number;
  pairProbability: number;
  expectedCompletionCost: number;
  expectedFailedExit: number;
  sweepPrefixShares: number;
  context: LadderV14ConditionalContext;
  quantityOptions: LadderV14QuantityOption[];
}

export interface LadderV14QuantityOption {
  size: number;
  expectedValue: number;
  marginalValue: number;
  expectedValuePerShare: number;
  expectedProfitRate: number;
  expectedExposureSeconds: number;
  context: LadderV14ConditionalContext;
}

export interface LadderV14Amendment {
  orderId: string;
  opportunity: TradeOpportunity;
}

export interface LadderV14ResidualDecision {
  action: "hedge" | "sell" | "wait";
  size: number;
  hedgeValue: number | null;
  sellValue: number | null;
  waitValue: number;
  context: LadderV14ConditionalContext;
}

export interface LadderV14PlacementContext {
  kind: "fill" | "completion" | "failed_exit";
  context: LadderV14ConditionalContext;
}

export interface LadderV14Plan {
  nextWakeAtMs?: number;
  cancelOrderIds: string[];
  amendments: LadderV14Amendment[];
  opportunities: TradeOpportunity[];
  flattenOpportunities: TradeOpportunity[];
  managementStage: string;
  candidates: LadderV14Candidate[];
  residualDecisions: LadderV14ResidualDecision[];
  placementContexts: Record<string, LadderV14PlacementContext>;
  pairedShares: number;
  unpairedShares: number;
  lockedPnl: number;
  expectedPortfolioValue: number;
  bestEvaluatedCandidate: LadderV14Candidate | null;
}

function isV14Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V14_PREFIX) ?? false;
}

function midpoint(book: TokenBook): number | null {
  return book.bestBid === null || book.bestAsk === null
    ? null
    : (book.bestBid + book.bestAsk) / 2;
}

function series(event: UpDownEvent): string {
  return (
    event.market.seriesTicker ??
    event.slug.split("-")[0] ??
    "GLOBAL15M"
  ).toUpperCase();
}

function queueAhead(book: TokenBook, price: number): number {
  return book.bids
    .filter((level) => Math.abs(level.price - price) <= EPSILON)
    .reduce((sum, level) => sum + level.size, 0);
}

function depthAtOrBetter(book: TokenBook, price: number): number {
  return book.bids
    .filter((level) => level.price + EPSILON >= price)
    .reduce((sum, level) => sum + Math.max(0, level.size), 0);
}

function flowReferenceDepth(book: TokenBook, price: number): number {
  const touchDepth = book.bestBid === null
    ? 0
    : book.bids
      .filter((level) => Math.abs(level.price - book.bestBid!) <= EPSILON)
      .reduce((sum, level) => sum + Math.max(0, level.size), 0);
  return Math.max(touchDepth, depthAtOrBetter(book, price));
}

function expectedMinimumTime(hazard: number, horizonSeconds: number): number {
  const horizon = Math.max(0, horizonSeconds);
  if (horizon <= EPSILON) return 0;
  if (hazard <= EPSILON) return horizon;
  return (1 - Math.exp(-hazard * horizon)) / hazard;
}

function contextFor(
  config: BotConfig,
  event: UpDownEvent,
  book: TokenBook,
  price: number,
  quantity: number,
  queue: number,
  distanceTicks: number,
  secondsRemaining: number,
  features: LadderV14MarketFeatures,
  overrides: Partial<LadderV14ConditionalContext> = {},
): LadderV14ConditionalContext {
  const currentMid = features.midpointByToken[book.tokenId] ?? midpoint(book);
  return {
    series: series(event),
    executionMode: config.executionMode,
    side: book.outcome,
    entryPrice: price,
    currentBid: book.bestBid,
    currentMid,
    priceMoveSinceFill: currentMid === null ? 0 : currentMid - price,
    volatility: features.volatilityByToken[book.tokenId] ?? 0,
    queueAhead: queue,
    flowPerSecond:
      features.eligibleVolumePerSecondByToken[book.tokenId] ?? 0,
    distanceTicks,
    quantity,
    depth: depthAtOrBetter(book, price),
    residualAgeSeconds: 0,
    secondsRemaining: Math.max(0, secondsRemaining),
    ...overrides,
  };
}

function makerPrices(book: TokenBook, tick: number): number[] {
  if (book.bestAsk === null) return [];
  const result: number[] = [];
  for (
    let price = tick;
    price < book.bestAsk - EPSILON && price < 1;
    price = round(price + tick, 4)
  ) {
    result.push(price);
  }
  return result.reverse();
}

export function pairedMakerPrices(
  books: readonly TokenBook[],
  tick: number,
  targetPairCost: number,
): [number, number] | null {
  if (!Number.isFinite(tick) || tick <= 0 || books.some(book => book.bestAsk === null)) return null;
  const ceilings = books.map(book => Math.floor((Math.min(1, book.bestAsk!) - EPSILON) / tick));
  const [left, right] = ceilings as [number, number];
  if (left < 1 || right < 1) return null;
  const total = Math.min(left + right, Math.floor((targetPairCost + EPSILON) / tick));
  if (total < 2) return null;
  const concessions = left + right - total;
  // Maximize combined price, split concessions equally, prefer higher YES on ties.
  const leftConcession = Math.min(left - 1, Math.max(
    concessions - (right - 1), Math.floor(concessions / 2),
  ));
  return [round((left - leftConcession) * tick, 4),
    round((right - (concessions - leftConcession)) * tick, 4)];
}

function quantityBreakpoints(
  config: BotConfig,
  event: UpDownEvent,
  book: TokenBook,
  opposite: TokenBook,
  price: number,
  sweepPrefixShares: number,
  secondsRemaining: number,
  tick: number,
  features: LadderV14MarketFeatures,
): number[] {
  const minimum = Math.max(
    0.01,
    Math.ceil((book.minOrderSize - EPSILON) * 100) / 100,
  );
  const bookBreakpoints = [
    ...book.bids,
    ...opposite.asks,
    ...book.asks,
  ].reduce<number[]>((values, level) => {
    const next = (values.at(-1) ?? 0) + Math.max(0, level.size);
    if (next > EPSILON) values.push(next);
    return values;
  }, []);
  const queue = queueAhead(book, price);
  const distanceTicks = Math.max(
    0,
    Math.round(((book.bestBid ?? price) - price) / tick),
  );
  const reachabilityContext = contextFor(
    config,
    event,
    book,
    price,
    minimum,
    queue,
    distanceTicks,
    secondsRemaining,
    features,
    { depth: flowReferenceDepth(book, price) },
  );
  const effectiveFlow = ladderV14EffectiveFlow(reachabilityContext, {
    flowWindowSeconds: config.ladderV14FlowWindowSeconds,
    pseudoFlowDepthFraction: config.ladderV14PseudoFlowDepthFraction,
  });
  const quoteLifetime = Math.min(
    Math.max(0, secondsRemaining),
    config.ladderV14QuoteLifetimeSeconds,
  );
  const grossReachable = effectiveFlow * quoteLifetime *
    ladderV14DistancePenalty(distanceTicks) *
    config.ladderV14ReachabilityMultiplier;
  const queueBurden = queue +
    config.ladderV14QuantityQueueWeight * Math.max(0, sweepPrefixShares);
  const physicalHorizon = grossReachable <= EPSILON
    ? 0
    : grossReachable / (1 + queueBurden / grossReachable);
  if (physicalHorizon + EPSILON < minimum) return [];
  const result = new Set<number>([round(minimum, 2)]);
  for (const value of bookBreakpoints) {
    if (
      value + EPSILON >= minimum &&
      value <= physicalHorizon + EPSILON
    ) result.add(round(value, 2));
  }
  let magnitude = 1;
  while (magnitude <= physicalHorizon * 10 + EPSILON) {
    for (const multiplier of [1, 2, 5]) {
      const quantity = multiplier * magnitude;
      if (quantity + EPSILON >= minimum && quantity <= physicalHorizon + EPSILON) {
        result.add(round(quantity, 2));
      }
    }
    magnitude *= 10;
  }
  result.add(round(physicalHorizon, 2));
  return [...result]
    .filter((value) => Number.isFinite(value) && value + EPSILON >= minimum)
    .sort((left, right) => left - right);
}

function openingCandidate(
  config: BotConfig,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  book: TokenBook,
  opposite: TokenBook,
  price: number,
  quantity: number,
  sweepPrefixShares: number,
  secondsRemaining: number,
  tick: number,
  features: LadderV14MarketFeatures,
  model: LadderV14ConditionalModel,
): LadderV14Candidate | null {
  if (quantity <= EPSILON || book.bestAsk === null || price >= book.bestAsk - EPSILON) {
    return null;
  }
  const conditionalQuantity = quantity + sweepPrefixShares;
  const makerFee = exactKalshiOrderFee({
    price,
    size: quantity,
    rate: snapshot.makerFeeRate ?? 0,
    exponent: snapshot.takerFeeExponent,
  });
  const entryAllIn = price + makerFee / quantity;
  const distance = Math.max(
    0,
    Math.round(((book.bestBid ?? price) - price) / tick),
  );
  const context = contextFor(
    config,
    event,
    book,
    entryAllIn,
    quantity,
    queueAhead(book, price),
    distance,
    secondsRemaining,
    features,
    { depth: flowReferenceDepth(book, price) },
  );
  const quoteLifetime = Math.min(
    secondsRemaining,
    config.ladderV14QuoteLifetimeSeconds,
  );
  const fill = model.estimateFill(context, quoteLifetime);

  const completionMakerPrice = opposite.bestAsk === null
    ? opposite.bestBid
    : Math.max(tick, round(opposite.bestAsk - tick, 4));
  if (completionMakerPrice === null) return null;
  const completionQueue = queueAhead(opposite, completionMakerPrice);
  const completionContext: LadderV14ConditionalContext = {
    ...context,
    quantity: conditionalQuantity,
    queueAhead: completionQueue,
    flowPerSecond:
      features.eligibleVolumePerSecondByToken[opposite.tokenId] ?? 0,
    distanceTicks: Math.max(
      0,
      Math.round(((opposite.bestBid ?? completionMakerPrice) - completionMakerPrice) / tick),
    ),
    depth: flowReferenceDepth(opposite, completionMakerPrice),
  };
  const completion = model.estimateCompletion(
    completionContext,
    secondsRemaining,
  );
  const makerCompletionFee = exactKalshiOrderFee({
    price: completionMakerPrice,
    size: conditionalQuantity,
    rate: snapshot.makerFeeRate ?? 0,
    exponent: snapshot.takerFeeExponent,
  });
  // The completion probability is for this passive opposite-side maker
  // order, so its conditional cost must use the same maker price. Pricing a
  // successful maker fill at the current taker ask made cold-start EV
  // systematically too pessimistic and could suppress every opening quote.
  const fallbackCompletionCost =
    completionMakerPrice + makerCompletionFee / conditionalQuantity;
  const expectedCompletionCost = model.expectedCompletionCost(
    completionContext,
    fallbackCompletionCost,
  );
  const exitDepth = exactKalshiDepthProceeds({
    levels: book.bids,
    size: conditionalQuantity,
    rate: snapshot.takerFeeRate,
    exponent: snapshot.takerFeeExponent,
  });
  // A passive bid filling is adverse information: book liquidity currently
  // above the quote cannot be assumed to survive the event that reaches it.
  // Real residual management switches to the actual post-fill market state.
  const hypotheticalExitBid = exitDepth
    ? Math.min(entryAllIn, exitDepth.total / conditionalQuantity)
    : 0;
  const hypotheticalMid = context.currentMid === null
    ? entryAllIn
    : Math.min(context.currentMid, entryAllIn + tick);
  const exitContext = {
    ...context,
    currentBid: hypotheticalExitBid,
    currentMid: hypotheticalMid,
    priceMoveSinceFill: hypotheticalMid - entryAllIn,
    depth: exitDepth?.size ?? 0,
  };
  const expectedFailedExit = model.expectedFailedExit(exitContext);
  const pairProfit = 1 - entryAllIn - expectedCompletionCost;
  const exitProfit = expectedFailedExit - entryAllIn;
  const filledValuePerShare =
    completion.probability * pairProfit +
    (1 - completion.probability) * exitProfit;
  // Quantity is the new marginal layer. Probabilities and recovery are
  // conditioned on every more-aggressive layer having swept first.
  const expectedValue = fill.probability * filledValuePerShare * quantity;
  const restingExposure = expectedMinimumTime(fill.hazard, quoteLifetime);
  const postFillExposure = expectedMinimumTime(
    completion.hazard,
    secondsRemaining,
  );
  const expectedExposureSeconds = restingExposure +
    fill.probability * postFillExposure;
  const committedCapital = Math.max(EPSILON, entryAllIn * quantity);
  const expectedProfitRate = expectedValue /
    (committedCapital * Math.max(EPSILON, expectedExposureSeconds));
  return {
    selectionMode: "ev",
    priorityScore: expectedProfitRate,
    tokenId: book.tokenId,
    outcome: book.outcome,
    price,
    size: quantity,
    expectedValue,
    marginalValue: expectedValue,
    expectedValuePerShare: expectedValue / quantity,
    expectedProfitRate,
    expectedExposureSeconds,
    fillProbability: fill.probability,
    pairProbability: completion.probability,
    expectedCompletionCost,
    expectedFailedExit,
    sweepPrefixShares,
    context,
    quantityOptions: [],
  };
}

function selectVolumeFirstTargets(
  config: BotConfig,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  books: readonly TokenBook[],
  secondsRemaining: number,
  tick: number,
  features: LadderV14MarketFeatures,
  model: LadderV14ConditionalModel,
): {
  selected: LadderV14Candidate[];
  bestEvaluated: LadderV14Candidate | null;
} {
  const selected: LadderV14Candidate[] = [];
  const sweepByToken = new Map<string, number>();
  const usedPairs = new Set<string>();
  let bestEvaluated: LadderV14Candidate | null = null;
  for (let level = 0; level < config.ladderV14VolumeFirstLevels; level += 1) {
    const targetPairCost = round(
      config.ladderV14VolumeFirstPairCost -
        level * config.ladderV14VolumeFirstPairStep,
      4,
    );
    if (targetPairCost < tick * 2 - EPSILON) break;
    const prices = pairedMakerPrices(books, tick, targetPairCost);
    if (!prices) continue;
    const pairKey = `${prices[0]}|${prices[1]}`;
    if (usedPairs.has(pairKey)) continue;
    usedPairs.add(pairKey);
    for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
      const book = books[sideIndex]!;
      const opposite = books[1 - sideIndex]!;
      const existingIndex = selected.findIndex(candidate => candidate.tokenId === book.tokenId &&
        Math.abs(candidate.price - prices[sideIndex]!) <= EPSILON);
      const existing = selected[existingIndex];
      const quantity = round(
        config.ladderV14VolumeFirstBaseShares * 2 ** level + (existing?.size ?? 0),
        2,
      );
      const sweepPrefix = existing?.sweepPrefixShares ?? sweepByToken.get(book.tokenId) ?? 0;
      const candidate = openingCandidate(
        config,
        event,
        snapshot,
        book,
        opposite,
        prices[sideIndex]!,
        quantity,
        sweepPrefix,
        secondsRemaining,
        tick,
        features,
        model,
      );
      if (!candidate) continue;
      candidate.selectionMode = "volume";
      candidate.priorityScore =
        Math.max(config.ladderV14VolumeFirstLevels - level,
          Math.floor((existing?.priorityScore ?? 0) / 1_000_000)) * 1_000_000 +
        candidate.fillProbability;
      candidate.quantityOptions = [{
        size: candidate.size,
        expectedValue: candidate.expectedValue,
        marginalValue: candidate.marginalValue,
        expectedValuePerShare: candidate.expectedValuePerShare,
        expectedProfitRate: candidate.expectedProfitRate,
        expectedExposureSeconds: candidate.expectedExposureSeconds,
        context: candidate.context,
      }];
      // Tick/price boundaries can collapse levels onto one side's price.
      // Competing target sizes at that key would amend the same order forever.
      if (existingIndex >= 0) selected[existingIndex] = candidate;
      else selected.push(candidate);
      sweepByToken.set(book.tokenId, sweepPrefix + candidate.size);
      if (
        !bestEvaluated ||
        candidate.expectedValue > bestEvaluated.expectedValue
      ) bestEvaluated = candidate;
    }
  }
  return {
    selected: selected.sort(
      (left, right) => right.priorityScore - left.priorityScore,
    ),
    bestEvaluated,
  };
}

function selectOpeningTargets(
  config: BotConfig,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  books: readonly TokenBook[],
  secondsRemaining: number,
  tick: number,
  features: LadderV14MarketFeatures,
  model: LadderV14ConditionalModel,
): {
  selected: LadderV14Candidate[];
  bestEvaluated: LadderV14Candidate | null;
} {
  const selected: LadderV14Candidate[] = [];
  let bestEvaluated: LadderV14Candidate | null = null;
  for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
    const book = books[sideIndex]!;
    const opposite = books[1 - sideIndex]!;
    let sweepPrefix = 0;
    for (const price of makerPrices(book, tick)) {
      const breakpoints = quantityBreakpoints(
        config,
        event,
        book,
        opposite,
        price,
        sweepPrefix,
        secondsRemaining,
        tick,
        features,
      );
      let previousValue = 0;
      let best: LadderV14Candidate | null = null;
      let marginalChainPositive = true;
      const options: LadderV14QuantityOption[] = [];
      for (const quantity of breakpoints) {
        const candidate = openingCandidate(
          config,
          event,
          snapshot,
          book,
          opposite,
          price,
          quantity,
          sweepPrefix,
          secondsRemaining,
          tick,
          features,
          model,
        );
        if (!candidate) continue;
        if (
          !bestEvaluated ||
          candidate.expectedValue > bestEvaluated.expectedValue
        ) {
          bestEvaluated = candidate;
        }
        candidate.marginalValue = candidate.expectedValue - previousValue;
        previousValue = candidate.expectedValue;
        const marginalPositive = candidate.marginalValue > EPSILON;
        if (!marginalPositive) marginalChainPositive = false;
        if (marginalChainPositive && marginalPositive) {
          options.push({
            size: candidate.size,
            expectedValue: candidate.expectedValue,
            marginalValue: candidate.marginalValue,
            expectedValuePerShare: candidate.expectedValuePerShare,
            expectedProfitRate: candidate.expectedProfitRate,
            expectedExposureSeconds: candidate.expectedExposureSeconds,
            context: candidate.context,
          });
        }
        // A cumulative size is eligible only when every segment needed to
        // reach it has strictly positive marginal portfolio EV.
        if (marginalChainPositive && marginalPositive) {
          best = candidate;
        }
      }
      if (best) {
        best.quantityOptions = options.filter(
          (option) => option.size <= best!.size + EPSILON,
        );
        selected.push(best);
        sweepPrefix += best.size;
      }
    }
  }
  return { selected, bestEvaluated };
}

function opportunity(
  event: UpDownEvent,
  token: TokenBook,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  policy: "post_only" | "fak",
  role: string,
  tradeKey: string,
): TradeOpportunity {
  return {
    kind: policy === "post_only" ? "maker" : "expensive",
    event,
    token,
    price,
    size,
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    strategyMode: "ladder_v14",
    phaseId: "15-0",
    pairId: `${V14_PREFIX}${role}`,
    orderPolicy: policy,
    pairLockRole: side === "BUY"
      ? role === "opening"
        ? "opening"
        : policy === "post_only" ? "completion_maker" : "completion_taker"
      : undefined,
    capitalEffect: role === "opening" ? "increase" : "reduce",
  };
}

function planResidual(
  config: BotConfig,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  books: readonly TokenBook[],
  features: LadderV14MarketFeatures,
  model: LadderV14ConditionalModel,
  nowSeconds: number,
): Pick<LadderV14Plan,
  "cancelOrderIds" | "opportunities" | "flattenOpportunities" |
  "managementStage" | "residualDecisions" | "placementContexts"> {
  const inventory = ladderV14Inventory(snapshot, nowSeconds);
  const episode = inventory.episode!;
  const surplus = books.find((book) => book.tokenId === episode.surplusTokenId)!;
  const deficient = books.find((book) => book.tokenId !== episode.surplusTokenId)!;
  const secondsRemaining = Math.max(0, event.windowEnd - nowSeconds);
  const tick = Number(tickSizeFromMarket(event.market));
  const open = snapshot.openOrders.filter(isV14Order);
  const decisions: LadderV14ResidualDecision[] = [];
  let waitSize = 0;
  let remaining = inventory.unpairedShares;
  const breakpoints = new Set<number>();
  for (const levels of [surplus.bids, deficient.asks]) {
    let cumulative = 0;
    for (const level of levels) {
      cumulative += Math.max(0, level.size);
      if (cumulative > EPSILON) breakpoints.add(Math.min(remaining, cumulative));
    }
  }
  let lotCumulative = 0;
  for (const lot of inventory.residualLots) {
    lotCumulative += lot.size;
    breakpoints.add(Math.min(remaining, lotCumulative));
  }
  if (breakpoints.size === 0) breakpoints.add(remaining);
  let consumed = 0;
  for (const end of [...breakpoints].sort((left, right) => left - right)) {
    const size = round(Math.min(remaining - consumed, end - consumed), 2);
    if (size <= EPSILON) continue;
    let lotOffset = 0;
    const lot = inventory.residualLots.find((candidate) => {
      lotOffset += candidate.size;
      return consumed < lotOffset - EPSILON;
    }) ?? inventory.residualLots.at(-1)!;
    const sell = exactKalshiDepthProceeds({
      levels: surplus.bids,
      size: consumed + size,
      rate: snapshot.takerFeeRate,
      exponent: snapshot.takerFeeExponent,
    });
    const hedge = exactKalshiDepthCost({
      levels: deficient.asks,
      size: consumed + size,
      rate: snapshot.takerFeeRate,
      exponent: snapshot.takerFeeExponent,
    });
    const priorSell = consumed <= EPSILON ? { total: 0 } : exactKalshiDepthProceeds({
      levels: surplus.bids,
      size: consumed,
      rate: snapshot.takerFeeRate,
      exponent: snapshot.takerFeeExponent,
    });
    const priorHedge = consumed <= EPSILON ? { total: 0 } : exactKalshiDepthCost({
      levels: deficient.asks,
      size: consumed,
      rate: snapshot.takerFeeRate,
      exponent: snapshot.takerFeeExponent,
    });
    const sellValue = sell && priorSell && sell.size + EPSILON >= consumed + size
      ? (sell.total - priorSell.total) / size
      : null;
    const hedgeValue = hedge && priorHedge
      ? 1 - (hedge.total - priorHedge.total) / size
      : null;
    const makerPrice = deficient.bestAsk === null
      ? deficient.bestBid
      : Math.max(tick, round(deficient.bestAsk - tick, 4));
    const currentMid = features.midpointByToken[surplus.tokenId] ?? midpoint(surplus);
    const context = contextFor(
      config,
      event,
      deficient,
      lot.allInPrice,
      size,
      makerPrice === null ? 0 : queueAhead(deficient, makerPrice),
      makerPrice === null
        ? 99
        : Math.max(0, Math.round(((deficient.bestBid ?? makerPrice) - makerPrice) / tick)),
      secondsRemaining,
      features,
      {
        side: surplus.outcome,
        entryPrice: lot.allInPrice,
        currentBid: sellValue,
        currentMid,
        priceMoveSinceFill: currentMid === null ? 0 : currentMid - lot.entryPrice,
        residualAgeSeconds: Math.max(0, nowSeconds - lot.filledAtMs / 1_000),
        depth: sell?.size ?? 0,
      },
    );
    const completion = model.estimateCompletion(context, secondsRemaining);
    const completionCost = makerPrice === null
      ? 1
      : model.expectedCompletionCost(context, makerPrice);
    const failedExit = model.expectedFailedExit(context);
    const waitValue = completion.probability * (1 - completionCost) +
      (1 - completion.probability) * failedExit;
    const cleanup = secondsRemaining <= config.ladderV14FinalCleanupSeconds;
    const choices = [
      ...(hedgeValue === null ? [] : [{ action: "hedge" as const, value: hedgeValue }]),
      ...(sellValue === null ? [] : [{ action: "sell" as const, value: sellValue }]),
      ...(cleanup ? [] : [{ action: "wait" as const, value: waitValue }]),
    ].sort((left, right) => right.value - left.value);
    const action = choices[0]?.action ?? "wait";
    decisions.push({ action, size, hedgeValue, sellValue, waitValue, context });
    if (action === "wait") waitSize += size;
    consumed += size;
    if (consumed + EPSILON >= remaining) break;
  }

  const immediate = decisions.find((decision) => decision.action !== "wait");
  if (immediate) {
    if (open.length > 0) {
      return {
        cancelOrderIds: open.map((order) => order.id),
        opportunities: [],
        flattenOpportunities: [],
        managementStage: "cancel-before-residual-action",
        residualDecisions: decisions,
        placementContexts: {},
      };
    }
    const role = immediate.action === "sell" ? "residual-sale" : "residual-hedge";
    const token = immediate.action === "sell" ? surplus : deficient;
    const depth = immediate.action === "sell"
      ? exactKalshiDepthProceeds({
          levels: surplus.bids,
          size: immediate.size,
          rate: snapshot.takerFeeRate,
          exponent: snapshot.takerFeeExponent,
        })
      : exactKalshiDepthCost({
          levels: deficient.asks,
          size: immediate.size,
          rate: snapshot.takerFeeRate,
          exponent: snapshot.takerFeeExponent,
        });
    if (depth) {
      const key = `${V14_PREFIX}${event.slug}:${role}:${episode.id}:${immediate.size}:${Math.floor(nowSeconds * 1000)}`;
      const order = opportunity(
        event,
        token,
        immediate.action === "sell" ? "SELL" : "BUY",
        depth.limitPrice,
        immediate.size,
        "fak",
        role,
        key,
      );
      return {
        cancelOrderIds: [],
        opportunities: immediate.action === "hedge" ? [order] : [],
        flattenOpportunities: immediate.action === "sell" ? [order] : [],
        managementStage: immediate.action === "sell"
          ? "marginal-residual-sale"
          : "economic-loss-locking-hedge",
        residualDecisions: decisions,
        placementContexts: {
          [key]: {
            kind: immediate.action === "hedge" ? "completion" : "failed_exit",
            context: immediate.context,
          },
        },
      };
    }
  }

  const makerPrice = deficient.bestAsk === null
    ? deficient.bestBid
    : Math.max(tick, round(deficient.bestAsk - tick, 4));
  if (waitSize > EPSILON && makerPrice !== null && makerPrice < (deficient.bestAsk ?? 1)) {
    const matching = open.filter((order) =>
      order.tokenId === deficient.tokenId &&
      Math.abs(order.limitPrice - makerPrice) <= EPSILON,
    );
    const desired = round(waitSize, 2);
    if (matching.length === 1 && Math.abs(matching[0]!.remainingSize - desired) <= EPSILON) {
      return { cancelOrderIds: [], opportunities: [], flattenOpportunities: [],
        managementStage: "waiting-positive-ev-completion", residualDecisions: decisions,
        placementContexts: {} };
    }
    if (open.length > 0) {
      return { cancelOrderIds: open.map((order) => order.id), opportunities: [],
        flattenOpportunities: [], managementStage: "replace-completion-maker",
        residualDecisions: decisions, placementContexts: {} };
    }
    const context = decisions.find((decision) => decision.action === "wait")!.context;
    const key = `${V14_PREFIX}${event.slug}:completion-maker:${makerPrice}:${desired}:${Math.floor(nowSeconds * 1000)}`;
    return {
      cancelOrderIds: [],
      opportunities: [opportunity(event, deficient, "BUY", makerPrice, desired,
        "post_only", "completion-maker", key)],
      flattenOpportunities: [],
      managementStage: "post-positive-ev-completion",
      residualDecisions: decisions,
      placementContexts: { [key]: { kind: "completion", context } },
    };
  }

  return { cancelOrderIds: open.map((order) => order.id), opportunities: [],
    flattenOpportunities: [], managementStage: "residual-no-executable-action",
    residualDecisions: decisions, placementContexts: {} };
}

/** Repair-only inventory; seek profitable completion until the cleanup deadline. */
function planVolumeFirstRepair(
  config: BotConfig,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  books: readonly TokenBook[],
  features: LadderV14MarketFeatures,
  nowSeconds: number,
): Pick<LadderV14Plan,
  "cancelOrderIds" | "opportunities" | "flattenOpportunities" |
  "managementStage" | "residualDecisions" | "placementContexts" | "nextWakeAtMs"> {
  const inventory = ladderV14Inventory(snapshot, nowSeconds);
  const episode = inventory.episode!;
  const surplus = books.find((book) => book.tokenId === episode.surplusTokenId)!;
  const missing = books.find((book) => book.tokenId !== surplus.tokenId)!;
  const open = snapshot.openOrders.filter(isV14Order);
  const quantity = inventory.unpairedShares;
  const entry = inventory.unpairedCost / quantity;
  const deadline = (event.windowEnd - config.ladderV14FinalCleanupSeconds) * 1_000;
  const waiting = nowSeconds * 1_000 < deadline;
  const result = {
    cancelOrderIds: [] as string[],
    opportunities: [] as TradeOpportunity[],
    flattenOpportunities: [] as TradeOpportunity[],
    managementStage: "volume-first-repair-no-executable-depth",
    residualDecisions: [] as LadderV14ResidualDecision[],
    placementContexts: {} as Record<string, LadderV14PlacementContext>,
    nextWakeAtMs: waiting ? deadline : undefined,
  };
  const makerRole = `repair-maker:${episode.id}`;
  // Old opening grids on EITHER side can flip/increase the imbalance. Wait
  // for cancellation reconciliation and then re-read R before submitting.
  if (open.some((order) => order.pairId !== `${V14_PREFIX}${makerRole}`)) {
    return { ...result, cancelOrderIds: open.map((order) => order.id),
      managementStage: "volume-first-repair-cancel-opening-grid" };
  }

  const askQuantity = Math.min(quantity, missing.asks.reduce((sum, level) =>
    sum + (Number.isFinite(level.size) && level.price > 0 && level.price < 1
      ? Math.max(0, level.size) : 0), 0));
  const buyDepth = (size: number) => exactKalshiDepthCost({
    levels: missing.asks.filter((level) => Number.isFinite(level.size) &&
      level.size > 0 && level.price > 0 && level.price < 1),
    size,
    rate: snapshot.takerFeeRate,
    exponent: snapshot.takerFeeExponent,
  });
  const sellDepth = (size: number) => exactKalshiDepthProceeds({
    levels: surplus.bids, size, rate: snapshot.takerFeeRate,
    exponent: snapshot.takerFeeExponent,
  });
  let hedge = askQuantity > EPSILON ? buyDepth(askQuantity) : null;
  let sale = sellDepth(quantity);
  let action: "hedge" | "sell" | null = null;
  let actionQuantity = askQuantity;
  if (hedge && 1 - entry - hedge.total / askQuantity > EPSILON) {
    action = "hedge";
    result.managementStage = "volume-first-repair-profitable-taker";
  } else if (!waiting) {
    // Compare executable values for the SAME quantity, not a full hedge
    // against a shallow partial sale. Replan any remainder after each fill.
    actionQuantity = hedge && sale ? Math.min(askQuantity, sale.size)
      : hedge ? askQuantity : sale?.size ?? 0;
    hedge = hedge && actionQuantity > EPSILON ? buyDepth(actionQuantity) : null;
    sale = sale && actionQuantity > EPSILON ? sellDepth(actionQuantity) : null;
    if (hedge || sale) {
      action = hedge && (!sale ||
        1 - hedge.total / actionQuantity + EPSILON >= sale.total / actionQuantity)
        ? "hedge" : "sell";
      result.managementStage = action === "hedge"
        ? "volume-first-repair-cleanup-hedge"
        : "volume-first-repair-cleanup-sale";
    }
  }
  const tick = Number(tickSizeFromMarket(event.market));
  const aggressivePrice = missing.bestAsk === null ? missing.bestBid
    : round(Math.floor((missing.bestAsk - EPSILON) / tick) * tick, 4);
  // The maker attempt must not itself lock a loss. Include the first leg's
  // fees and the new order's exact maker fees/rounding in the price ceiling.
  let makerPrice: number | null = null;
  for (let price = aggressivePrice ?? 0; price >= tick - EPSILON; price = round(price - tick, 4)) {
    const fee = exactKalshiOrderFee({price, size: quantity,
      rate: snapshot.makerFeeRate ?? config.kalshiMakerFeeRate, exponent: snapshot.takerFeeExponent});
    if (1 - entry - price - fee / quantity > EPSILON) { makerPrice = price; break; }
  }
  const context = contextFor(config, event, missing, entry, quantity,
    makerPrice === null ? 0 : queueAhead(missing, makerPrice), 0,
    event.windowEnd - nowSeconds, features, {
      side: surplus.outcome, currentBid: surplus.bestBid,
      currentMid: features.midpointByToken[surplus.tokenId] ?? midpoint(surplus),
      residualAgeSeconds: episode.residualAgeSeconds,
      priceMoveSinceFill: (midpoint(surplus) ?? entry) - entry,
    });
  if (action) {
    if (open.length > 0) return { ...result,
      cancelOrderIds: open.map((order) => order.id),
      managementStage: "volume-first-repair-cancel-before-exit" };
    const role = action === "hedge" ? "repair-taker" : "repair-sale";
    const depth = action === "hedge" ? hedge! : sale!;
    const key = `${V14_PREFIX}${event.slug}:${role}:${episode.id}:r${quantity}:q${actionQuantity}:${Math.floor(nowSeconds * 1000)}`;
    const target = opportunity(event, action === "hedge" ? missing : surplus,
      action === "hedge" ? "BUY" : "SELL", depth.limitPrice,
      actionQuantity, "fak", role, key);
    result.opportunities = action === "hedge" ? [target] : [];
    result.flattenOpportunities = action === "sell" ? [target] : [];
    result.placementContexts[key] = {
      kind: action === "hedge" ? "completion" : "failed_exit",
      context: { ...context, quantity: actionQuantity },
    };
    return result;
  }
  if (!waiting || makerPrice === null || makerPrice < tick || makerPrice >= 1 ||
    makerPrice >= (missing.bestAsk ?? 1)) {
    return { ...result, cancelOrderIds: open.map((order) => order.id) };
  }
  if (open.length === 1 && open[0]!.tokenId === missing.tokenId &&
    (open[0]!.side ?? "BUY") === "BUY" && open[0]!.orderPolicy === "post_only" &&
    Math.abs(open[0]!.limitPrice - makerPrice) <= EPSILON &&
    Math.abs(open[0]!.remainingSize - quantity) <= EPSILON) {
    return { ...result, managementStage: "volume-first-repair-maker-resting" };
  }
  if (open.length > 0) return { ...result,
    cancelOrderIds: open.map((order) => order.id),
    managementStage: "volume-first-repair-replace-maker" };
  const key = `${V14_PREFIX}${event.slug}:${makerRole}:${quantity}:${Math.floor(nowSeconds * 1000)}`;
  result.opportunities = [opportunity(event, missing, "BUY", makerPrice,
    quantity, "post_only", makerRole, key)];
  result.placementContexts[key] = { kind: "completion", context };
  result.managementStage = "volume-first-repair-post-maker";
  return result;
}

export function planLadderV14(
  config: BotConfig,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  model: LadderV14ConditionalModel,
  features: LadderV14MarketFeatures = {
    eligibleVolumePerSecondByToken: {},
    volatilityByToken: {},
    midpointByToken: {},
  },
  nowSeconds = Date.now() / 1_000,
): LadderV14Plan {
  const inventory = ladderV14Inventory(snapshot, nowSeconds);
  const open = snapshot.openOrders.filter(isV14Order);
  const base: LadderV14Plan = {
    cancelOrderIds: [],
    amendments: [],
    opportunities: [],
    flattenOpportunities: [],
    managementStage: "observing",
    candidates: [],
    residualDecisions: [],
    placementContexts: {},
    pairedShares: inventory.pairedShares,
    unpairedShares: inventory.unpairedShares,
    lockedPnl: inventory.lockedPnl,
    expectedPortfolioValue: 0,
    bestEvaluatedCandidate: null,
  };
  const books = [...snapshot.books].sort(
    (left, right) => left.outcomeIndex - right.outcomeIndex,
  );
  if (books.length !== 2 || snapshot.marketDataValid === false) {
    return { ...base, cancelOrderIds: open.map((order) => order.id),
      managementStage: "invalid-book" };
  }
  if (snapshot.executionPending) {
    return { ...base, managementStage: "await-execution-reconciliation" };
  }
  const secondsRemaining = event.windowEnd - nowSeconds;
  if (secondsRemaining <= 0) {
    return { ...base, cancelOrderIds: open.map((order) => order.id),
      managementStage: "market-expired" };
  }
  if (config.ladderV14VolumeFirstMode && inventory.unpairedShares > EPSILON) {
    return { ...base, ...planVolumeFirstRepair(
      config, event, snapshot, books, features, nowSeconds,
    ) };
  }
  if (
    config.ladderV14VolumeFirstMode &&
    secondsRemaining <= config.ladderV14FinalCleanupSeconds
  ) {
    return { ...base, cancelOrderIds: open.map((order) => order.id),
      managementStage: open.length > 0
        ? "volume-first-cancel-final-grid" : "volume-first-final-balanced" };
  }
  if (!config.ladderV14VolumeFirstMode && inventory.unpairedShares > EPSILON) {
    return { ...base, ...planResidual(
      config, event, snapshot, books, features, model, nowSeconds,
    ) };
  }

  // A completed repair may still have a cancellation/in-flight remainder.
  // Do not treat it as a normal grid order merely because its price matches.
  if (config.ladderV14VolumeFirstMode &&
    open.some((order) => order.pairId !== `${V14_PREFIX}opening`)) {
    return { ...base,
      cancelOrderIds: open.filter((order) => order.pairId !== `${V14_PREFIX}opening`)
        .map((order) => order.id),
      managementStage: "volume-first-cancel-finished-repair" };
  }

  const tick = Number(tickSizeFromMarket(event.market));
  const openingSelection = config.ladderV14VolumeFirstMode
    ? selectVolumeFirstTargets(
        config,
        event,
        snapshot,
        books,
        secondsRemaining,
        tick,
        features,
        model,
      )
    : selectOpeningTargets(
        config,
        event,
        snapshot,
        books,
        secondsRemaining,
        tick,
        features,
        model,
      );
  const candidates = config.ladderV14VolumeFirstMode
    ? openingSelection.selected
    : openingSelection.selected.sort(
        (left, right) => right.expectedProfitRate - left.expectedProfitRate,
      );
  base.candidates = candidates;
  base.bestEvaluatedCandidate = openingSelection.bestEvaluated;
  base.expectedPortfolioValue = candidates.reduce(
    (sum, candidate) => sum + candidate.expectedValue,
    0,
  );
  const desired = new Map(
    candidates.map((candidate) => [
      `${candidate.tokenId}|${candidate.price}`,
      candidate,
    ]),
  );
  const existingByKey = new Map<string, PaperOrder[]>();
  for (const order of open) {
    const key = `${order.tokenId}|${order.limitPrice}`;
    const values = existingByKey.get(key) ?? [];
    values.push(order);
    existingByKey.set(key, values);
  }
  for (const [key, orders] of existingByKey) {
    if (!desired.has(key)) base.cancelOrderIds.push(...orders.map((order) => order.id));
    else if (orders.length > 1) base.cancelOrderIds.push(...orders.slice(1).map((order) => order.id));
  }
  if (base.cancelOrderIds.length > 0) {
    base.managementStage = "reconcile-target-grid-cancellations";
    return base;
  }
  for (const candidate of candidates) {
    const key = `${candidate.tokenId}|${candidate.price}`;
    const existing = existingByKey.get(key)?.[0];
    const token = books.find((book) => book.tokenId === candidate.tokenId)!;
    const tradeKey = `${V14_PREFIX}${event.slug}:opening:${candidate.tokenId}:${candidate.price}:${candidate.size}:${Math.floor(nowSeconds * 1000)}`;
    const target = opportunity(
      event,
      token,
      "BUY",
      candidate.price,
      candidate.size,
      "post_only",
      "opening",
      tradeKey,
    );
    base.placementContexts[tradeKey] = { kind: "fill", context: candidate.context };
    if (!existing) {
      base.opportunities.push(target);
    } else if (
      Math.abs(existing.remainingSize - candidate.size) + EPSILON >=
      Math.max(0.01, candidate.size * 0.01)
    ) {
      base.amendments.push({ orderId: existing.id, opportunity: target });
    }
  }
  base.managementStage = base.amendments.length > 0
    ? config.ladderV14VolumeFirstMode
      ? "volume-first-amend-pair-grid"
      : "amend-target-grid"
    : base.opportunities.length > 0
      ? config.ladderV14VolumeFirstMode
        ? "volume-first-post-pair-grid"
        : "post-positive-marginal-ev-grid"
      : candidates.length > 0
        ? config.ladderV14VolumeFirstMode
          ? "volume-first-pair-grid-resting"
          : "target-grid-resting"
        : config.ladderV14VolumeFirstMode
          ? "volume-first-no-valid-pair-grid"
          : "no-positive-marginal-ev";
  return base;
}
