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
const V9_PREFIX = "ladder-v9:";

export const LADDER_V9_PHASE: LadderPhase = {
  id: "5-2",
  minutesLeftMin: 2,
  minutesLeftMax: 5,
  rungs: [{ lowPrice: 0.1, highPrice: 0.8 }],
};

export interface LadderV9Amendment {
  orderId: string;
  opportunity: TradeOpportunity;
}

export interface LadderV9Plan {
  cancelOrderIds: string[];
  amendments: LadderV9Amendment[];
  opportunities: TradeOpportunity[];
  flattenOpportunities: TradeOpportunity[];
  filledSharesByOutcome: Record<string, number>;
  pairedShares: number;
  unmatchedCheapShares: number;
  unmatchedFavoriteShares: number;
  completionAttempts: number;
  maximumCompletionPrice: number | null;
  managementStage: string;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function secondsLeft(event: UpDownEvent, nowSeconds: number): number {
  return event.windowEnd - nowSeconds;
}

function entryIsActive(event: UpDownEvent, nowSeconds: number): boolean {
  const remaining = secondsLeft(event, nowSeconds);
  return remaining > 120 && remaining <= 300;
}

function managementIsActive(
  _config: BotConfig,
  event: UpDownEvent,
  nowSeconds: number,
): boolean {
  const remaining = secondsLeft(event, nowSeconds);
  return remaining > 0 && remaining <= 300;
}

function isV9Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V9_PREFIX) ?? false;
}

function role(order: PaperOrder): string {
  return isV9Order(order) ? (order.pairId ?? "").slice(V9_PREFIX.length) : "";
}

function opportunity(
  event: UpDownEvent,
  token: TokenBook,
  kind: TradeOpportunity["kind"],
  price: number,
  size: number,
  tradeKey: string,
  pairRole: string,
  orderPolicy: NonNullable<TradeOpportunity["orderPolicy"]>,
): TradeOpportunity {
  return {
    kind,
    event,
    token,
    price: round(price, 4),
    size: round(size),
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    strategyMode: "ladder_v9",
    phaseId: LADDER_V9_PHASE.id,
    pairId: `${V9_PREFIX}${pairRole}`,
    orderPolicy,
  };
}

function orderFills(
  snapshot: MarketExecutionSnapshot,
  orders: PaperOrder[],
): PaperFill[] {
  const ids = new Set(orders.map((order) => order.id));
  return snapshot.fills.filter((fill) => ids.has(fill.orderId));
}

function buyFillsForToken(
  snapshot: MarketExecutionSnapshot,
  orders: PaperOrder[],
  tokenId: string,
): PaperFill[] {
  return orderFills(snapshot, orders).filter(
    (fill) => fill.tokenId === tokenId && (fill.side ?? "BUY") === "BUY",
  );
}

function netSharesForToken(
  snapshot: MarketExecutionSnapshot,
  orders: PaperOrder[],
  tokenId: string,
): number {
  return round(
    orderFills(snapshot, orders)
      .filter((fill) => fill.tokenId === tokenId)
      .reduce(
        (sum, fill) =>
          sum + (fill.side === "SELL" ? -fill.size : fill.size),
        0,
      ),
  );
}

function allInAverage(fills: PaperFill[]): number | null {
  const size = fills.reduce((sum, fill) => sum + fill.size, 0);
  if (size <= EPSILON) return null;
  return (
    fills.reduce(
      (sum, fill) => sum + fill.price * fill.size + fill.fee,
      0,
    ) / size
  );
}

function maximumCompletionPrice(
  otherAllIn: number,
  maximumPairCost: number,
  feeRate: number,
  exponent: number,
  tickSize: number,
): number | null {
  const tick = Math.max(0.0001, tickSize);
  let selected: number | null = null;
  for (let price = tick; price < 1 - tick / 2; price += tick) {
    const normalized = round(price, 4);
    const fee = feeRate * Math.pow(normalized * (1 - normalized), exponent);
    if (otherAllIn + normalized + fee <= maximumPairCost + EPSILON) {
      selected = normalized;
    }
  }
  return selected;
}

