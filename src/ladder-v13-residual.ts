import { exactKalshiDepthCost, exactKalshiDepthProceeds, exactKalshiOrderFee } from "./kalshi-fees.js";
import {
  LADDER_V13_TERMINAL_ONE_SIDED, LADDER_V13_TERMINAL_TWO_SIDED,
  ladderV13SellFraction, type LadderV13CompletionContext,
  type LadderV13CompletionEstimate, type LadderV13CompletionModel,
} from "./ladder-v13-completion-model.js";
import { ladderV13Inventory, type LadderV13ResidualEpisode } from "./ladder-v13-inventory.js";
import type { LadderTracker } from "./ladder.js";
import type { MarketExecutionSnapshot, TradeOpportunity, UpDownEvent } from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";

const EPSILON = 1e-8;
const round = (value: number): number => Math.round(value * 1e8) / 1e8;
const floorSize = (value: number): number => Math.floor((value + EPSILON) * 100) / 100;

export interface LadderV13LiquidationDecision {
  secondsLeft: number;
  fallbackValue: number;
  pairNowValue: number | null;
  pairValue: number | null;
  sellValue: number | null;
  waitValue: number;
  upperWaitValue: number;
  sellFraction: number;
  sellSize: number;
  estimate: LadderV13CompletionEstimate | null;
}

export interface LadderV13ResidualPlan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  flattenOpportunities: TradeOpportunity[];
  managementStage: string;
  maximumCompletionPrice: number | null;
  plannedPairCost: number | null;
  residualEpisode: LadderV13ResidualEpisode | null;
  completionContext: LadderV13CompletionContext | null;
  liquidation: LadderV13LiquidationDecision | null;
}

