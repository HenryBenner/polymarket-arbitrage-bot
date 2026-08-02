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
const PREFIX = "ladder-v5.5:";
const OPENING_PREFIX = `${PREFIX}opening:`;
const HEDGE_PREFIX = `${PREFIX}hedge:`;

export const LADDER_V5_5_PHASES: readonly LadderPhase[] = [
  {
    id: "15-10",
    minutesLeftMin: 10,
    minutesLeftMax: 15,
    rungs: [
      { lowPrice: 0.45, highPrice: 0.55 },
      { lowPrice: 0.4, highPrice: 0.6 },
    ],
  },
  {
    id: "10-5",
    minutesLeftMin: 5,
    minutesLeftMax: 10,
    rungs: [
      { lowPrice: 0.35, highPrice: 0.65 },
      { lowPrice: 0.3, highPrice: 0.7 },
      { lowPrice: 0.25, highPrice: 0.75 },
    ],
  },
  {
    id: "5-2",
    minutesLeftMin: 2,
    minutesLeftMax: 5,
    rungs: [
      { lowPrice: 0.2, highPrice: 0.8 },
      { lowPrice: 0.15, highPrice: 0.85 },
      { lowPrice: 0.1, highPrice: 0.9 },
    ],
  },
] as const;

export interface LadderV55Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  entryFilledShares: number;
  hedgedShares: number;
  pairedShares: number;
  unmatchedCheapShares: number;
  observedHedgeAllInPerShare: number | null;
  plannedAllInPairCost: number | null;
  plannedNetEdgePerPair: number | null;
}

interface CostLot {
  shares: number;
  unitCost: number;
  fillId: string;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorShares(value: number): number {
  return round(Math.floor((value + EPSILON) / SHARE_STEP) * SHARE_STEP);
}

function feePerShare(price: number, rate: number, exponent: number): number {
  return rate * Math.pow(price * (1 - price), exponent);
}

function isV55Order(order: PaperOrder): boolean {
  return order.pairId?.startsWith(PREFIX) ?? false;
}

function isOpeningOrder(order: PaperOrder): boolean {
  return order.pairId?.startsWith(OPENING_PREFIX) ?? false;
}

function isHedgeOrder(order: PaperOrder): boolean {
  return order.pairId?.startsWith(HEDGE_PREFIX) ?? false;
}

function openingPairId(phaseId: string, ceilingPrice: number): string {
  return `${OPENING_PREFIX}${phaseId}:${ceilingPrice.toFixed(2)}`;
}

function openingOrderMatchesRung(
  order: PaperOrder,
  phaseId: string,
  ceilingPrice: number,
): boolean {
  if (!isOpeningOrder(order) || order.phaseId !== phaseId) return false;
  const price = ceilingPrice.toFixed(2);
  return (
    order.pairId === openingPairId(phaseId, ceilingPrice) ||
    order.pairId === `${OPENING_PREFIX}${price}`
  );
}

function activePhase(remainingMinutes: number): LadderPhase | null {
  return (
    LADDER_V5_5_PHASES.find(
      (phase) =>
        remainingMinutes > phase.minutesLeftMin &&
        remainingMinutes <= phase.minutesLeftMax,
    ) ?? null
  );
}

function fillsForOrders(
  snapshot: MarketExecutionSnapshot,
  predicate: (order: PaperOrder) => boolean,
): PaperFill[] {
  const orderIds = new Set(snapshot.orders.filter(predicate).map((order) => order.id));
  return snapshot.fills.filter((fill) => orderIds.has(fill.orderId));
}

function sharesByToken(fills: PaperFill[]): Map<string, number> {
  const shares = new Map<string, number>();
  for (const fill of fills) {
    shares.set(fill.tokenId, round((shares.get(fill.tokenId) ?? 0) + fill.size));
  }
  return shares;
}

function unmatchedEntryLots(
  entryFills: PaperFill[],
  alreadyPairedShares: number,
): CostLot[] {
  let consumed = alreadyPairedShares;
  const lots = entryFills
    .map((fill) => ({
      shares: fill.size,
      unitCost: fill.price + (fill.size > EPSILON ? fill.fee / fill.size : 0),
      fillId: fill.id,
    }))
    .sort((left, right) => left.unitCost - right.unitCost);
  const remaining: CostLot[] = [];
  for (const lot of lots) {
    const paired = Math.min(consumed, lot.shares);
    consumed = round(consumed - paired);
    const shares = round(lot.shares - paired);
    if (shares > EPSILON) remaining.push({ ...lot, shares });
  }
  return remaining;
}

function costForShares(lots: CostLot[], shares: number): number {
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

function executableHedge(
  snapshot: MarketExecutionSnapshot,
  book: TokenBook,
  shares: number,
): { totalCost: number; limitPrice: number; allInPerShare: number } | null {
  let remaining = shares;
  let totalCost = 0;
  let limitPrice = 0;
  for (const ask of [...book.asks].sort((left, right) => left.price - right.price)) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, ask.size);
    if (selected <= EPSILON) continue;
    totalCost +=
      selected *
      (ask.price +
        feePerShare(ask.price, snapshot.takerFeeRate, snapshot.takerFeeExponent));
    limitPrice = ask.price;
    remaining = round(remaining - selected);
  }
  if (remaining > EPSILON || limitPrice <= 0) return null;
  return { totalCost, limitPrice, allInPerShare: totalCost / shares };
}

