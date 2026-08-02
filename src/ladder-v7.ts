import type { BotConfig } from "./config.js";
import { LadderTracker, pairedShares } from "./ladder.js";
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
const V7_PREFIX = "ladder-v7:";

export const LADDER_V7_PHASE: LadderPhase = {
  id: "5-2",
  minutesLeftMin: 2,
  minutesLeftMax: 5,
  rungs: [{ lowPrice: 0.1, highPrice: 0.8 }],
};

export interface LadderV7Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  filledSharesByOutcome: Record<string, number>;
  pairedShares: number;
  unmatchedShares: number;
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

export function ladderV7IsActive(
  event: UpDownEvent,
  nowSeconds = Date.now() / 1_000,
): boolean {
  const remaining = minutesLeft(event, nowSeconds);
  return (
    remaining > LADDER_V7_PHASE.minutesLeftMin &&
    remaining <= LADDER_V7_PHASE.minutesLeftMax
  );
}

function isV7Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(V7_PREFIX) ?? false;
}

function fillsForOrders(
  snapshot: MarketExecutionSnapshot,
): PaperFill[] {
  const ids = new Set(
    snapshot.orders.filter(isV7Order).map((order) => order.id),
  );
  return snapshot.fills.filter((fill) => ids.has(fill.orderId));
}

function filledShares(
  books: TokenBook[],
  fills: PaperFill[],
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

function emptyPlan(
  cancelOrderIds: string[],
  books: TokenBook[],
  fills: PaperFill[],
): LadderV7Plan {
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
  };
}

export async function planLadderV7(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  books: TokenBook[],
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1_000,
): Promise<LadderV7Plan> {
  const v7Fills = fillsForOrders(snapshot);
  const active = ladderV7IsActive(event, nowSeconds);
  const cancelOrderIds = snapshot.openOrders
    .filter((order) => isV7Order(order) && !active)
    .map((order) => order.id);
  const base = emptyPlan(cancelOrderIds, books, v7Fills);
  if (!active) return base;

  const completeBooks = books.filter((book) => book.bestAsk !== null);
  if (completeBooks.length !== 2) return base;
  const lock = await tracker.lockPhase(
    event,
    LADDER_V7_PHASE,
    completeBooks,
  );
  if (!lock) return base;

  const cheap = completeBooks.find(
    (book) => book.tokenId === lock.cheapTokenId,
  );
  const favorite = completeBooks.find(
    (book) => book.tokenId === lock.favoriteTokenId,
  );
  if (!cheap || !favorite) return base;

  const size = floorShares(
    Math.min(
      pairedShares(
        config.ladderV7CheapPrice,
        config.ladderV7FavoritePrice,
        cheap.minOrderSize,
        favorite.minOrderSize,
        config.ladderSizeScale,
      ),
      config.ladderV7MaxShares,
    ),
  );
  if (size <= EPSILON) return base;

  const existingKeys = new Set(
    snapshot.orders.filter(isV7Order).map((order) => order.tradeKey),
  );
  const definitions = [
    {
      role: "cheap-maker",
      kind: "cheap" as const,
      token: cheap,
      price: config.ladderV7CheapPrice,
      orderPolicy: "post_only" as const,
      // A post-only rejection is intentional when the cheap ask already
      // crosses the rung. Skip it here so the one-shot favorite FAK is not
      // blocked behind an order that the venue must reject.
      eligible:
        cheap.bestAsk !== null &&
        config.ladderV7CheapPrice + EPSILON < cheap.bestAsk,
    },
    {
      role: "favorite-fak",
      kind: "expensive" as const,
      token: favorite,
      price: config.ladderV7FavoritePrice,
      orderPolicy: "fak" as const,
      eligible: true,
    },
  ];

  for (const definition of definitions) {
    if (!definition.eligible) continue;
    const tradeKey =
      `${V7_PREFIX}${event.slug}:${LADDER_V7_PHASE.id}:` +
      definition.role;
    if (tracker.has(tradeKey) || existingKeys.has(tradeKey)) continue;
    if (
      size + EPSILON < definition.token.minOrderSize ||
      size * definition.price + EPSILON < 1
    ) {
      continue;
    }
    return {
      ...base,
      opportunities: [
        {
          kind: definition.kind,
          event,
          token: definition.token,
          price: definition.price,
          size,
          tickSize: tickSizeFromMarket(event.market),
          negRisk: event.market.negRisk,
          tradeKey,
          strategyMode: "ladder_v7",
          phaseId: LADDER_V7_PHASE.id,
          pairId: `${V7_PREFIX}${definition.role}`,
          orderPolicy: definition.orderPolicy,
        },
      ],
    };
  }

  return base;
}