export function planLadderV13Residual(
  tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  model: LadderV13CompletionModel,
  nowSeconds: number,
  eligibleVolumePerSecondByToken: Record<string, number>,
  deferFractionalSale = false,
): LadderV13ResidualPlan {
  const inventory = ladderV13Inventory(snapshot, nowSeconds);
  const episode = inventory.episode!;
  const size = inventory.unpairedShares;
  const secondsLeft = event.windowEnd - nowSeconds;
  const surplus = snapshot.books.find((book) => book.tokenId === episode.surplusTokenId)!;
  const deficient = snapshot.books.find((book) => book.tokenId !== surplus.tokenId)!;
  const orders = snapshot.orders.filter((order) => order.pairId?.startsWith("ladder-v13:"));
  const open = snapshot.openOrders.filter((order) => order.pairId?.startsWith("ladder-v13:"));
  const buys = open.filter((order) => (order.side ?? "BUY") === "BUY");
  const releasedCash = buys.reduce((sum, order) => sum + order.limitPrice * order.remainingSize, 0);
  const tick = Number(tickSizeFromMarket(event.market));
  const makerFee = (price: number): number => exactKalshiOrderFee({
    price, size, rate: snapshot.makerFeeRate ?? 0, exponent: snapshot.takerFeeExponent,
  });
  let maximum = Math.min(1 - tick, Math.floor((1 - inventory.unpairedCost / size) / tick) * tick);
  maximum = round(maximum);
  while (maximum > EPSILON && inventory.unpairedCost + maximum * size + makerFee(maximum) >= size - EPSILON) {
    maximum = round(maximum - tick);
  }
  const makerPrice = deficient.bestAsk === null ? 0 : round(Math.min(maximum,
    Math.floor((deficient.bestAsk - tick + EPSILON) / tick) * tick));
  const matching = buys.find((order) => order.tokenId === deficient.tokenId && order.orderPolicy === "post_only" &&
    Math.abs(order.limitPrice - makerPrice) <= EPSILON && Math.abs(order.remainingSize - size) <= EPSILON);
  const context: LadderV13CompletionContext | null = makerPrice > EPSILON && size >= 0.01 &&
    makerPrice * size + makerFee(makerPrice) <= snapshot.availableCash + releasedCash + EPSILON ? {
    queueRatio: (matching?.queueAhead ?? deficient.bids.filter((level) => Math.abs(level.price - makerPrice) <= EPSILON)
      .reduce((sum, level) => sum + level.size, 0)) / size,
    flowRatio: (eligibleVolumePerSecondByToken[deficient.tokenId] ?? 0) / size,
    distanceTicks: Math.round(((deficient.bestBid ?? makerPrice) - makerPrice) / tick),
    residualShares: size, residualAgeSeconds: episode.residualAgeSeconds,
    secondsRemaining: Math.max(0, secondsLeft), maximumCompletionPrice: maximum,
    completionMakerPrice: makerPrice,
  } : null;
  const estimate = context ? model.estimate(context) : null;
  const fallback = episode.hasMatchedShares ? LADDER_V13_TERMINAL_TWO_SIDED : LADDER_V13_TERMINAL_ONE_SIDED;
  const pairValue = context ? 1 - makerPrice - makerFee(makerPrice) / size : null;
  const waitValue = estimate && pairValue !== null
    ? estimate.probability * pairValue + (1 - estimate.probability) * fallback : fallback;
  // If pairing is worth less than fallback, higher P is not an optimistic value.
  const upperWaitValue = estimate && pairValue !== null ? Math.max(waitValue,
    estimate.upperProbability * pairValue + (1 - estimate.upperProbability) * fallback) : waitValue;
  const sellDepth = exactKalshiDepthProceeds({ levels: surplus.bids, size,
    rate: snapshot.takerFeeRate, exponent: snapshot.takerFeeExponent });
  const sellValue = sellDepth?.averageNetPrice ?? null;
  const taker = exactKalshiDepthCost({ levels: deficient.asks, size,
    rate: snapshot.takerFeeRate, exponent: snapshot.takerFeeExponent });
  const pairNowValue = taker && inventory.unpairedCost + taker.total < size - EPSILON &&
    taker.total <= snapshot.availableCash + releasedCash + EPSILON ? 1 - taker.total / size : null;
  const base: LadderV13ResidualPlan = {
    cancelOrderIds: [], opportunities: [], flattenOpportunities: [], managementStage: "wait-profitable-completion",
    maximumCompletionPrice: maximum > 0 ? maximum : null,
    plannedPairCost: context ? (inventory.unpairedCost + makerPrice * size + makerFee(makerPrice)) / size : null,
    residualEpisode: episode, completionContext: context,
    liquidation: { secondsLeft, fallbackValue: fallback, pairNowValue, pairValue, sellValue,
      waitValue, upperWaitValue, sellFraction: 0, sellSize: 0, estimate },
  };
  const cancel = (stage: string, ids = open.map((order) => order.id)): LadderV13ResidualPlan =>
    ({ ...base, cancelOrderIds: ids, managementStage: stage });
  const make = (side: "BUY" | "SELL", price: number, quantity: number, policy: "post_only" | "fok" | "fak", role: string, key: string): TradeOpportunity => ({
    kind: policy === "post_only" ? "maker" : "expensive", event,
    token: side === "BUY" ? deficient : surplus, price, size: quantity,
    tickSize: tickSizeFromMarket(event.market), negRisk: event.market.negRisk,
    tradeKey: key, strategyMode: "ladder_v13", phaseId: "15-0", pairId: `ladder-v13:${role}`,
    orderPolicy: policy, capitalEffect: "reduce",
    pairLockRole: side === "SELL" ? undefined : policy === "fok" ? "completion_taker" : "completion_maker",
    plannedAllInPairCost: side === "BUY" ? base.plannedPairCost ?? undefined : undefined,
  });

  // Known exchange acknowledgements must reach the fill ledger before sizing another action.
  if (snapshot.executionPending || open.some((order) => order.side === "SELL") || orders.some((order) => order.status !== "cancelled" &&
    order.originalSize - order.remainingSize > inventory.fills.filter((fill) => fill.orderId === order.id)
      .reduce((sum, fill) => sum + fill.size, 0) + EPSILON)) {
    return { ...base, managementStage: "await-execution-reconciliation" };
  }

  // Sells become eligible at five minutes. Before then retain the existing pair-first policy.
  const sellBeatsImmediatePair = secondsLeft <= 300 && sellValue !== null &&
    pairNowValue !== null && sellValue > pairNowValue + EPSILON;
  if (taker && pairNowValue !== null && !sellBeatsImmediatePair) {
    base.plannedPairCost = (inventory.unpairedCost + taker.total) / size;
    if (open.length) return cancel("cancel-maker-before-fok");
    const depthKey = deficient.asks.map((level) => `${level.price}:${level.size}`).join("|");
    const key = `ladder-v13:${event.slug}:completion-fok:${episode.id}:${size}:${depthKey}:${Math.floor(nowSeconds)}`;
    if (!tracker.has(key) && !orders.some((order) => order.tradeKey === key)) {
      return { ...base, opportunities: [make("BUY", taker.limitPrice, size, "fok", "completion-fok", key)], managementStage: "profitable-fok-completion" };
    }
  }

  let fraction = 0;
  let stage = "residual-wait-has-higher-value";
  const strongLiveCompletion = matching && estimate?.strongEvidence && context && context.flowRatio > 0 &&
    (context.queueRatio + 1) / context.flowRatio < secondsLeft;
  if (secondsLeft <= 30 || sellBeatsImmediatePair) {
    fraction = 1;
    stage = secondsLeft <= 30 ? "final-30-seconds-residual-liquidation" : "sale-beats-immediate-pair";
  } else if (secondsLeft <= 180 && !(strongLiveCompletion && sellValue !== null && waitValue > sellValue)) {
    fraction = 1;
    stage = "liquidation-first-residual";
  } else if (secondsLeft <= 300 && sellValue !== null) {
    fraction = ladderV13SellFraction(sellValue, waitValue, upperWaitValue);
    stage = fraction >= 1 ? "sale-beats-optimistic-wait" : fraction > 0 ? "gradual-residual-liquidation" : stage;
  }
  // After one mixed-evidence slice, re-read inventory and resume the profitable
  // maker for the remainder. Stronger full-liquidation backstops still apply.
  if (deferFractionalSale && fraction > 0 && fraction < 1) fraction = 0;
  base.liquidation!.sellFraction = fraction;
  if (fraction > 0) {
    const requested = floorSize(Math.min(size, size * fraction));
    const depth = exactKalshiDepthProceeds({ levels: surplus.bids, size: requested,
      rate: snapshot.takerFeeRate, exponent: snapshot.takerFeeExponent });
    const sellSize = floorSize(depth?.size ?? 0);
    base.liquidation!.sellSize = sellSize;
    // Cancel every possible competing fill, then the bot replans from a fresh ledger.
    if (open.length) return cancel("cancel-orders-before-residual-sale");
    if (depth && sellSize >= 0.01) {
      const finalDepth = exactKalshiDepthProceeds({ levels: surplus.bids, size: sellSize,
        rate: snapshot.takerFeeRate, exponent: snapshot.takerFeeExponent })!;
      const signature = surplus.bids.map((level) => `${level.price}:${level.size}`).join("|");
      const key = `ladder-v13:${event.slug}:residual-sale:${episode.id}:${size}:${sellSize}:${signature}:${Math.floor(nowSeconds)}`;
      if (!tracker.has(key) && !orders.some((order) => order.tradeKey === key)) {
        return { ...base, flattenOpportunities: [make("SELL", finalDepth.limitPrice, sellSize, "fak", "residual-sale", key)], managementStage: stage };
      }
      return { ...base, managementStage: "await-new-residual-sale-depth" };
    }
    return { ...base, managementStage: requested < 0.01 ? "residual-below-contract-increment" : "residual-sale-no-bid-depth" };
  }

  const surplusOpen = buys.filter((order) => order.tokenId === surplus.tokenId);
  if (surplusOpen.length) return cancel("cancel-imbalance-increasing-orders", surplusOpen.map((order) => order.id));
  const stale = buys.filter((order) => order.id !== matching?.id);
  if (stale.length) return cancel("replace-completion-maker", stale.map((order) => order.id));
  if (matching) return { ...base, managementStage: "waiting-completion-maker" };
  if (context) {
    const key = `ladder-v13:${event.slug}:completion-maker:${deficient.tokenId}:${makerPrice}:${size}:${orders.length + 1}`;
    return { ...base, opportunities: [make("BUY", makerPrice, size, "post_only", "completion-maker", key)], managementStage: "maker-completion" };
  }
  return base;
}
