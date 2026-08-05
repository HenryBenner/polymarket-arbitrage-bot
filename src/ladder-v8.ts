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
const V8_PREFIX = "ladder-v8:";
const V8_PHASE_ID = "15-2";
const V8_FLIP_COMPLETION_PAIR_ID = `${V8_PREFIX}flip-completion`;
const V8_COMPLETION_PAIR_COST = 0.99;

export const LADDER_V8_LOW_PRICES = [
  0.45,
  0.4,
  0.35,
  0.3,
  0.25,
  0.2,
  0.15,
  0.1,
  0.05,
] as const;

export const LADDER_V8_SIZE_SCHEDULE = [
  { startHourEt: 0, endHourEt: 6, shares: 5 },
  { startHourEt: 6, endHourEt: 9, shares: 16 },
  { startHourEt: 9, endHourEt: 15, shares: 120 },
  { startHourEt: 15, endHourEt: 18, shares: 32 },
  { startHourEt: 18, endHourEt: 24, shares: 8 },
] as const;

export const LADDER_V8_PHASE: LadderPhase = {
  id: V8_PHASE_ID,
  minutesLeftMin: 2,
  minutesLeftMax: 15,
  rungs: LADDER_V8_LOW_PRICES.map((lowPrice) => ({
    lowPrice,
    highPrice: round(1 - lowPrice, 2),
  })),
};

export interface LadderV8Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  filledSharesByOutcome: Record<string, number>;
  pairedShares: number;
  unmatchedShares: number;
  scheduledShares: number;
  flipLocked: boolean;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorShares(value: number): number {
  return round(
    Math.floor((value + EPSILON) / SHARE_STEP) * SHARE_STEP,
  );
}

function minutesLeft(event: UpDownEvent, nowSeconds: number): number {
  return (event.windowEnd - nowSeconds) / 60;
}

function easternHour(epochSeconds: number): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochSeconds * 1_000));
  return Number(hour);
}

export function ladderV8ScheduledShares(
  event: UpDownEvent,
  sizeScale = 1,
  maxShares = Number.POSITIVE_INFINITY,
): number {
  const hourEt = easternHour(event.windowStart);
  const tier = LADDER_V8_SIZE_SCHEDULE.find(
    ({ startHourEt, endHourEt }) =>
      hourEt >= startHourEt && hourEt < endHourEt,
  );
  if (!tier) return 0;
  return floorShares(Math.min(tier.shares * sizeScale, maxShares));
}

export function ladderV8IsActive(
  event: UpDownEvent,
  nowSeconds = Date.now() / 1_000,
): boolean {
  const remaining = minutesLeft(event, nowSeconds);
  return remaining > 2 && remaining <= 15;
}

function isV8Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V8_PREFIX) ?? false;
}

function fillsForOrders(
  snapshot: MarketExecutionSnapshot,
): PaperFill[] {
  const ids = new Set(
    snapshot.orders.filter(isV8Order).map((order) => order.id),
  );
  return snapshot.fills.filter((fill) => ids.has(fill.orderId));
}

function filledShares(
  books: readonly TokenBook[],
  fills: readonly PaperFill[],
): Map<string, number> {
  return new Map(
    books.map((book) => [
      book.tokenId,
      round(
        fills
          .filter((fill) => fill.tokenId === book.tokenId)
          .reduce((sum, fill) => sum + fill.size, 0),
      ),
    ]),
  );
}

function planSummary(
  cancelOrderIds: string[],
  books: readonly TokenBook[],
  fills: readonly PaperFill[],
  scheduledShares: number,
  flipLocked = false,
): LadderV8Plan {
  const shares = filledShares(books, fills);
  const values = books.map((book) => shares.get(book.tokenId) ?? 0);
  const paired = values.length === 2 ? Math.min(...values) : 0;
  const maximum = values.length > 0 ? Math.max(...values) : 0;
  return {
    cancelOrderIds,
    opportunities: [],
    filledSharesByOutcome: Object.fromEntries(
      books.map((book) => [book.outcome, shares.get(book.tokenId) ?? 0]),
    ),
    pairedShares: round(paired),
    unmatchedShares: round(maximum - paired),
    scheduledShares,
    flipLocked,
  };
}

