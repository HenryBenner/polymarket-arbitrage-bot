import { LadderTracker } from "./ladder.js";
import type { LadderV12DecisionSnapshot } from "./ladder-v12-regime.js";
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
const V12_PREFIX = "ladder-v12:";

export const LADDER_V12_CHEAP_PRICE = 0.1;
export const LADDER_V12_MAX_PAIR_COST = 0.95;
export const LADDER_V12_MAX_SHARES = 40;

export const LADDER_V12_PHASE: LadderPhase = {
  id: "5-0",
  minutesLeftMin: 0,
  minutesLeftMax: 5,
  rungs: [{ lowPrice: LADDER_V12_CHEAP_PRICE, highPrice: 0.85 }],
};

export interface LadderV12Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  filledSharesByOutcome: Record<string, number>;
  cheapFilledShares: number;
  cheapOpenShares: number;
  favoriteFilledShares: number;
  favoritePendingShares: number;
  pairedShares: number;
  unmatchedCheapShares: number;
  unmatchedFavoriteShares: number;
  targetShares: number;
  managementStage: string;
  decision: LadderV12DecisionSnapshot | null;
  cheapAllIn: number | null;
  maximumCompletionPrice: number | null;
  availableDepth: number;
  plannedPairCost: number | null;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clampTarget(value: number): number {
  return Math.max(0, Math.min(LADDER_V12_MAX_SHARES, value));
}

function isV12Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V12_PREFIX) ?? false;
}

function role(order: PaperOrder): string {
  return isV12Order(order) ? (order.pairId ?? "").slice(V12_PREFIX.length) : "";
}

function isCheapOrder(order: PaperOrder): boolean {
  return role(order).startsWith("cheap-maker");
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

function allInAverage(fills: readonly PaperFill[]): number | null {
  const size = fills.reduce((sum, fill) => sum + fill.size, 0);
  if (size <= EPSILON) return null;
  return round(
    fills.reduce(
      (sum, fill) => sum + fill.price * fill.size + fill.fee,
      0,
    ) / size,
  );
}

function favoriteFeePerShare(
  price: number,
  snapshot: MarketExecutionSnapshot,
): number {
  return (
    snapshot.takerFeeRate *
    Math.pow(price * (1 - price), snapshot.takerFeeExponent)
  );
}

export function maximumV12CompletionPrice(
  cheapAllIn: number,
  snapshot: MarketExecutionSnapshot,
  tickSize: number,
): number | null {
  let selected: number | null = null;
  for (let price = tickSize; price < 1; price += tickSize) {
    const normalized = round(price, 4);
    const pairCost =
      cheapAllIn + normalized + favoriteFeePerShare(normalized, snapshot);
    if (pairCost <= LADDER_V12_MAX_PAIR_COST + EPSILON) selected = normalized;
  }
  return selected;
}

function exactDepth(book: TokenBook, limit: number): number {
  return round(
    book.asks
      .filter((level) => level.price <= limit + EPSILON)
      .reduce((sum, level) => sum + level.size, 0),
  );
}

function depthSignature(book: TokenBook, limit: number): string {
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
  plannedAllInPairCost?: number,
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
    strategyMode: "ladder_v12",
    phaseId: LADDER_V12_PHASE.id,
    pairId: `${V12_PREFIX}${orderRole}`,
    orderPolicy,
    plannedAllInPairCost,
    plannedNetEdgePerPair:
      plannedAllInPairCost === undefined
        ? undefined
        : round(1 - plannedAllInPairCost),
  };
}

function lockedCheapTokenId(
  decision: LadderV12DecisionSnapshot | null,
  orders: readonly PaperOrder[],
  fills: readonly PaperFill[],
): string {
  const cheapOrderIds = new Set(
    orders.filter(isCheapOrder).map((order) => order.id),
  );
  const filledByToken = new Map<string, number>();
  for (const fill of fills) {
    if (!cheapOrderIds.has(fill.orderId)) continue;
    filledByToken.set(
      fill.tokenId,
      (filledByToken.get(fill.tokenId) ?? 0) + fill.size,
    );
  }
  const filled = [...filledByToken.entries()].sort(
    (left, right) => right[1] - left[1],
  )[0]?.[0];
  if (filled) return filled;
  const open = orders.find(
    (order) => isCheapOrder(order) &&
      (order.status === "open" || order.status === "partial"),
  );
  return open?.tokenId ?? decision?.cheapTokenId ?? "";
}