function takerFeePerShare(
  snapshot: MarketExecutionSnapshot,
  price: number,
): number {
  return (
    snapshot.takerFeeRate *
    Math.pow(price * (1 - price), snapshot.takerFeeExponent)
  );
}

function flattenPaysMore(
  snapshot: MarketExecutionSnapshot,
  held: TokenBook,
  completion: TokenBook,
): boolean {
  if (held.bestBid === null) return false;
  if (completion.bestAsk === null) return true;
  const flattenProceeds =
    held.bestBid - takerFeePerShare(snapshot, held.bestBid);
  const completionValue =
    1 -
    completion.bestAsk -
    takerFeePerShare(snapshot, completion.bestAsk);
  return flattenProceeds > completionValue + EPSILON;
}

function validOrder(token: TokenBook, price: number, size: number): boolean {
  return (
    size > EPSILON &&
    size + EPSILON >= token.minOrderSize &&
    size * price + EPSILON >= 1
  );
}

function basePlan(
  books: TokenBook[],
  cheap: TokenBook,
  favorite: TokenBook,
  cheapShares: number,
  favoriteShares: number,
  completionAttempts: number,
  maximumPrice: number | null,
  stage: string,
): LadderV9Plan {
  return {
    cancelOrderIds: [],
    amendments: [],
    opportunities: [],
    flattenOpportunities: [],
    filledSharesByOutcome: Object.fromEntries(
      books.map((book) => [
        book.outcome,
        book.tokenId === cheap.tokenId ? cheapShares : favoriteShares,
      ]),
    ),
    pairedShares: round(Math.min(cheapShares, favoriteShares)),
    unmatchedCheapShares: round(Math.max(0, cheapShares - favoriteShares)),
    unmatchedFavoriteShares: round(Math.max(0, favoriteShares - cheapShares)),
    completionAttempts,
    maximumCompletionPrice: maximumPrice,
    managementStage: stage,
  };
}