function heavyTokenId(
  books: readonly TokenBook[],
  fills: readonly PaperFill[],
): string | null {
  if (books.length !== 2) return null;
  const shares = filledShares(books, fills);
  const left = shares.get(books[0]!.tokenId) ?? 0;
  const right = shares.get(books[1]!.tokenId) ?? 0;
  if (Math.abs(left - right) <= EPSILON) return null;
  return left > right ? books[0]!.tokenId : books[1]!.tokenId;
}

function flipCompletionOpportunity(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  books: readonly TokenBook[],
  fills: readonly PaperFill[],
  scheduledShares: number,
): TradeOpportunity | null {
  if (books.length !== 2) return null;
  const shares = filledShares(books, fills);
  const ranked = [...books].sort(
    (left, right) =>
      (shares.get(right.tokenId) ?? 0) -
      (shares.get(left.tokenId) ?? 0),
  );
  const heavy = ranked[0];
  const deficient = ranked[1];
  if (!heavy || !deficient || deficient.bestAsk === null) return null;
  const heavyShares = shares.get(heavy.tokenId) ?? 0;
  const deficientShares = shares.get(deficient.tokenId) ?? 0;
  const unmatchedShares = floorShares(heavyShares - deficientShares);
  if (unmatchedShares <= EPSILON) return null;

  // Treat the most expensive heavy fills as already paired first. The
  // remaining highest entry price is therefore a conservative bound for a
  // completion order that keeps every new pair at or below 0.99.
  let sharesToPair = deficientShares;
  const heavyLots = fills
    .filter((fill) => fill.tokenId === heavy.tokenId)
    .map((fill) => ({ price: fill.price, shares: fill.size }))
    .sort((left, right) => right.price - left.price);
  for (const lot of heavyLots) {
    const paired = Math.min(lot.shares, sharesToPair);
    lot.shares = round(lot.shares - paired);
    sharesToPair = round(sharesToPair - paired);
    if (sharesToPair <= EPSILON) break;
  }
  const residualPrices = heavyLots
    .filter((lot) => lot.shares > EPSILON)
    .map((lot) => lot.price);
  if (residualPrices.length === 0) return null;

  const tickSize = Number(tickSizeFromMarket(event.market));
  if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
  const highestResidualEntry = Math.max(...residualPrices);
  const price = round(
    Math.floor(
      (V8_COMPLETION_PAIR_COST - highestResidualEntry + EPSILON) /
        tickSize,
    ) * tickSize,
  );
  const size = floorShares(
    Math.min(
      unmatchedShares,
      scheduledShares,
      config.ladderV8MaxSharesPerOrder,
    ),
  );
  if (
    price <= EPSILON ||
    price >= 1 ||
    price + EPSILON >= deficient.bestAsk ||
    size + EPSILON < deficient.minOrderSize
  ) {
    return null;
  }

  const tradeKey =
    `${V8_PREFIX}${event.slug}:flip-completion:${deficient.outcome}`;
  if (tracker.has(tradeKey)) return null;
  return {
    kind: "maker",
    event,
    token: deficient,
    price,
    size,
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    strategyMode: "ladder_v8",
    phaseId: V8_PHASE_ID,
    pairId: V8_FLIP_COMPLETION_PAIR_ID,
    orderPolicy: "post_only",
  };
}