/**
 * Produces at most one new order. The bot loops with a fresh executor snapshot
 * after every cancellation/submission, keeping every completion fill-driven.
 */
export async function planLadderV12(
  tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  decision: LadderV12DecisionSnapshot | null,
  allowFavorite: boolean,
  nowSeconds = Date.now() / 1_000,
): Promise<LadderV12Plan> {
  const orders = snapshot.orders.filter(isV12Order);
  const fills = strategyFills(snapshot, orders);
  const lockedCheapId = lockedCheapTokenId(decision, orders, fills);
  const cheap = snapshot.books.find((book) => book.tokenId === lockedCheapId);
  const favorite = snapshot.books.find((book) => book.tokenId !== lockedCheapId);
  const cheapFills = fills.filter((fill) => fill.tokenId === lockedCheapId);
  const cheapFilled = lockedCheapId ? sharesFor(fills, lockedCheapId) : 0;
  const favoriteFilled = favorite ? sharesFor(fills, favorite.tokenId) : 0;
  const favoritePending = favorite
    ? round(
        orders
          .filter(
            (order) =>
              role(order).startsWith("favorite-completion") &&
              order.tokenId === favorite.tokenId &&
              order.status !== "cancelled",
          )
          .reduce((sum, order) => {
            const confirmed = fills
              .filter((fill) => fill.orderId === order.id)
              .reduce((fillSum, fill) => fillSum + fill.size, 0);
            return sum + Math.max(0, order.originalSize - confirmed);
          }, 0),
      )
    : 0;
  const targetShares = clampTarget(decision?.targetShares ?? 0);
  const openCheapOrders = snapshot.openOrders.filter(
    (order) => isV12Order(order) && isCheapOrder(order),
  );
  const sameTokenOpen = openCheapOrders.filter(
    (order) => order.tokenId === lockedCheapId,
  );
  const cheapOpen = round(
    sameTokenOpen.reduce((sum, order) => sum + order.remainingSize, 0),
  );
  const unmatchedCheap = round(Math.max(0, cheapFilled - favoriteFilled));
  const unmatchedFavorite = round(Math.max(0, favoriteFilled - cheapFilled));
  const plan: LadderV12Plan = {
    cancelOrderIds: [],
    opportunities: [],
    filledSharesByOutcome: Object.fromEntries(
      snapshot.books.map((book) => [book.outcome, sharesFor(fills, book.tokenId)]),
    ),
    cheapFilledShares: cheapFilled,
    cheapOpenShares: cheapOpen,
    favoriteFilledShares: favoriteFilled,
    favoritePendingShares: favoritePending,
    pairedShares: round(Math.min(cheapFilled, favoriteFilled)),
    unmatchedCheapShares: unmatchedCheap,
    unmatchedFavoriteShares: unmatchedFavorite,
    targetShares,
    managementStage: decision ? "entry" : "observing",
    decision,
    cheapAllIn: null,
    maximumCompletionPrice: null,
    availableDepth: 0,
    plannedPairCost: null,
  };

  if (
    cheapFilled > LADDER_V12_MAX_SHARES + EPSILON ||
    favoriteFilled > LADDER_V12_MAX_SHARES + EPSILON ||
    favoriteFilled > cheapFilled + EPSILON
  ) {
    plan.cancelOrderIds = openCheapOrders.map((order) => order.id);
    plan.managementStage = "exposure-invariant-blocked";
    return plan;
  }

  const secondsLeft = event.windowEnd - nowSeconds;
  const entryActive = secondsLeft > 120 && secondsLeft <= 300;

  // A changed cheap identity invalidates only unfilled exposure. Filled cheap
  // shares stay untouched and can only be completed against their opposite.
  const wrongTokenOpen = openCheapOrders.filter(
    (order) => order.tokenId !== lockedCheapId,
  );
  if (wrongTokenOpen.length > 0) {
    plan.cancelOrderIds = wrongTokenOpen.map((order) => order.id);
    plan.managementStage = "cancel-changed-cheap";
    return plan;
  }

  const entryTarget =
    entryActive &&
    decision?.entryEligible &&
    decision.cheapTokenId === lockedCheapId
      ? targetShares
      : 0;
  const allowedOpen = Math.max(
    0,
    Math.min(LADDER_V12_MAX_SHARES - cheapFilled, entryTarget - cheapFilled),
  );
  if (cheapOpen > allowedOpen + EPSILON) {
    let remainingOpen = cheapOpen;
    for (const order of [...sameTokenOpen].reverse()) {
      if (remainingOpen <= allowedOpen + EPSILON) break;
      plan.cancelOrderIds.push(order.id);
      remainingOpen = round(remainingOpen - order.remainingSize);
    }
    plan.managementStage = entryActive ? "cancel-cheap-excess" : "cancel-cheap-cutoff";
    return plan;
  }

  if (secondsLeft <= 0) {
    plan.managementStage = "market-expired";
    return plan;
  }

  if (
    entryActive &&
    decision?.entryEligible &&
    cheap &&
    decision.cheapTokenId === cheap.tokenId
  ) {
    const remaining = round(
      Math.min(
        LADDER_V12_MAX_SHARES - cheapFilled - cheapOpen,
        targetShares - cheapFilled - cheapOpen,
      ),
    );
    if (
      remaining > EPSILON &&
      cheap.bestAsk !== null &&
      LADDER_V12_CHEAP_PRICE + EPSILON < cheap.bestAsk &&
      validOrder(cheap, LADDER_V12_CHEAP_PRICE, remaining)
    ) {
      const sequence = orders.filter(isCheapOrder).length + 1;
      const tradeKey = `${V12_PREFIX}${event.slug}:cheap-maker:${sequence}:${remaining}`;
      if (!tracker.has(tradeKey)) {
        plan.opportunities.push(
          opportunity(
            event,
            cheap,
            "cheap",
            LADDER_V12_CHEAP_PRICE,
            remaining,
            tradeKey,
            `cheap-maker-${sequence}`,
            "post_only",
          ),
        );
        plan.managementStage = cheapFilled + cheapOpen > EPSILON
          ? "cheap-top-up"
          : "cheap-entry";
        return plan;
      }
    }
  }

  if (unmatchedCheap <= EPSILON) {
    plan.managementStage = favoriteFilled > EPSILON ? "balanced" : "wait-cheap-fill";
    return plan;
  }
  if (favoritePending > EPSILON) {
    plan.managementStage = "wait-favorite-confirmation";
    return plan;
  }
  if (!allowFavorite) {
    plan.managementStage = "favorite-revalidation-required";
    return plan;
  }
  if (
    !decision ||
    decision.source !== "brti" ||
    !decision.scoreInputsValid
  ) {
    plan.managementStage = "wait-valid-brti";
    return plan;
  }
  if (
    !cheap ||
    !favorite ||
    decision.cheapTokenId !== cheap.tokenId ||
    decision.favoriteTokenId !== favorite.tokenId
  ) {
    plan.managementStage = "completion-identity-changed";
    return plan;
  }

  const completionShares = round(
    Math.min(unmatchedCheap, LADDER_V12_MAX_SHARES - favoriteFilled),
  );
  if (completionShares <= EPSILON) {
    plan.managementStage = "completion-cap-reached";
    return plan;
  }
  const cheapAllIn = allInAverage(cheapFills);
  const tickSize = Number(tickSizeFromMarket(event.market));
  plan.cheapAllIn = cheapAllIn;
  if (cheapAllIn === null || !Number.isFinite(tickSize) || tickSize <= 0) {
    plan.managementStage = "wait-completion";
    return plan;
  }
  const cap = maximumV12CompletionPrice(cheapAllIn, snapshot, tickSize);
  plan.maximumCompletionPrice = cap;
  if (cap === null) {
    plan.managementStage = "wait-pair-cost";
    return plan;
  }
  plan.availableDepth = exactDepth(favorite, cap);
  plan.plannedPairCost = round(
    cheapAllIn + cap + favoriteFeePerShare(cap, snapshot),
  );
  if (
    plan.plannedPairCost > LADDER_V12_MAX_PAIR_COST + EPSILON ||
    plan.availableDepth + EPSILON < completionShares ||
    !validOrder(favorite, cap, completionShares)
  ) {
    plan.managementStage = "wait-completion-depth";
    return plan;
  }

  const signature = depthSignature(favorite, cap);
  const tradeKey =
    `${V12_PREFIX}${event.slug}:favorite-completion:` +
    `${cheapFilled}:${favoriteFilled}:${signature}`;
  const existingKeys = new Set(orders.map((order) => order.tradeKey));
  if (!tracker.has(tradeKey) && !existingKeys.has(tradeKey)) {
    plan.opportunities.push(
      opportunity(
        event,
        favorite,
        "expensive",
        cap,
        completionShares,
        tradeKey,
        `favorite-completion-${signature}`,
        "fok",
        plan.plannedPairCost,
      ),
    );
    plan.managementStage = "favorite-completion";
  }
  return plan;
}