function floorPriceToTick(price: number, tickSize: number): number {
  return round(Math.floor((price + EPSILON) / tickSize) * tickSize, 6);
}

function maximumSafeEntryPrice(
  config: BotConfig,
  snapshot: MarketExecutionSnapshot,
  entryBook: TokenBook,
  hedge: { totalCost: number },
  shares: number,
  ceilingPrice: number,
  tickSize: number,
): number | null {
  if (entryBook.bestAsk === null || shares <= EPSILON) return null;
  const passiveCeiling = entryBook.bestAsk - tickSize;
  let candidate = floorPriceToTick(
    Math.min(ceilingPrice, passiveCeiling),
    tickSize,
  );
  while (candidate >= tickSize - EPSILON) {
    const entryAllIn =
      candidate +
      feePerShare(
        candidate,
        snapshot.makerFeeRate ?? 0,
        snapshot.takerFeeExponent,
      );
    const pairCost = (entryAllIn * shares + hedge.totalCost) / shares;
    if (pairCost <= config.ladderV5MaxPairCost + EPSILON) {
      return candidate;
    }
    candidate = round(candidate - tickSize, 6);
  }
  return null;
}

function restingEntryIsSafe(
  config: BotConfig,
  snapshot: MarketExecutionSnapshot,
  order: PaperOrder,
  hedgeBook: TokenBook,
): boolean {
  if (order.remainingSize <= EPSILON) return true;
  const hedge = executableHedge(snapshot, hedgeBook, order.remainingSize);
  if (!hedge) return false;
  const entryAllIn =
    order.limitPrice +
    feePerShare(
      order.limitPrice,
      snapshot.makerFeeRate ?? 0,
      snapshot.takerFeeExponent,
    );
  return (
    entryAllIn + hedge.totalCost / order.remainingSize <=
    config.ladderV5MaxPairCost + EPSILON
  );
}

function bookSignature(book: TokenBook, shares: number): string {
  let remaining = shares;
  const levels: string[] = [];
  for (const ask of [...book.asks].sort((left, right) => left.price - right.price)) {
    if (remaining <= EPSILON) break;
    const selected = Math.min(remaining, ask.size);
    if (selected <= EPSILON) continue;
    levels.push(`${ask.price.toFixed(4)}x${selected.toFixed(2)}`);
    remaining = round(remaining - selected);
  }
  return levels.join(",");
}

function emptyPlan(
  cancelOrderIds: string[],
  entryFilledShares: number,
  hedgedShares: number,
  paired: number,
  unmatched: number,
): LadderV55Plan {
  return {
    cancelOrderIds,
    opportunities: [],
    entryFilledShares,
    hedgedShares,
    pairedShares: paired,
    unmatchedCheapShares: unmatched,
    observedHedgeAllInPerShare: null,
    plannedAllInPairCost: null,
    plannedNetEdgePerPair: null,
  };
}