export async function planLadderV8(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  books: TokenBook[],
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1_000,
): Promise<LadderV8Plan> {
  const v8Orders = snapshot.orders.filter(isV8Order);
  const v8OpenOrders = snapshot.openOrders.filter(isV8Order);
  const v8Fills = fillsForOrders(snapshot);
  const scheduledShares = ladderV8ScheduledShares(
    event,
    config.ladderV8SizeScale,
    config.ladderV8MaxSharesPerOrder,
  );
  const remaining = minutesLeft(event, nowSeconds);
  const active = ladderV8IsActive(event, nowSeconds);
  const heavy = heavyTokenId(books, v8Fills);
  const current = planSummary([], books, v8Fills, scheduledShares);

  if (remaining <= 0 || remaining > 15) {
    return planSummary(
      v8OpenOrders.map((order) => order.id),
      books,
      v8Fills,
      scheduledShares,
      tracker.isExposureBlocked(event.slug),
    );
  }

  const flipLocked = tracker.isExposureBlocked(event.slug);
  if (flipLocked) {
    if (!active) {
      return planSummary(
        v8OpenOrders.map((order) => order.id),
        books,
        v8Fills,
        scheduledShares,
        true,
      );
    }
    const staleOpeningOrderIds = v8OpenOrders
      .filter((order) => order.pairId !== V8_FLIP_COMPLETION_PAIR_ID)
      .map((order) => order.id);
    if (staleOpeningOrderIds.length > 0) {
      return planSummary(
        staleOpeningOrderIds,
        books,
        v8Fills,
        scheduledShares,
        true,
      );
    }
    const completionAlreadyOpen = v8OpenOrders.some(
      (order) => order.pairId === V8_FLIP_COMPLETION_PAIR_ID,
    );
    const completion = completionAlreadyOpen
      ? null
      : flipCompletionOpportunity(
          config,
          tracker,
          event,
          books,
          v8Fills,
          scheduledShares,
        );
    return {
      ...planSummary([], books, v8Fills, scheduledShares, true),
      opportunities: completion ? [completion] : [],
    };
  }

  if (!active) {
    const cancelOrderIds =
      heavy === null
        ? v8OpenOrders.map((order) => order.id)
        : v8OpenOrders
            .filter((order) => order.tokenId === heavy)
            .map((order) => order.id);
    return planSummary(
      cancelOrderIds,
      books,
      v8Fills,
      scheduledShares,
    );
  }

  const imbalanceBlockedToken =
    current.unmatchedShares + EPSILON >=
      config.ladderV8MaxUnmatchedShares
      ? heavy
      : null;
  if (imbalanceBlockedToken !== null) {
    const cancelOrderIds = v8OpenOrders
      .filter((order) => order.tokenId === imbalanceBlockedToken)
      .map((order) => order.id);
    if (cancelOrderIds.length > 0) {
      return planSummary(
        cancelOrderIds,
        books,
        v8Fills,
        scheduledShares,
      );
    }
  }

  const completeBooks = books.filter((book) => book.bestAsk !== null);
  if (completeBooks.length !== 2 || scheduledShares <= EPSILON) {
    return current;
  }
  const lock = await tracker.lockPhase(
    event,
    LADDER_V8_PHASE,
    completeBooks,
  );
  if (!lock) return current;
  const ranked = [...completeBooks].sort((left, right) => {
    const askDifference = (left.bestAsk ?? 1) - (right.bestAsk ?? 1);
    return askDifference !== 0
      ? askDifference
      : left.outcomeIndex - right.outcomeIndex;
  });
  const cheap = ranked[0];
  const favorite = ranked[1];
  if (!cheap || !favorite) return current;
  if (favorite.tokenId !== lock.favoriteTokenId) {
    await tracker.blockExposure(event.slug);
    return planSummary(
      v8OpenOrders.map((order) => order.id),
      books,
      v8Fills,
      scheduledShares,
      true,
    );
  }

  const lockedCheap = completeBooks.find(
    (book) => book.tokenId === lock.cheapTokenId,
  );
  const lockedFavorite = completeBooks.find(
    (book) => book.tokenId === lock.favoriteTokenId,
  );
  if (!lockedCheap || !lockedFavorite) return current;

  const existingKeys = new Set(v8Orders.map((order) => order.tradeKey));
  for (const lowPrice of LADDER_V8_LOW_PRICES) {
    const highPrice = round(1 - lowPrice, 2);
    const pairId = `${V8_PREFIX}${lowPrice.toFixed(2)}-${highPrice.toFixed(2)}`;
    const definitions = [
      { kind: "cheap" as const, token: lockedCheap, price: lowPrice },
      { kind: "expensive" as const, token: lockedFavorite, price: highPrice },
    ];
    for (const definition of definitions) {
      if (definition.token.tokenId === imbalanceBlockedToken) continue;
      if (
        definition.token.bestAsk === null ||
        definition.price + EPSILON >= definition.token.bestAsk
      ) {
        continue;
      }
      if (scheduledShares + EPSILON < definition.token.minOrderSize) {
        continue;
      }
      const tradeKey =
        `${V8_PREFIX}${event.slug}:${definition.token.outcome}:` +
        definition.price.toFixed(2);
      if (tracker.has(tradeKey) || existingKeys.has(tradeKey)) continue;
      return {
        ...current,
        opportunities: [
          {
            kind: definition.kind,
            event,
            token: definition.token,
            price: definition.price,
            size: scheduledShares,
            tickSize: tickSizeFromMarket(event.market),
            negRisk: event.market.negRisk,
            tradeKey,
            strategyMode: "ladder_v8",
            phaseId: V8_PHASE_ID,
            pairId,
            orderPolicy: "post_only",
          },
        ],
      };
    }
  }

  return current;
}
