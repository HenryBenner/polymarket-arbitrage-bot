import type { BotConfig } from "./config.js";
import type { LadderV10Decision } from "./ladder-v10-regime.js";
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
const V10_PREFIX = "ladder-v10:";
const FULL_FAVORITE_SHARES = 40;

export const LADDER_V10_PHASE: LadderPhase = {
  id: "5-0",
  minutesLeftMin: 0,
  minutesLeftMax: 5,
  rungs: [{ lowPrice: 0.1, highPrice: 0.8 }],
};

export interface LadderV10Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  filledSharesByOutcome: Record<string, number>;
  pairedShares: number;
  unmatchedCheapShares: number;
  unmatchedFavoriteShares: number;
  managementStage: string;
  decision: LadderV10Decision | null;
  maximumCompletionPrice: number | null;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function isV10Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V10_PREFIX) ?? false;
}

function role(order: PaperOrder): string {
  return isV10Order(order) ? (order.pairId ?? "").slice(V10_PREFIX.length) : "";
}

function v10Fills(
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

function allInAverage(fills: readonly PaperFill[]): number | null {
  const size = fills.reduce((sum, fill) => sum + fill.size, 0);
  return size <= EPSILON
    ? null
    : fills.reduce(
        (sum, fill) => sum + fill.price * fill.size + fill.fee,
        0,
      ) / size;
}

function maximumCompletionPrice(
  cheapAllIn: number,
  config: BotConfig,
  snapshot: MarketExecutionSnapshot,
  tickSize: number,
): number | null {
  let selected: number | null = null;
  for (let price = tickSize; price < 1; price += tickSize) {
    const normalized = round(price, 4);
    const fee =
      snapshot.takerFeeRate *
      Math.pow(normalized * (1 - normalized), snapshot.takerFeeExponent);
    if (cheapAllIn + normalized + fee <= config.ladderV10MaxPairCost + EPSILON) {
      selected = normalized;
    }
  }
  return selected;
}

function exactDepth(book: TokenBook, limit: number): number {
  return book.asks
    .filter((level) => level.price <= limit + EPSILON)
    .reduce((sum, level) => sum + level.size, 0);
}

function signature(book: TokenBook, limit: number): string {
  let hash = 2166136261;
  const value = book.asks
    .filter((level) => level.price <= limit + EPSILON)
    .map((level) => `${level.price.toFixed(4)}:${level.size.toFixed(4)}`)
    .join("|");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
  size: number,
  tradeKey: string,
  orderRole: string,
  orderPolicy: NonNullable<TradeOpportunity["orderPolicy"]>,
): TradeOpportunity {
  return {
    kind,
    event,
    token,
    price,
    size,
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    strategyMode: "ladder_v10",
    phaseId: LADDER_V10_PHASE.id,
    pairId: `${V10_PREFIX}${orderRole}`,
    orderPolicy,
  };
}

export async function planLadderV10(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  decision: LadderV10Decision | null,
  nowSeconds = Date.now() / 1_000,
): Promise<LadderV10Plan> {
  const orders = snapshot.orders.filter(isV10Order);
  const fills = v10Fills(snapshot, orders);
  const cheap = decision
    ? snapshot.books.find((book) => book.tokenId === decision.cheapTokenId)
    : undefined;
  const favorite = decision
    ? snapshot.books.find((book) => book.tokenId === decision.favoriteTokenId)
    : undefined;
  const cheapShares = cheap ? sharesFor(fills, cheap.tokenId) : 0;
  const favoriteShares = favorite ? sharesFor(fills, favorite.tokenId) : 0;
  const binaryFavoriteTargetShares =
    decision && decision.favoriteTargetShares > EPSILON
      ? FULL_FAVORITE_SHARES
      : 0;
  const plan: LadderV10Plan = {
    cancelOrderIds: [],
    opportunities: [],
    filledSharesByOutcome: Object.fromEntries(
      snapshot.books.map((book) => [book.outcome, sharesFor(fills, book.tokenId)]),
    ),
    pairedShares: round(Math.min(cheapShares, favoriteShares)),
    unmatchedCheapShares: round(Math.max(0, cheapShares - favoriteShares)),
    unmatchedFavoriteShares: round(Math.max(0, favoriteShares - cheapShares)),
    managementStage: decision ? "entry" : "observing",
    decision,
    maximumCompletionPrice: null,
  };
  if (!decision || !cheap || !favorite) return plan;

  const secondsLeft = event.windowEnd - nowSeconds;
  if (secondsLeft <= 0 || secondsLeft > 300) return plan;
  const entryActive = secondsLeft > 120;
  const cheapOrder = orders.find((order) => role(order) === "cheap-maker");
  const favoriteInitial = orders.find(
    (order) => role(order) === "favorite-initial",
  );
  const existingKeys = new Set(orders.map((order) => order.tradeKey));

  if (!entryActive) {
    plan.cancelOrderIds = snapshot.openOrders
      .filter((order) => isV10Order(order) && role(order) === "cheap-maker")
      .map((order) => order.id);
    if (plan.cancelOrderIds.length > 0) {
      plan.managementStage = "cancel-cheap";
      return plan;
    }
  }

  if (entryActive && !cheapOrder) {
    const tradeKey = `${V10_PREFIX}${event.slug}:cheap-maker`;
    if (
      !tracker.has(tradeKey) &&
      !existingKeys.has(tradeKey) &&
      cheap.bestAsk !== null &&
      config.ladderV10CheapPrice + EPSILON < cheap.bestAsk &&
      validOrder(cheap, config.ladderV10CheapPrice, config.ladderV10TargetShares)
    ) {
      plan.opportunities.push(
        opportunity(
          event,
          cheap,
          "cheap",
          config.ladderV10CheapPrice,
          config.ladderV10TargetShares,
          tradeKey,
          "cheap-maker",
          "post_only",
        ),
      );
      plan.managementStage = "cheap-entry";
    }
    return plan;
  }

  if (
    entryActive &&
    !favoriteInitial &&
    binaryFavoriteTargetShares > EPSILON
  ) {
    const tradeKey = `${V10_PREFIX}${event.slug}:favorite-initial`;
    if (
      !tracker.has(tradeKey) &&
      !existingKeys.has(tradeKey) &&
      validOrder(
        favorite,
        config.ladderV10FavoritePrice,
        binaryFavoriteTargetShares,
      )
    ) {
      plan.opportunities.push(
        opportunity(
          event,
          favorite,
          "expensive",
          config.ladderV10FavoritePrice,
          binaryFavoriteTargetShares,
          tradeKey,
          "favorite-initial",
          "fak",
        ),
      );
      plan.managementStage = "favorite-initial";
    }
    return plan;
  }

  const unmatchedCheap = Math.min(
    Math.max(0, cheapShares - favoriteShares),
    Math.max(0, config.ladderV10TargetShares - favoriteShares),
  );
  if (unmatchedCheap <= EPSILON) {
    plan.managementStage =
      favoriteShares > cheapShares ? "hold-favorite" : "balanced";
    return plan;
  }
  const cheapAllIn = allInAverage(
    fills.filter((fill) => fill.tokenId === cheap.tokenId),
  );
  const tickSize = Number(tickSizeFromMarket(event.market));
  if (cheapAllIn === null || !Number.isFinite(tickSize) || tickSize <= 0) {
    plan.managementStage = "wait-completion";
    return plan;
  }
  const cap = maximumCompletionPrice(cheapAllIn, config, snapshot, tickSize);
  plan.maximumCompletionPrice = cap;
  if (
    cap === null ||
    exactDepth(favorite, cap) + EPSILON < unmatchedCheap ||
    !validOrder(favorite, cap, unmatchedCheap)
  ) {
    plan.managementStage = "wait-completion";
    return plan;
  }
  const depthSignature = signature(favorite, cap);
  const tradeKey = `${V10_PREFIX}${event.slug}:favorite-completion:${depthSignature}`;
  if (!tracker.has(tradeKey) && !existingKeys.has(tradeKey)) {
    plan.opportunities.push(
      opportunity(
        event,
        favorite,
        "expensive",
        cap,
        unmatchedCheap,
        tradeKey,
        `favorite-completion-${depthSignature}`,
        "fok",
      ),
    );
    plan.managementStage = "favorite-completion";
  }
  return plan;
}