function lastCompletionAt(orders: PaperOrder[]): number | null {
  const timestamps = orders
    .filter((order) => role(order).startsWith("favorite-completion-"))
    .map((order) => Date.parse(order.createdAt))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function nextFlattenAttempt(
  orders: PaperOrder[],
  prefix: string,
  retryLimit: number,
  cooldownMs: number,
  nowSeconds: number,
): number | null {
  const attempts = orders.filter((order) => role(order).startsWith(prefix));
  if (attempts.length >= retryLimit) return null;
  const latest = attempts
    .map((order) => Date.parse(order.createdAt))
    .filter(Number.isFinite)
    .reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  if (
    Number.isFinite(latest) &&
    nowSeconds * 1_000 - latest < cooldownMs
  ) {
    return null;
  }
  return attempts.length + 1;
}

export async function planLadderV9(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  books: TokenBook[],
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1_000,
): Promise<LadderV9Plan> {
  const entryActive = entryIsActive(event, nowSeconds);
  const managementActive = managementIsActive(config, event, nowSeconds);
  const v9Orders = snapshot.orders.filter(isV9Order);
  let lock = tracker.getLock(event.slug, LADDER_V9_PHASE.id);
  if (!lock) {
    const existingCheap = v9Orders.find((order) => role(order) === "cheap-entry");
    const cheapBook = existingCheap
      ? books.find((book) => book.tokenId === existingCheap.tokenId)
      : undefined;
    const favoriteBook = cheapBook
      ? books.find((book) => book.tokenId !== cheapBook.tokenId)
      : undefined;
    if (cheapBook && favoriteBook) {
      lock = {
        marketSlug: event.slug,
        phaseId: LADDER_V9_PHASE.id,
        cheapTokenId: cheapBook.tokenId,
        cheapOutcome: cheapBook.outcome,
        favoriteTokenId: favoriteBook.tokenId,
        favoriteOutcome: favoriteBook.outcome,
        createdAt: existingCheap?.createdAt ?? new Date().toISOString(),
      };
    }
  }
  if (!lock && entryActive) {
    lock =
      (await tracker.lockPhase(event, LADDER_V9_PHASE, books)) ?? undefined;
  }
  if (!lock) {
    const emptyBook = books[0];
    if (!emptyBook) {
      throw new Error("ladder_v9 requires two outcome books");
    }
    return basePlan(books, emptyBook, emptyBook, 0, 0, 0, null, "idle");
  }

  const cheap = books.find((book) => book.tokenId === lock?.cheapTokenId);
  const favorite = books.find((book) => book.tokenId === lock?.favoriteTokenId);
  if (!cheap || !favorite) {
    throw new Error("ladder_v9 phase lock does not match the current books");
  }

  const cheapBuyFills = buyFillsForToken(
    snapshot,
    v9Orders,
    cheap.tokenId,
  );
  const favoriteBuyFills = buyFillsForToken(
    snapshot,
    v9Orders,
    favorite.tokenId,
  );
  const cheapShares = netSharesForToken(
    snapshot,
    v9Orders,
    cheap.tokenId,
  );
  const favoriteShares = netSharesForToken(
    snapshot,
    v9Orders,
    favorite.tokenId,
  );
  const completionOrders = v9Orders.filter((order) =>
    role(order).startsWith("favorite-completion-"),
  );
  const tickSize = Number(tickSizeFromMarket(event.market));
  const cheapAllIn = allInAverage(cheapBuyFills);
  const favoriteAllIn = allInAverage(favoriteBuyFills);
  const normalPairCost = 1 - config.ladderV9MinLockedEdge;
  const normalFavoriteCap =
    cheapAllIn === null
      ? null
      : maximumCompletionPrice(
          cheapAllIn,
          normalPairCost,
          snapshot.takerFeeRate,
          snapshot.takerFeeExponent,
          tickSize,
        );
  let plan = basePlan(
    books,
    cheap,
    favorite,
    cheapShares,
    favoriteShares,
    completionOrders.length,
    normalFavoriteCap,
    entryActive ? "entry" : managementActive ? "management" : "closed",
  );

  if (!entryActive && !managementActive) return plan;

  const cheapEntry = v9Orders.find((order) => role(order) === "cheap-entry");
  const favoriteInitial = v9Orders.find(
    (order) => role(order) === "favorite-initial",
  );
  const existingKeys = new Set(v9Orders.map((order) => order.tradeKey));

  if (entryActive && !cheapEntry) {
    const tradeKey = `${V9_PREFIX}${event.slug}:5-2:cheap-entry`;
    if (!tracker.has(tradeKey) && !existingKeys.has(tradeKey)) {
      const policy =
        cheap.bestAsk !== null &&
        cheap.bestAsk <= config.ladderV9CheapPrice + EPSILON
          ? "fak"
          : "post_only";
      if (
        validOrder(
          cheap,
          config.ladderV9CheapPrice,
          config.ladderV9TargetShares,
        )
      ) {
        plan.opportunities.push(
          opportunity(
            event,
            cheap,
            "cheap",
            config.ladderV9CheapPrice,
            config.ladderV9TargetShares,
            tradeKey,
            "cheap-entry",
            policy,
          ),
        );
      }
    }
    return plan;
  }

  if (
    entryActive &&
    cheapEntry &&
    !favoriteInitial &&
    cheapEntry.status !== "cancelled"
  ) {
    const tradeKey = `${V9_PREFIX}${event.slug}:5-2:favorite-initial`;
    const size = Math.min(
      config.ladderV9InitialFavoriteShares,
      config.ladderV9TargetShares,
    );
    if (
      !tracker.has(tradeKey) &&
      !existingKeys.has(tradeKey) &&
      validOrder(favorite, config.ladderV9InitialFavoritePrice, size)
    ) {
      plan.opportunities.push(
        opportunity(
          event,
          favorite,
          "expensive",
          config.ladderV9InitialFavoritePrice,
          size,
          tradeKey,
          "favorite-initial",
          "fak",
        ),
      );
    }
    return plan;
  }

  const remainingSeconds = secondsLeft(event, nowSeconds);
  if (
    remainingSeconds <= 120 &&
    cheapShares <= EPSILON &&
    favoriteShares <= EPSILON
  ) {
    plan.cancelOrderIds = snapshot.openOrders
      .filter(isV9Order)
      .map((order) => order.id);
    plan.managementStage = "cancel-empty";
    return plan;
  }

  const unmatchedCheap = Math.max(0, cheapShares - favoriteShares);
  const unmatchedFavorite = Math.max(0, favoriteShares - cheapShares);
  const terminalWindow = remainingSeconds <= 20;
  const finalDecision =
    remainingSeconds <= config.ladderV9ManagementCutoffSeconds;

  if (unmatchedCheap > EPSILON) {
    const pairCost = terminalWindow
      ? config.ladderV9EmergencyMaxPairCost
      : normalPairCost;
    const cap =
      cheapAllIn === null
        ? null
        : maximumCompletionPrice(
            cheapAllIn,
            pairCost,
            snapshot.takerFeeRate,
            snapshot.takerFeeExponent,
            tickSize,
          );
    plan.maximumCompletionPrice = cap;
    const activeCompletion = snapshot.openOrders.some((order) =>
      role(order).startsWith("favorite-completion-"),
    );
    const terminalRole = "favorite-terminal-completion";
    const terminalOrder = v9Orders.find((order) => role(order) === terminalRole);
    const canCross =
      cap !== null && favorite.bestAsk !== null && favorite.bestAsk <= cap + EPSILON;
    const preferFlatten =
      finalDecision && flattenPaysMore(snapshot, cheap, favorite);
    if (terminalWindow) {
      if (!terminalOrder && canCross && !activeCompletion && !preferFlatten) {
        const tradeKey = `${V9_PREFIX}${event.slug}:5-2:${terminalRole}`;
        plan.opportunities.push(
          opportunity(
            event,
            favorite,
            "expensive",
            cap!,
            Math.min(unmatchedCheap, config.ladderV9TargetShares - favoriteShares),
            tradeKey,
            terminalRole,
            "fak",
          ),
        );
        plan.managementStage = "favorite-emergency-completion";
        return plan;
      }
      if (finalDecision && (!canCross || terminalOrder || preferFlatten)) {
        const size = unmatchedCheap;
        const bid = cheap.bestBid;
        const attempt = nextFlattenAttempt(
          v9Orders,
          "flatten-cheap-",
          config.ladderV9CompletionRetryLimit,
          config.ladderV9CompletionCooldownMs,
          nowSeconds,
        );
        if (bid !== null && attempt !== null && validOrder(cheap, bid, size)) {
          const flattenRole = `flatten-cheap-${attempt}`;
          const tradeKey = `${V9_PREFIX}${event.slug}:5-2:${flattenRole}`;
          if (!existingKeys.has(tradeKey) && !tracker.has(tradeKey)) {
            plan.flattenOpportunities.push(
              opportunity(
                event,
                cheap,
                "cheap",
                bid,
                size,
                tradeKey,
                flattenRole,
                "fak",
              ),
            );
            plan.managementStage = "flatten-cheap";
          }
        }
      }
      return plan;
    }

    const latestCompletion = lastCompletionAt(v9Orders);
    const cooldownElapsed =
      latestCompletion === null ||
      nowSeconds * 1_000 - latestCompletion >=
        config.ladderV9CompletionCooldownMs;
    if (
      cap !== null &&
      completionOrders.length < config.ladderV9CompletionRetryLimit &&
      !activeCompletion &&
      cooldownElapsed
    ) {
      const attempt = completionOrders.length + 1;
      const completionRole = `favorite-completion-${attempt}`;
      const tradeKey = `${V9_PREFIX}${event.slug}:5-2:${completionRole}`;
      const size = Math.min(
        unmatchedCheap,
        config.ladderV9TargetShares - favoriteShares,
      );
      if (validOrder(favorite, cap, size)) {
        plan.opportunities.push(
          opportunity(
            event,
            favorite,
            "expensive",
            cap,
            size,
            tradeKey,
            completionRole,
            "fak",
          ),
        );
        plan.managementStage = "favorite-completion";
      }
    }
    return plan;
  }

  if (unmatchedFavorite > EPSILON && favoriteAllIn !== null) {
    const firstFavoriteFillAt = Math.min(
      ...favoriteBuyFills.map((fill) => Date.parse(fill.timestamp)),
    );
    const ageSeconds = Number.isFinite(firstFavoriteFillAt)
      ? (nowSeconds * 1_000 - firstFavoriteFillAt) / 1_000
      : 0;
    let stage = "hold-10";
    let scheduledPrice = config.ladderV9CheapPrice;
    let pairCost = normalPairCost;
    let policy: NonNullable<TradeOpportunity["orderPolicy"]> = "gtc";
    if (remainingSeconds <= 20) {
      stage = "emergency-20";
      pairCost = config.ladderV9EmergencyMaxPairCost;
      policy = "fak";
    } else if (remainingSeconds <= 45) {
      stage = "rescue-45";
      pairCost = config.ladderV9RescueMaxPairCost;
      policy = "fak";
    } else if (remainingSeconds <= 90) {
      stage = "rescue-15";
      scheduledPrice = 0.15;
    } else if (ageSeconds >= 45) {
      stage = "rescue-12";
      scheduledPrice = 0.12;
    }
    const cap = maximumCompletionPrice(
      favoriteAllIn,
      pairCost,
      snapshot.takerFeeRate,
      snapshot.takerFeeExponent,
      tickSize,
    );
    plan.maximumCompletionPrice = cap;
    plan.managementStage = stage;
    if (cap === null) return plan;
    const targetPrice = policy === "fak" ? cap : Math.min(scheduledPrice, cap);
    const openCheapOrder = snapshot.openOrders.find(
      (order) => isV9Order(order) && order.tokenId === cheap.tokenId,
    );
    if (policy === "fak" && openCheapOrder) {
      plan.cancelOrderIds = [openCheapOrder.id];
      return plan;
    }
    if (policy === "gtc" && openCheapOrder) {
      if (
        Math.abs(openCheapOrder.limitPrice - targetPrice) > EPSILON ||
        Math.abs(openCheapOrder.remainingSize - unmatchedFavorite) > EPSILON
      ) {
        const amendRole = `amend-${stage}`;
        plan.amendments.push({
          orderId: openCheapOrder.id,
          opportunity: opportunity(
            event,
            cheap,
            "cheap",
            targetPrice,
            unmatchedFavorite,
            `${V9_PREFIX}${event.slug}:5-2:${amendRole}`,
            amendRole,
            "gtc",
          ),
        });
      }
      return plan;
    }

    const canCross = cheap.bestAsk !== null && cheap.bestAsk <= cap + EPSILON;
    const preferFlatten =
      finalDecision && flattenPaysMore(snapshot, favorite, cheap);
    const rescueRole = `cheap-${stage}`;
    const existingRescue = v9Orders.find((order) => role(order) === rescueRole);
    if (
      policy === "fak" &&
      (!canCross || existingRescue || preferFlatten)
    ) {
      if (finalDecision) {
        const bid = favorite.bestBid;
        const attempt = nextFlattenAttempt(
          v9Orders,
          "flatten-favorite-",
          config.ladderV9CompletionRetryLimit,
          config.ladderV9CompletionCooldownMs,
          nowSeconds,
        );
        if (
          bid !== null &&
          attempt !== null &&
          validOrder(favorite, bid, unmatchedFavorite)
        ) {
          const flattenRole = `flatten-favorite-${attempt}`;
          const tradeKey = `${V9_PREFIX}${event.slug}:5-2:${flattenRole}`;
          if (!existingKeys.has(tradeKey) && !tracker.has(tradeKey)) {
            plan.flattenOpportunities.push(
              opportunity(
                event,
                favorite,
                "expensive",
                bid,
                unmatchedFavorite,
                tradeKey,
                flattenRole,
                "fak",
              ),
            );
            plan.managementStage = "flatten-favorite";
          }
        }
      }
      return plan;
    }
    const tradeKey = `${V9_PREFIX}${event.slug}:5-2:${rescueRole}`;
    if (
      !existingRescue &&
      !tracker.has(tradeKey) &&
      validOrder(cheap, targetPrice, unmatchedFavorite)
    ) {
      plan.opportunities.push(
        opportunity(
          event,
          cheap,
          "cheap",
          targetPrice,
          unmatchedFavorite,
          tradeKey,
          rescueRole,
          policy,
        ),
      );
    }
  }

  return plan;
}
