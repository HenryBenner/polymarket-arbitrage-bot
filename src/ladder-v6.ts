import type { BotConfig } from "./config.js";
import { LadderTracker } from "./ladder.js";
import type {
  LadderPhase,
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";

const EPSILON = 1e-8;
const SHARE_STEP = 0.01;
const V6_PREFIX = "ladder-v6:";
const V6_OPENING_PREFIX = `${V6_PREFIX}opening:`;
const V6_HEDGE_PREFIX = `${V6_PREFIX}hedge:`;

export const LADDER_V6_PHASE: LadderPhase = {
  id: "5-2",
  minutesLeftMin: 2,
  minutesLeftMax: 5,
  rungs: [
    { lowPrice: 0.1, highPrice: 0.9 },
    { lowPrice: 0.15, highPrice: 0.85 },
  ],
};

export interface LadderV6Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  cheapFilledShares: number;
  hedgedShares: number;
  unmatchedCheapShares: number;
  plannedAllInPairCost: number | null;
  plannedNetEdgePerPair: number | null;
}

interface CostLot {
  shares: number;
  unitCost: number;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorShares(value: number): number {
  return Math.floor((value + EPSILON) / SHARE_STEP) * SHARE_STEP;
}

function isActive(
  event: UpDownEvent,
  nowSeconds: number,
): boolean {
  const remaining = (event.windowEnd - nowSeconds) / 60;
  return (
    remaining > LADDER_V6_PHASE.minutesLeftMin &&
    remaining <= LADDER_V6_PHASE.minutesLeftMax
  );
}

function isV6Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V6_PREFIX) ?? false;
}

function isOpeningOrder(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V6_OPENING_PREFIX) ?? false;
}

function isHedgeOrder(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V6_HEDGE_PREFIX) ?? false;
}

function fillsForOrders(
  snapshot: MarketExecutionSnapshot,
  predicate: (order: PaperOrder) => boolean,
): PaperFill[] {
  const ids = new Set(
    snapshot.orders.filter(predicate).map((order) => order.id),
  );
  return snapshot.fills.filter((fill) => ids.has(fill.orderId));
}

function fillUnitCost(fill: PaperFill): number {
  return fill.price + (fill.size > EPSILON ? fill.fee / fill.size : 0);
}

function remainingCheapLots(
  openingFills: PaperFill[],
  alreadyHedgedShares: number,
): CostLot[] {
  let paired = alreadyHedgedShares;
  const lots = openingFills
    .map((fill) => ({
      shares: fill.size,
      unitCost: fillUnitCost(fill),
    }))
    .sort((left, right) => right.unitCost - left.unitCost);

  const remaining: CostLot[] = [];
  for (const lot of lots) {
    const consumed = Math.min(paired, lot.shares);
    paired = round(paired - consumed);
    const shares = round(lot.shares - consumed);
    if (shares > EPSILON) remaining.push({ ...lot, shares });
  }
  return remaining;
}

function feePerShare(
  price: number,
  rate: number,
  exponent: number,
): number {
  return rate * Math.pow(price * (1 - price), exponent);
}

function cheapCostForShares(lots: CostLot[], shares: number): number {
  let remaining = shares;
  let cost = 0;
  for (const lot of lots) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, lot.shares);
    cost += selected * lot.unitCost;
    remaining = round(remaining - selected);
  }
  return remaining <= EPSILON ? cost : Number.POSITIVE_INFINITY;
}

function hedgeDepthPlan(
  config: BotConfig,
  snapshot: MarketExecutionSnapshot,
  book: TokenBook,
  lots: CostLot[],
  shares: number,
): {
  limitPrice: number;
  allInPairCost: number;
  netEdgePerPair: number;
} | null {
  let remaining = shares;
  let hedgeCost = 0;
  let limitPrice = 0;
  for (const ask of [...book.asks].sort((a, b) => a.price - b.price)) {
    if (remaining <= EPSILON) break;
    if (ask.size <= EPSILON) continue;
    const selected = Math.min(remaining, ask.size);
    hedgeCost +=
      selected *
      (ask.price +
        feePerShare(
          ask.price,
          snapshot.takerFeeRate,
          snapshot.takerFeeExponent,
        ));
    limitPrice = ask.price;
    remaining = round(remaining - selected);
  }
  if (remaining > EPSILON || limitPrice <= 0) return null;

  const cheapCost = cheapCostForShares(lots, shares);
  if (!Number.isFinite(cheapCost)) return null;
  const allInPairCost = (cheapCost + hedgeCost) / shares;
  const netEdgePerPair = 1 - allInPairCost;
  if (netEdgePerPair + EPSILON < config.ladderV6MinNetEdge) return null;
  return {
    limitPrice,
    allInPairCost,
    netEdgePerPair,
  };
}

function bookSignature(book: TokenBook, requiredShares: number): string {
  let remaining = requiredShares;
  const levels: string[] = [];
  for (const ask of [...book.asks].sort((a, b) => a.price - b.price)) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, ask.size);
    if (selected <= EPSILON) continue;
    levels.push(`${ask.price.toFixed(4)}x${selected.toFixed(2)}`);
    remaining = round(remaining - selected);
  }
  return levels.join(",");
}

