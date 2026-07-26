import type { BotConfig } from "./config.js";
import {
  LadderTracker,
  pairedShares,
} from "./ladder.js";
import type {
  LadderPhase,
  MarketExecutionSnapshot,
  PaperFill,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";

const EPSILON = 1e-8;
const SHARE_STEP = 0.01;
const V5_PAIR_PREFIX = "ladder-v5:";

export const LADDER_V5_PHASE: LadderPhase = {
  id: "5-2",
  minutesLeftMin: 2,
  minutesLeftMax: 5,
  // The audit ranked 10/90 above 15/85, so scarce imbalance capacity is
  // allocated to the stronger rung first.
  rungs: [
    { lowPrice: 0.1, highPrice: 0.9 },
    { lowPrice: 0.15, highPrice: 0.85 },
  ],
};

export interface LadderV5Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  filledSharesByOutcome: Record<string, number>;
  filledImbalance: number;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorShares(value: number): number {
  return Math.floor((value + EPSILON) / SHARE_STEP) * SHARE_STEP;
}

function minutesLeft(event: UpDownEvent, nowSeconds: number): number {
  return (event.windowEnd - nowSeconds) / 60;
}

export function ladderV5IsActive(
  event: UpDownEvent,
  nowSeconds = Date.now() / 1000,
): boolean {
  const remaining = minutesLeft(event, nowSeconds);
  return (
    remaining > LADDER_V5_PHASE.minutesLeftMin &&
    remaining <= LADDER_V5_PHASE.minutesLeftMax
  );
}

function isV5Order(pairId: string | undefined): boolean {
  return pairId?.startsWith(V5_PAIR_PREFIX) ?? false;
}

function feePerShare(
  price: number,
  rate: number,
  exponent: number,
): number {
  return rate * Math.pow(price * (1 - price), exponent);
}

function sharesByToken(
  snapshot: MarketExecutionSnapshot,
): Map<string, number> {
  const shares = new Map<string, number>();
  for (const position of snapshot.positions) {
    shares.set(
      position.tokenId,
      round((shares.get(position.tokenId) ?? 0) + position.shares),
    );
  }
  return shares;
}

function effectiveFillPrice(fill: PaperFill): number {
  return fill.price + (fill.size > EPSILON ? fill.fee / fill.size : 0);
}

function unmatchedLots(
  snapshot: MarketExecutionSnapshot,
  tokenId: string,
  unmatchedShares: number,
): Array<{ shares: number; unitCost: number }> {
  let remaining = unmatchedShares;
  const lots: Array<{ shares: number; unitCost: number }> = [];
  const fills = snapshot.fills
    .filter((fill) => fill.tokenId === tokenId && fill.size > EPSILON)
    .map((fill) => ({
      shares: fill.size,
      unitCost: effectiveFillPrice(fill),
    }))
    .sort((left, right) => right.unitCost - left.unitCost);

  // Pair the new hedge against the highest-cost directional inventory first.
  // This prevents cheap fills from hiding an unprofitable expensive residual.
  for (const fill of fills) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, fill.shares);
    lots.push({ shares: selected, unitCost: fill.unitCost });
    remaining = round(remaining - selected);
  }
  return lots;
}

function profitableHedgeShares(
  config: BotConfig,
  snapshot: MarketExecutionSnapshot,
  dominantTokenId: string,
  deficit: number,
  hedgeLimitPrice: number,
  requestedShares: number,
): number {
  const maximum = Math.min(deficit, requestedShares);
  if (maximum <= EPSILON) return 0;

  const hedgeFee = feePerShare(
    hedgeLimitPrice,
    snapshot.takerFeeRate,
    snapshot.takerFeeExponent,
  );
  let selected = 0;
  let cost = 0;
  for (const lot of unmatchedLots(snapshot, dominantTokenId, deficit)) {
    if (selected >= maximum - EPSILON) break;
    const available = Math.min(lot.shares, maximum - selected);
    if (available <= EPSILON) continue;
    const unitPairCost = lot.unitCost + hedgeLimitPrice + hedgeFee;
    let accepted = available;
    if (unitPairCost > config.ladderV5MaxPairCost + EPSILON) {
      const remainingEdge =
        config.ladderV5MaxPairCost * selected - cost;
      accepted =
        remainingEdge > EPSILON
          ? Math.min(
              available,
              remainingEdge /
                (unitPairCost - config.ladderV5MaxPairCost),
            )
          : 0;
    }
    accepted = floorShares(accepted);
    if (accepted <= EPSILON) break;
    selected = round(selected + accepted);
    cost = round(cost + accepted * unitPairCost);
  }

  if (
    selected <= EPSILON ||
    cost / selected > config.ladderV5MaxPairCost + EPSILON
  ) {
    return 0;
  }
  return selected;
}

