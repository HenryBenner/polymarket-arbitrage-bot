import { LadderTracker } from "./ladder.js";
import type { LadderV11DecisionSnapshot } from "./ladder-v11-regime.js";
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
const V11_PREFIX = "ladder-v11:";

export const LADDER_V11_CHEAP_PRICE = 0.1;
export const LADDER_V11_FAVORITE_MAX_PRICE = 0.8;
export const LADDER_V11_SIZE = 40;

export const LADDER_V11_PHASE: LadderPhase = {
  id: "5-0",
  minutesLeftMin: 0,
  minutesLeftMax: 5,
  rungs: [
    {
      lowPrice: LADDER_V11_CHEAP_PRICE,
      highPrice: LADDER_V11_FAVORITE_MAX_PRICE,
    },
  ],
};

export interface LadderV11Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  filledSharesByOutcome: Record<string, number>;
  pairedShares: number;
  unmatchedCheapShares: number;
  unmatchedFavoriteShares: number;
  managementStage: string;
  decision: LadderV11DecisionSnapshot | null;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function isV11Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V11_PREFIX) ?? false;
}

function role(order: PaperOrder): string {
  return isV11Order(order) ? (order.pairId ?? "").slice(V11_PREFIX.length) : "";
}

function strategyFills(
  snapshot: MarketExecutionSnapshot,
  orders: readonly PaperOrder[],
): PaperFill[] {
  const ids = new Set(orders.map((order) => order.id));
  return snapshot.fills.filter(
    (fill) => ids.has(fill.orderId) && (fill.side ?? "BUY") === "BUY",
  );
}

function sharesFor(fills: readonly PaperFill[], tokenId: string): number {
  return round(
    fills
      .filter((fill) => fill.tokenId === tokenId)
      .reduce((sum, fill) => sum + fill.size, 0),
  );
}

function validOrder(book: TokenBook, price: number, size: number): boolean {
  return (
    size > EPSILON &&
    size + EPSILON >= book.minOrderSize &&
    size * price + EPSILON >= 1
  );
}

function opportunity(
  event: UpDownEvent,
  token: TokenBook,
  kind: TradeOpportunity["kind"],
  price: number,
  tradeKey: string,
  orderRole: string,
  orderPolicy: NonNullable<TradeOpportunity["orderPolicy"]>,
): TradeOpportunity {
  return {
    kind,
    event,
    token,
    price,
    size: LADDER_V11_SIZE,
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    strategyMode: "ladder_v11",
    phaseId: LADDER_V11_PHASE.id,
    pairId: `${V11_PREFIX}${orderRole}`,
    orderPolicy,
  };
}

/**
 * V11 deliberately has no completion or rescue branch. It can only submit the
 * fixed cheap maker followed by the fixed favorite FAK, or submit nothing.
 */
export async function planLadderV11(
  tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  decision: LadderV11DecisionSnapshot | null,
  allowFavorite: boolean,
  nowSeconds = Date.now() / 1_000,
): Promise<LadderV11Plan> {
  const orders = snapshot.orders.filter(isV11Order);
  const fills = strategyFills(snapshot, orders);
  const cheapTokenId = decision?.cheapTokenId;
  const favoriteTokenId = decision?.favoriteTokenId;
  const cheapShares = cheapTokenId ? sharesFor(fills, cheapTokenId) : 0;
  const favoriteShares = favoriteTokenId ? sharesFor(fills, favoriteTokenId) : 0;
  const plan: LadderV11Plan = {
    cancelOrderIds: [],
    opportunities: [],
    filledSharesByOutcome: Object.fromEntries(
      snapshot.books.map((book) => [book.outcome, sharesFor(fills, book.tokenId)]),
    ),
    pairedShares: round(Math.min(cheapShares, favoriteShares)),
    unmatchedCheapShares: round(Math.max(0, cheapShares - favoriteShares)),
    unmatchedFavoriteShares: round(Math.max(0, favoriteShares - cheapShares)),
    managementStage: decision?.eligible ? "entry" : "no-trade",
    decision,
  };

  const secondsLeft = event.windowEnd - nowSeconds;
  const entryActive = secondsLeft > 120 && secondsLeft <= 300;
  const cheapOrder = orders.find((order) => role(order) === "cheap-maker");
  const favoriteOrder = orders.find(
    (order) => role(order) === "favorite-initial",
  );

  if (!entryActive) {
    plan.cancelOrderIds = snapshot.openOrders
      .filter((order) => isV11Order(order) && role(order) === "cheap-maker")
      .map((order) => order.id);
    plan.managementStage =
      secondsLeft <= 120 ? "market-already-too-late" : "observing";
    return plan;
  }

  if (!decision?.eligible) {
    if (
      allowFavorite &&
      cheapOrder &&
      snapshot.openOrders.some((order) => order.id === cheapOrder.id)
    ) {
      plan.cancelOrderIds = [cheapOrder.id];
      plan.managementStage = "cancel-rejected-cheap";
    }
    return plan;
  }
  const cheap = snapshot.books.find(
    (book) => book.tokenId === decision.cheapTokenId,
  );
  const favorite = snapshot.books.find(
    (book) => book.tokenId === decision.favoriteTokenId,
  );
  if (!cheap || !favorite) {
    plan.managementStage = "invalid-book";
    return plan;
  }

  const existingKeys = new Set(orders.map((order) => order.tradeKey));
  if (!cheapOrder) {
    const tradeKey = `${V11_PREFIX}${event.slug}:cheap-maker`;
    if (
      !tracker.has(tradeKey) &&
      !existingKeys.has(tradeKey) &&
      cheap.bestAsk !== null &&
      LADDER_V11_CHEAP_PRICE + EPSILON < cheap.bestAsk &&
      validOrder(cheap, LADDER_V11_CHEAP_PRICE, LADDER_V11_SIZE)
    ) {
      plan.opportunities.push(
        opportunity(
          event,
          cheap,
          "cheap",
          LADDER_V11_CHEAP_PRICE,
          tradeKey,
          "cheap-maker",
          "post_only",
        ),
      );
      plan.managementStage = "cheap-entry";
    }
    return plan;
  }

  if (favoriteOrder) {
    plan.managementStage = "orders-complete";
    return plan;
  }

  if (!allowFavorite) {
    plan.managementStage = "favorite-revalidation-required";
    return plan;
  }

  const currentFavoriteAsk = favorite.bestAsk;
  if (
    currentFavoriteAsk === null ||
    currentFavoriteAsk < 0.5 - EPSILON ||
    currentFavoriteAsk > LADDER_V11_FAVORITE_MAX_PRICE + EPSILON
  ) {
    plan.managementStage = "favorite-invariant-blocked";
    return plan;
  }
  const tradeKey = `${V11_PREFIX}${event.slug}:favorite-initial`;
  if (
    !tracker.has(tradeKey) &&
    !existingKeys.has(tradeKey) &&
    validOrder(favorite, LADDER_V11_FAVORITE_MAX_PRICE, LADDER_V11_SIZE)
  ) {
    plan.opportunities.push(
      opportunity(
        event,
        favorite,
        "expensive",
        LADDER_V11_FAVORITE_MAX_PRICE,
        tradeKey,
        "favorite-initial",
        "fak",
      ),
    );
    plan.managementStage = "favorite-initial";
  }
  return plan;
}