export async function planLadderV6(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1000,
): Promise<LadderV6Plan> {
  const active = isActive(event, nowSeconds);
  const v6OpenOrders = snapshot.openOrders.filter(isV6Order);
  const openingFills = fillsForOrders(snapshot, isOpeningOrder);
  const hedgeFills = fillsForOrders(snapshot, isHedgeOrder);
  const cheapFilledShares = round(
    openingFills.reduce((sum, fill) => sum + fill.size, 0),
  );
  const hedgedShares = round(
    hedgeFills.reduce((sum, fill) => sum + fill.size, 0),
  );
  const unmatchedCheapShares = round(
    Math.max(0, cheapFilledShares - hedgedShares),
  );
  const basePlan = {
    cancelOrderIds: active ? [] : v6OpenOrders.map((order) => order.id),
    opportunities: [],
    cheapFilledShares,
    hedgedShares,
    unmatchedCheapShares,
    plannedAllInPairCost: null,
    plannedNetEdgePerPair: null,
  };
  if (!active) return basePlan;

  const books = snapshot.books.filter((book) => book.bestAsk !== null);
  if (books.length !== 2) return basePlan;
  const lock = await tracker.lockPhase(event, LADDER_V6_PHASE, books);
  if (!lock) return basePlan;
  const cheap = books.find((book) => book.tokenId === lock.cheapTokenId);
  const favorite = books.find(
    (book) => book.tokenId === lock.favoriteTokenId,
  );
  if (!cheap || !favorite) return basePlan;

  if (cheapFilledShares > EPSILON) {
    const cancelOrderIds = v6OpenOrders
      .filter(isOpeningOrder)
      .map((order) => order.id);
    if (unmatchedCheapShares <= EPSILON) {
      return { ...basePlan, cancelOrderIds };
    }

    const hedgeSize = floorShares(unmatchedCheapShares);
    if (
      hedgeSize <= EPSILON ||
      hedgeSize + EPSILON < favorite.minOrderSize
    ) {
      return { ...basePlan, cancelOrderIds };
    }
    const lots = remainingCheapLots(openingFills, hedgedShares);
    const depthPlan = hedgeDepthPlan(
      config,
      snapshot,
      favorite,
      lots,
      hedgeSize,
    );
    if (
      !depthPlan ||
      depthPlan.limitPrice * hedgeSize + EPSILON < 1
    ) {
      return { ...basePlan, cancelOrderIds };
    }

    const stateSignature = `${hedgeSize.toFixed(2)}:${cheapCostForShares(
      lots,
      hedgeSize,
    ).toFixed(6)}`;
    const depthSignature = bookSignature(favorite, hedgeSize);
    const tradeKey = `${V6_HEDGE_PREFIX}${event.slug}:${stateSignature}:${depthSignature}`;
    const attempted = snapshot.orders.some(
      (order) => order.tradeKey === tradeKey,
    );
    if (attempted) {
      return {
        ...basePlan,
        cancelOrderIds,
        plannedAllInPairCost: depthPlan.allInPairCost,
        plannedNetEdgePerPair: depthPlan.netEdgePerPair,
      };
    }

    return {
      ...basePlan,
      cancelOrderIds,
      opportunities: [
        {
          kind: "expensive",
          event,
          token: favorite,
          price: depthPlan.limitPrice,
          size: hedgeSize,
          tickSize: tickSizeFromMarket(event.market),
          negRisk: event.market.negRisk,
          tradeKey,
          strategyMode: "ladder_v6",
          phaseId: LADDER_V6_PHASE.id,
          pairId: `${V6_HEDGE_PREFIX}completion`,
          orderPolicy: "fok",
          pairLockRole: "completion_taker",
          pairLockEntryPrice:
            cheapCostForShares(lots, hedgeSize) / hedgeSize,
        },
      ],
      plannedAllInPairCost: depthPlan.allInPairCost,
      plannedNetEdgePerPair: depthPlan.netEdgePerPair,
    };
  }

  const opportunities: TradeOpportunity[] = [];
  const perRungShares = floorShares(
    config.ladderV6MaxUnmatchedShares / LADDER_V6_PHASE.rungs.length,
  );
  let committedShares = v6OpenOrders
    .filter(isOpeningOrder)
    .reduce((sum, order) => sum + order.remainingSize, 0);

  for (const rung of LADDER_V6_PHASE.rungs) {
    const tradeKey = `${V6_OPENING_PREFIX}${tracker.makeKey(
      event.slug,
      LADDER_V6_PHASE.id,
      cheap.outcome,
      rung.lowPrice,
    )}`;
    if (
      tracker.has(tradeKey) ||
      cheap.bestAsk === null ||
      rung.lowPrice + EPSILON >= cheap.bestAsk
    ) {
      continue;
    }
    const capacity = floorShares(
      config.ladderV6MaxUnmatchedShares - committedShares,
    );
    const size = Math.min(perRungShares, capacity);
    if (
      size <= EPSILON ||
      size + EPSILON < cheap.minOrderSize ||
      size * rung.lowPrice + EPSILON < 1
    ) {
      continue;
    }
    opportunities.push({
      kind: "cheap",
      event,
      token: cheap,
      price: rung.lowPrice,
      size,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey,
      strategyMode: "ladder_v6",
      phaseId: LADDER_V6_PHASE.id,
      pairId: `${V6_OPENING_PREFIX}${rung.lowPrice.toFixed(2)}`,
      orderPolicy: "post_only",
      pairLockRole: "opening",
    });
    committedShares = round(committedShares + size);
  }

  return { ...basePlan, opportunities };
}