export async function planLadderV5(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  books: TokenBook[],
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1000,
): Promise<LadderV5Plan> {
  const active = ladderV5IsActive(event, nowSeconds);
  const cancelOrderIds = snapshot.openOrders
    .filter((order) => isV5Order(order.pairId) && !active)
    .map((order) => order.id);
  const emptyPlan = {
    cancelOrderIds,
    opportunities: [],
    filledSharesByOutcome: Object.fromEntries(
      snapshot.positions.map((position) => [
        position.outcome,
        position.shares,
      ]),
    ),
    filledImbalance:
      snapshot.positions.length === 2
        ? Math.abs(
            snapshot.positions[0]!.shares - snapshot.positions[1]!.shares,
          )
        : snapshot.positions[0]?.shares ?? 0,
  };
  if (!active) return emptyPlan;

  const completeBooks = books.filter((book) => book.bestAsk !== null);
  if (completeBooks.length !== 2) return emptyPlan;
  const lock = await tracker.lockPhase(
    event,
    LADDER_V5_PHASE,
    completeBooks,
  );
  if (!lock) return emptyPlan;

  const cheap = completeBooks.find(
    (book) => book.tokenId === lock.cheapTokenId,
  );
  const favorite = completeBooks.find(
    (book) => book.tokenId === lock.favoriteTokenId,
  );
  if (!cheap || !favorite) return emptyPlan;

  const filled = sharesByToken(snapshot);
  const cheapFilled = filled.get(cheap.tokenId) ?? 0;
  const favoriteFilled = filled.get(favorite.tokenId) ?? 0;
  const filledSharesByOutcome = {
    [cheap.outcome]: cheapFilled,
    [favorite.outcome]: favoriteFilled,
  };
  const filledImbalance = Math.abs(cheapFilled - favoriteFilled);

  const openRiskByToken = new Map<string, number>();
  const cancelOrderSet = new Set(cancelOrderIds);
  for (const order of snapshot.openOrders) {
    if (!isV5Order(order.pairId)) continue;
    const tokenFilled = filled.get(order.tokenId) ?? 0;
    const otherToken =
      order.tokenId === cheap.tokenId ? favorite.tokenId : cheap.tokenId;
    const otherFilled = filled.get(otherToken) ?? 0;
    const retainedOpen = openRiskByToken.get(order.tokenId) ?? 0;
    const riskCapacity =
      config.ladderV5MaxImbalance -
      (tokenFilled - otherFilled) -
      retainedOpen;
    let retain = order.remainingSize <= riskCapacity + EPSILON;
    if (retain && tokenFilled + EPSILON < otherFilled) {
      const profitableSize = profitableHedgeShares(
        config,
        snapshot,
        otherToken,
        otherFilled - tokenFilled,
        order.limitPrice,
        order.remainingSize,
      );
      retain = profitableSize + EPSILON >= order.remainingSize;
    }
    if (!retain) {
      cancelOrderSet.add(order.id);
      continue;
    }
    openRiskByToken.set(
      order.tokenId,
      round(retainedOpen + order.remainingSize),
    );
  }

  const opportunities: TradeOpportunity[] = [];
  const definitions = LADDER_V5_PHASE.rungs.flatMap((rung) => [
    {
      token: cheap,
      other: favorite,
      price: rung.lowPrice,
      otherPrice: rung.highPrice,
      kind: "cheap" as const,
    },
    {
      token: favorite,
      other: cheap,
      price: rung.highPrice,
      otherPrice: rung.lowPrice,
      kind: "expensive" as const,
    },
  ]);

  for (const definition of definitions) {
    const { token, other, price, otherPrice, kind } = definition;
    const tradeKey = `ladder-v5:${tracker.makeKey(
      event.slug,
      LADDER_V5_PHASE.id,
      token.outcome,
      price,
    )}`;
    if (tracker.has(tradeKey)) continue;

    const tokenFilled = filled.get(token.tokenId) ?? 0;
    const otherFilled = filled.get(other.tokenId) ?? 0;
    const directionalDifference = tokenFilled - otherFilled;
    const openRisk = openRiskByToken.get(token.tokenId) ?? 0;
    const riskCapacity = floorShares(
      config.ladderV5MaxImbalance -
        directionalDifference -
        openRisk,
    );
    if (riskCapacity <= EPSILON) continue;

    let size = Math.min(
      pairedShares(
        Math.min(price, otherPrice),
        Math.max(price, otherPrice),
        token.minOrderSize,
        other.minOrderSize,
        config.ladderSizeScale,
      ),
      riskCapacity,
    );

    // A side is a hedge only after the opposite side has actually filled.
    // Opposite open orders are deliberately excluded from this calculation.
    if (tokenFilled + EPSILON < otherFilled) {
      size = profitableHedgeShares(
        config,
        snapshot,
        other.tokenId,
        otherFilled - tokenFilled,
        price,
        size,
      );
    }
    size = floorShares(size);
    if (
      size <= EPSILON ||
      size + EPSILON < token.minOrderSize ||
      size * price + EPSILON < 1
    ) {
      continue;
    }

    openRiskByToken.set(token.tokenId, round(openRisk + size));
    const rungId = `${Math.min(price, otherPrice).toFixed(2)}-${Math.max(
      price,
      otherPrice,
    ).toFixed(2)}`;
    opportunities.push({
      kind,
      event,
      token,
      price,
      size,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey,
      strategyMode: "ladder_v5",
      phaseId: LADDER_V5_PHASE.id,
      pairId: `${V5_PAIR_PREFIX}${rungId}`,
      // GTC may cross visible asks, preserving the profitable taker fills
      // identified by the audit instead of forcing maker-only execution.
      orderPolicy: "gtc",
    });
  }

  return {
    cancelOrderIds: [...cancelOrderSet],
    opportunities,
    filledSharesByOutcome,
    filledImbalance,
  };
}