export async function planLadderV55(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1_000,
): Promise<LadderV55Plan> {
  const remainingMinutes = (event.windowEnd - nowSeconds) / 60;
  const phase = activePhase(remainingMinutes);
  const openingWindow = phase !== null;
  const beforeSettlement = remainingMinutes > 0;
  const v55Orders = snapshot.orders.filter(isV55Order);
  const v55OpenOrders = snapshot.openOrders.filter(isV55Order);
  const entryFills = fillsForOrders(snapshot, isOpeningOrder);
  const hedgeFills = fillsForOrders(snapshot, isHedgeOrder);
  const allFills = [...entryFills, ...hedgeFills];
  const entryFilledShares = round(entryFills.reduce((sum, fill) => sum + fill.size, 0));
  const hedgedShares = round(hedgeFills.reduce((sum, fill) => sum + fill.size, 0));
  const shares = sharesByToken(allFills);
  const tokenShares = snapshot.books.map((book) => shares.get(book.tokenId) ?? 0);
  const paired = tokenShares.length === 2 ? Math.min(...tokenShares) : 0;
  const unmatched = tokenShares.length === 2 ? Math.abs(tokenShares[0]! - tokenShares[1]!) : tokenShares[0] ?? 0;
  const staleOpeningOrderIds = v55OpenOrders
    .filter(
      (order) =>
        isOpeningOrder(order) &&
        (!phase || order.phaseId !== phase.id),
    )
    .map((order) => order.id);
  const base = emptyPlan(
    staleOpeningOrderIds,
    entryFilledShares,
    hedgedShares,
    round(paired),
    round(unmatched),
  );

  const completeBooks = snapshot.books.filter((book) => book.bestAsk !== null);
  if (completeBooks.length !== 2 || !beforeSettlement) {
    return { ...base, cancelOrderIds: v55OpenOrders.map((order) => order.id) };
  }

  if (unmatched <= EPSILON) {
    if (!openingWindow || !phase || staleOpeningOrderIds.length > 0) return base;
    const openEntry = v55OpenOrders.find(isOpeningOrder);
    if (openEntry) {
      const hedgeBook = completeBooks.find(
        (book) => book.tokenId !== openEntry.tokenId,
      );
      if (
        !hedgeBook ||
        !restingEntryIsSafe(config, snapshot, openEntry, hedgeBook)
      ) {
        return { ...base, cancelOrderIds: [openEntry.id] };
      }
      return base;
    }

    const nextRung = phase.rungs.find((rung, index) => {
      if (
        v55Orders.some((order) =>
          openingOrderMatchesRung(order, phase.id, rung.lowPrice),
        )
      ) {
        return false;
      }
      return phase.rungs
        .slice(0, index)
        .every((prior) =>
          v55Orders.some((order) =>
            openingOrderMatchesRung(order, phase.id, prior.lowPrice),
          ),
        );
    });
    if (!nextRung) return base;
    const lock = await tracker.lockPhase(event, phase, completeBooks);
    if (!lock) return base;
    const cheap = completeBooks.find((book) => book.tokenId === lock.cheapTokenId);
    const opposite = completeBooks.find((book) => book.tokenId === lock.favoriteTokenId);
    if (!cheap || !opposite) return base;
    const size = floorShares(
      Math.min(
        pairedShares(
          nextRung.lowPrice,
          nextRung.highPrice,
          cheap.minOrderSize,
          opposite.minOrderSize,
          config.ladderSizeScale,
        ),
        config.ladderV5MaxImbalance,
      ),
    );
    const tickSize = Number(tickSizeFromMarket(event.market));
    const hedge = executableHedge(snapshot, opposite, size);
    const entryPrice = hedge
      ? maximumSafeEntryPrice(
          config,
          snapshot,
          cheap,
          hedge,
          size,
          nextRung.lowPrice,
          tickSize,
        )
      : null;
    if (
      size <= EPSILON ||
      size + EPSILON < cheap.minOrderSize ||
      entryPrice === null ||
      entryPrice <= 0
    ) {
      return base;
    }
    const plannedAllInPairCost =
      (size *
        (entryPrice +
          feePerShare(
            entryPrice,
            snapshot.makerFeeRate ?? 0,
            snapshot.takerFeeExponent,
          )) +
        hedge!.totalCost) /
      size;
    return {
      ...base,
      opportunities: [
        {
          kind: "cheap",
          event,
          token: cheap,
          price: entryPrice,
          size,
          tickSize: tickSizeFromMarket(event.market),
          negRisk: event.market.negRisk,
          tradeKey:
            `${OPENING_PREFIX}${event.slug}:${phase.id}:${cheap.tokenId}:` +
            `${nextRung.lowPrice.toFixed(2)}:${entryPrice.toFixed(3)}:` +
            bookSignature(opposite, size),
          strategyMode: "ladder_v5.5",
          phaseId: phase.id,
          pairId: openingPairId(phase.id, nextRung.lowPrice),
          orderPolicy: "post_only",
          pairLockRole: "opening",
          referenceTokenId: opposite.tokenId,
          referenceAllInPrice: hedge!.allInPerShare,
          plannedAllInPairCost,
          plannedNetEdgePerPair: 1 - plannedAllInPairCost,
        },
      ],
      observedHedgeAllInPerShare: hedge!.allInPerShare,
      plannedAllInPairCost,
      plannedNetEdgePerPair: 1 - plannedAllInPairCost,
    };
  }

  const surplusBook = completeBooks.find(
    (book) => (shares.get(book.tokenId) ?? 0) > paired + EPSILON,
  );
  const deficientBook = completeBooks.find((book) => book.tokenId !== surplusBook?.tokenId);
  if (!surplusBook || !deficientBook) return base;
  const cancelUnfilledEntryRemainders = (): string[] => [
    ...new Set([
      ...base.cancelOrderIds,
      ...v55OpenOrders.filter(isOpeningOrder).map((order) => order.id),
    ]),
  ];
  const hedgeSize = floorShares(unmatched);
  if (
    hedgeSize <= EPSILON ||
    hedgeSize + EPSILON < deficientBook.minOrderSize
  ) {
    return { ...base, cancelOrderIds: cancelUnfilledEntryRemainders() };
  }

  const entryLots = unmatchedEntryLots(
    entryFills.filter((fill) => fill.tokenId === surplusBook.tokenId),
    paired,
  );
  const entryCost = costForShares(entryLots, hedgeSize);
  const hedge = executableHedge(snapshot, deficientBook, hedgeSize);
  if (!Number.isFinite(entryCost) || !hedge) {
    return { ...base, cancelOrderIds: cancelUnfilledEntryRemainders() };
  }
  const allInPairCost = (entryCost + hedge.totalCost) / hedgeSize;
  if (allInPairCost > config.ladderV5MaxPairCost + EPSILON) {
    return {
      ...base,
      cancelOrderIds: cancelUnfilledEntryRemainders(),
      observedHedgeAllInPerShare: hedge.allInPerShare,
      plannedAllInPairCost: allInPairCost,
      plannedNetEdgePerPair: 1 - allInPairCost,
    };
  }

  const tradeKey =
    `${HEDGE_PREFIX}${event.slug}:${deficientBook.tokenId}:` +
    `${hedgeSize.toFixed(2)}:${entryCost.toFixed(6)}:` +
    `${entryLots.map((lot) => lot.fillId).join(",")}:` +
    bookSignature(deficientBook, hedgeSize);
  if (v55Orders.some((order) => order.tradeKey === tradeKey)) {
    return {
      ...base,
      cancelOrderIds: cancelUnfilledEntryRemainders(),
      observedHedgeAllInPerShare: hedge.allInPerShare,
      plannedAllInPairCost: allInPairCost,
      plannedNetEdgePerPair: 1 - allInPairCost,
    };
  }

  return {
    ...base,
    opportunities: [
      {
        kind: "expensive",
        event,
        token: deficientBook,
        price: hedge.limitPrice,
        size: hedgeSize,
        tickSize: tickSizeFromMarket(event.market),
        negRisk: event.market.negRisk,
        tradeKey,
        strategyMode: "ladder_v5.5",
        phaseId: phase?.id ?? "hedge-only",
        pairId: `${HEDGE_PREFIX}fok`,
        orderPolicy: "fok",
        pairLockRole: "completion_taker",
        pairLockSourceFillId: entryLots[0]?.fillId,
        pairLockEntryPrice: entryCost / hedgeSize,
        referenceTokenId: surplusBook.tokenId,
        referenceAllInPrice: hedge.allInPerShare,
        plannedAllInPairCost: allInPairCost,
        plannedNetEdgePerPair: 1 - allInPairCost,
      },
    ],
    observedHedgeAllInPerShare: hedge.allInPerShare,
    plannedAllInPairCost: allInPairCost,
    plannedNetEdgePerPair: 1 - allInPairCost,
  };
}
