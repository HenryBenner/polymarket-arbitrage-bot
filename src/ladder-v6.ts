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
  rungs: [],
};

export interface LadderV6Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  cheapFilledShares: number;
  hedgedShares: number;
  pairedShares: number;
  unmatchedCheapShares: number;
  plannedOpeningBid: number | null;
  observedHedgeAllInPerShare: number | null;
  plannedAllInPairCost: number | null;
  plannedNetEdgePerPair: number | null;
}

interface CostLot {
  shares: number;
  unitCost: number;
}

interface Inventory {
  book: TokenBook;
  fills: PaperFill[];
  shares: number;
  totalCost: number;
}

interface DepthCost {
  total: number;
  limitPrice: number;
  perShare: number;
}

interface CompletionPlan {
  depth: DepthCost;
  allInPairCost: number;
  netEdgePerPair: number;
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

function floorToTick(value: number, tickSize: number): number {
  return round(Math.floor((value + EPSILON) / tickSize) * tickSize);
}

function minutesLeft(event: UpDownEvent, nowSeconds: number): number {
  return (event.windowEnd - nowSeconds) / 60;
}

function isOpeningWindow(remaining: number): boolean {
  return (
    remaining > LADDER_V6_PHASE.minutesLeftMin &&
    remaining <= LADDER_V6_PHASE.minutesLeftMax
  );
}

function isRescueWindow(remaining: number): boolean {
  return remaining > 0 && remaining <= LADDER_V6_PHASE.minutesLeftMin;
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

function feePerShare(
  price: number,
  rate: number,
  exponent: number,
): number {
  return rate * Math.pow(price * (1 - price), exponent);
}

function makerAllInPerShare(
  price: number,
  rate: number,
  exponent: number,
): number {
  return price + feePerShare(price, rate, exponent);
}

function executableAskCost(
  snapshot: MarketExecutionSnapshot,
  book: TokenBook,
  shares: number,
): DepthCost | null {
  let remaining = shares;
  let total = 0;
  let limitPrice = 0;
  for (const ask of [...book.asks].sort((a, b) => a.price - b.price)) {
    if (remaining <= EPSILON) break;
    if (ask.size <= EPSILON) continue;
    const selected = Math.min(remaining, ask.size);
    total +=
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
  return { total, limitPrice, perShare: total / shares };
}

function inventoryFor(
  books: TokenBook[],
  fills: PaperFill[],
): Inventory[] {
  return books.map((book) => {
    const tokenFills = fills.filter((fill) => fill.tokenId === book.tokenId);
    return {
      book,
      fills: tokenFills,
      shares: round(
        tokenFills.reduce((sum, fill) => sum + fill.size, 0),
      ),
      totalCost: round(
        tokenFills.reduce(
          (sum, fill) => sum + fill.size * fill.price + fill.fee,
          0,
        ),
      ),
    };
  });
}

function unmatchedLots(
  inventory: Inventory,
  pairedShares: number,
): CostLot[] {
  let consumed = pairedShares;
  const lots = inventory.fills
    .map((fill) => ({
      shares: fill.size,
      unitCost:
        fill.price + (fill.size > EPSILON ? fill.fee / fill.size : 0),
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

function completionPlan(
  snapshot: MarketExecutionSnapshot,
  deficientBook: TokenBook,
  unmatched: CostLot[],
  shares: number,
  maximumPairCost: number,
): CompletionPlan | null {
  const depth = executableAskCost(snapshot, deficientBook, shares);
  if (!depth) return null;
  const entryCost = costForShares(unmatched, shares);
  if (!Number.isFinite(entryCost)) return null;
  const allInPairCost = (entryCost + depth.total) / shares;
  if (allInPairCost > maximumPairCost + EPSILON) return null;
  return {
    depth,
    allInPairCost,
    netEdgePerPair: 1 - allInPairCost,
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

function emptyPlan(
  cancelOrderIds: string[],
  openingFilledShares: number,
  hedgeFilledShares: number,
  pairedShares: number,
  unmatchedShares: number,
): LadderV6Plan {
  return {
    cancelOrderIds,
    opportunities: [],
    cheapFilledShares: openingFilledShares,
    hedgedShares: hedgeFilledShares,
    pairedShares,
    unmatchedCheapShares: unmatchedShares,
    plannedOpeningBid: null,
    observedHedgeAllInPerShare: null,
    plannedAllInPairCost: null,
    plannedNetEdgePerPair: null,
  };
}

function distributeQuoteSlack(
  books: TokenBook[],
  prices: number[],
  pairCap: number,
  tickSize: number,
): number[] {
  const result = [...prices];
  for (let iteration = 0; iteration < 200; iteration += 1) {
    if (result[0]! + result[1]! + tickSize > pairCap + EPSILON) break;
    const candidates = [0, 1].filter((index) => {
      const bestAsk = books[index]!.bestAsk;
      return (
        bestAsk !== null &&
        result[index]! + tickSize < bestAsk + EPSILON
      );
    });
    if (candidates.length === 0) break;
    const selected = candidates[iteration % candidates.length]!;
    result[selected] = round(result[selected]! + tickSize);
  }
  return result;
}

function openingQuotes(
  config: BotConfig,
  event: UpDownEvent,
  books: TokenBook[],
): { prices: number[]; size: number; pairCost: number } | null {
  if (
    books.some(
      (book) => book.bestBid === null || book.bestAsk === null,
    )
  ) {
    return null;
  }
  const tickSize = Number(tickSizeFromMarket(event.market));
  if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
  const size = floorShares(config.ladderV6MaxUnmatchedShares);
  if (
    size <= EPSILON ||
    books.some((book) => size + EPSILON < book.minOrderSize)
  ) {
    return null;
  }

  const pairCap =
    1 - config.ladderV6MinNetEdge - config.ladderV6SafetyBuffer;
  const makerRate = event.market.feeSchedule?.makerRate ?? 0;
  const makerExponent = event.market.feeSchedule?.exponent ?? 1;
  const initial = books.map((book) =>
    floorToTick(book.bestBid ?? 0, tickSize),
  );
  const pairCost = (prices: number[]): number =>
    prices.reduce(
      (sum, price) =>
        sum + makerAllInPerShare(price, makerRate, makerExponent),
      0,
    );
  if (pairCost(initial) > pairCap + EPSILON) return null;
  const prices = distributeQuoteSlack(
    books,
    initial,
    pairCap,
    tickSize,
  );
  while (pairCost(prices) > pairCap + EPSILON) {
    const candidates = [0, 1].filter(
      (index) => prices[index]! - tickSize > 0,
    );
    if (candidates.length === 0) return null;
    const selected =
      candidates.length === 1
        ? candidates[0]!
        : prices[0]! >= prices[1]!
          ? 0
          : 1;
    prices[selected] = floorToTick(
      prices[selected]! - tickSize,
      tickSize,
    );
  }
  if (
    prices.some(
      (price, index) =>
        price <= 0 ||
        price * size + EPSILON < 1 ||
        price + EPSILON >= (books[index]!.bestAsk ?? 0),
    )
  ) {
    return null;
  }
  return {
    prices,
    size,
    pairCost: round(pairCost(prices)),
  };
}

function sameOrder(
  order: PaperOrder,
  tokenId: string,
  price: number,
  size: number,
  role: "opening" | "completion_maker",
): boolean {
  return (
    order.tokenId === tokenId &&
    Math.abs(order.limitPrice - price) <= EPSILON &&
    Math.abs(order.remainingSize - size) <= EPSILON &&
    order.pairLockRole === role
  );
}

function nextAttempt(snapshot: MarketExecutionSnapshot, prefix: string): number {
  return (
    snapshot.orders.filter((order) => order.tradeKey.startsWith(prefix))
      .length + 1
  );
}

function takerOpportunity(
  event: UpDownEvent,
  deficientBook: TokenBook,
  shares: number,
  entryCostPerShare: number,
  plan: CompletionPlan,
  tradeKey: string,
  rescue: boolean,
): TradeOpportunity {
  return {
    kind: "expensive",
    event,
    token: deficientBook,
    price: plan.depth.limitPrice,
    size: shares,
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    strategyMode: "ladder_v6",
    phaseId: LADDER_V6_PHASE.id,
    pairId: `${V6_HEDGE_PREFIX}${rescue ? "rescue" : "taker"}`,
    orderPolicy: "fok",
    pairLockRole: "completion_taker",
    pairLockEntryPrice: entryCostPerShare,
    referenceTokenId: deficientBook.tokenId,
    referenceAllInPrice: plan.depth.perShare,
    plannedAllInPairCost: plan.allInPairCost,
    plannedNetEdgePerPair: plan.netEdgePerPair,
  };
}

export async function planLadderV6(
  config: BotConfig,
  _tracker: LadderTracker,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1000,
): Promise<LadderV6Plan> {
  const remaining = minutesLeft(event, nowSeconds);
  const openingWindow = isOpeningWindow(remaining);
  const rescueWindow = isRescueWindow(remaining);
  const v6OpenOrders = snapshot.openOrders.filter(isV6Order);
  const openingFills = fillsForOrders(snapshot, isOpeningOrder);
  const hedgeFills = fillsForOrders(snapshot, isHedgeOrder);
  const allFills = fillsForOrders(snapshot, isV6Order);
  const books = snapshot.books.filter((book) => book.bestAsk !== null);
  const openingFilledShares = round(
    openingFills.reduce((sum, fill) => sum + fill.size, 0),
  );
  const hedgeFilledShares = round(
    hedgeFills.reduce((sum, fill) => sum + fill.size, 0),
  );

  if (books.length !== 2) {
    return emptyPlan(
      v6OpenOrders.map((order) => order.id),
      openingFilledShares,
      hedgeFilledShares,
      0,
      0,
    );
  }

  const inventory = inventoryFor(books, allFills);
  const pairedShares = Math.min(
    inventory[0]!.shares,
    inventory[1]!.shares,
  );
  const unmatchedShares = round(
    Math.abs(inventory[0]!.shares - inventory[1]!.shares),
  );
  const basePlan = emptyPlan(
    [],
    openingFilledShares,
    hedgeFilledShares,
    pairedShares,
    unmatchedShares,
  );

  if (allFills.length > 0) {
    if (unmatchedShares <= EPSILON) {
      return {
        ...basePlan,
        cancelOrderIds: v6OpenOrders.map((order) => order.id),
      };
    }

    const surplus =
      inventory[0]!.shares > inventory[1]!.shares
        ? inventory[0]!
        : inventory[1]!;
    const deficient =
      surplus === inventory[0] ? inventory[1]! : inventory[0]!;
    const hedgeSize = floorShares(unmatchedShares);
    const unmatched = unmatchedLots(surplus, pairedShares);
    const entryCost = costForShares(unmatched, hedgeSize);
    const entryCostPerShare = entryCost / hedgeSize;
    const openingOrderIds = v6OpenOrders
      .filter(isOpeningOrder)
      .map((order) => order.id);
    if (
      hedgeSize <= EPSILON ||
      !Number.isFinite(entryCost) ||
      hedgeSize + EPSILON < deficient.book.minOrderSize
    ) {
      return { ...basePlan, cancelOrderIds: openingOrderIds };
    }

    const maximumPairCost = rescueWindow
      ? 1 + config.ladderV6MaxRescueLoss
      : 1 - config.ladderV6MinNetEdge;
    const taker = completionPlan(
      snapshot,
      deficient.book,
      unmatched,
      hedgeSize,
      maximumPairCost,
    );
    if (taker && taker.depth.limitPrice * hedgeSize + EPSILON >= 1) {
      const prefix =
        `${V6_HEDGE_PREFIX}${rescueWindow ? "rescue" : "taker"}:` +
        `${event.slug}:${hedgeSize.toFixed(2)}:${entryCost.toFixed(6)}:`;
      const tradeKey = `${prefix}${bookSignature(
        deficient.book,
        hedgeSize,
      )}`;
      const attempted = snapshot.orders.some(
        (order) => order.tradeKey === tradeKey,
      );
      const nonTakerOrderIds = v6OpenOrders
        .filter((order) => order.orderPolicy !== "fok")
        .map((order) => order.id);
      if (nonTakerOrderIds.length > 0) {
        return {
          ...basePlan,
          cancelOrderIds: nonTakerOrderIds,
          plannedAllInPairCost: taker.allInPairCost,
          plannedNetEdgePerPair: taker.netEdgePerPair,
        };
      }
      if (!attempted) {
        return {
          ...basePlan,
          opportunities: [
            takerOpportunity(
              event,
              deficient.book,
              hedgeSize,
              entryCostPerShare,
              taker,
              tradeKey,
              rescueWindow,
            ),
          ],
          observedHedgeAllInPerShare: taker.depth.perShare,
          plannedAllInPairCost: taker.allInPairCost,
          plannedNetEdgePerPair: taker.netEdgePerPair,
        };
      }
    }

    if (!openingWindow) {
      return {
        ...basePlan,
        cancelOrderIds: v6OpenOrders.map((order) => order.id),
      };
    }

    const tickSize = Number(tickSizeFromMarket(event.market));
    let makerMaximum = floorToTick(
      1 - entryCostPerShare - config.ladderV6MinNetEdge,
      tickSize,
    );
    const makerRate = snapshot.makerFeeRate ?? 0;
    while (
      makerMaximum > tickSize &&
      entryCostPerShare +
          makerAllInPerShare(
            makerMaximum,
            makerRate,
            snapshot.takerFeeExponent,
          ) >
        1 - config.ladderV6MinNetEdge + EPSILON
    ) {
      makerMaximum = floorToTick(
        makerMaximum - tickSize,
        tickSize,
      );
    }
    const makerPrice = floorToTick(
      Math.min(
        makerMaximum,
        (deficient.book.bestAsk ?? 0) - tickSize,
      ),
      tickSize,
    );
    const matchingMaker = v6OpenOrders.find(
      (order) =>
        order.tokenId === deficient.book.tokenId &&
        Math.abs(order.limitPrice - makerPrice) <= EPSILON &&
        Math.abs(order.remainingSize - hedgeSize) <= EPSILON &&
        order.orderPolicy === "post_only",
    );
    const staleIds = v6OpenOrders
      .filter((order) => order.id !== matchingMaker?.id)
      .map((order) => order.id);
    if (staleIds.length > 0) {
      return { ...basePlan, cancelOrderIds: staleIds };
    }
    if (
      matchingMaker ||
      makerPrice <= 0 ||
      makerPrice * hedgeSize + EPSILON < 1 ||
      makerPrice + EPSILON >= (deficient.book.bestAsk ?? 0)
    ) {
      return {
        ...basePlan,
        plannedOpeningBid: matchingMaker?.limitPrice ?? null,
        plannedAllInPairCost:
          matchingMaker === undefined
            ? null
            : entryCostPerShare +
              makerAllInPerShare(
                matchingMaker.limitPrice,
                makerRate,
                snapshot.takerFeeExponent,
              ),
        plannedNetEdgePerPair:
          matchingMaker === undefined
            ? null
            : 1 -
              entryCostPerShare -
              makerAllInPerShare(
                matchingMaker.limitPrice,
                makerRate,
                snapshot.takerFeeExponent,
              ),
      };
    }

    const prefix =
      `${V6_HEDGE_PREFIX}maker:${event.slug}:` +
      `${deficient.book.tokenId}:`;
    const tradeKey =
      `${prefix}${makerPrice.toFixed(4)}:` +
      `${nextAttempt(snapshot, prefix)}`;
    return {
      ...basePlan,
      opportunities: [
        {
          kind: "maker",
          event,
          token: deficient.book,
          price: makerPrice,
          size: hedgeSize,
          tickSize: tickSizeFromMarket(event.market),
          negRisk: event.market.negRisk,
          tradeKey,
          strategyMode: "ladder_v6",
          phaseId: LADDER_V6_PHASE.id,
          pairId: `${V6_HEDGE_PREFIX}maker`,
          orderPolicy: "post_only",
          pairLockRole: "completion_maker",
          pairLockEntryPrice: entryCostPerShare,
          referenceTokenId: surplus.book.tokenId,
          referenceAllInPrice: entryCostPerShare,
          plannedAllInPairCost:
            entryCostPerShare +
            makerAllInPerShare(
              makerPrice,
              makerRate,
              snapshot.takerFeeExponent,
            ),
          plannedNetEdgePerPair:
            1 -
            entryCostPerShare -
            makerAllInPerShare(
              makerPrice,
              makerRate,
              snapshot.takerFeeExponent,
            ),
        },
      ],
      plannedOpeningBid: makerPrice,
      plannedAllInPairCost:
        entryCostPerShare +
        makerAllInPerShare(
          makerPrice,
          makerRate,
          snapshot.takerFeeExponent,
        ),
      plannedNetEdgePerPair:
        1 -
        entryCostPerShare -
        makerAllInPerShare(
          makerPrice,
          makerRate,
          snapshot.takerFeeExponent,
        ),
    };
  }

  if (!openingWindow) {
    return {
      ...basePlan,
      cancelOrderIds: v6OpenOrders.map((order) => order.id),
    };
  }

  const quote = openingQuotes(config, event, books);
  const activeOpeningOrders = v6OpenOrders.filter(isOpeningOrder);
  if (!quote) {
    return {
      ...basePlan,
      cancelOrderIds: activeOpeningOrders.map((order) => order.id),
    };
  }

  const matching = books.map((book, index) =>
    activeOpeningOrders.find((order) =>
      sameOrder(
        order,
        book.tokenId,
        quote.prices[index]!,
        quote.size,
        "opening",
      ),
    ),
  );
  const matchingIds = new Set(
    matching
      .filter((order): order is PaperOrder => order !== undefined)
      .map((order) => order.id),
  );
  const staleIds = activeOpeningOrders
    .filter((order) => !matchingIds.has(order.id))
    .map((order) => order.id);
  if (staleIds.length > 0) {
    return {
      ...basePlan,
      cancelOrderIds: staleIds,
      plannedAllInPairCost: quote.pairCost,
      plannedNetEdgePerPair: 1 - quote.pairCost,
    };
  }

  const missingIndex = matching.findIndex((order) => order === undefined);
  if (missingIndex < 0) {
    return {
      ...basePlan,
      plannedOpeningBid: Math.min(...quote.prices),
      plannedAllInPairCost: quote.pairCost,
      plannedNetEdgePerPair: 1 - quote.pairCost,
    };
  }

  const book = books[missingIndex]!;
  const opposite = books[missingIndex === 0 ? 1 : 0]!;
  const price = quote.prices[missingIndex]!;
  const prefix =
    `${V6_OPENING_PREFIX}${event.slug}:${book.tokenId}:`;
  const tradeKey =
    `${prefix}${price.toFixed(4)}:${nextAttempt(snapshot, prefix)}`;
  return {
    ...basePlan,
    opportunities: [
      {
        kind: "maker",
        event,
        token: book,
        price,
        size: quote.size,
        tickSize: tickSizeFromMarket(event.market),
        negRisk: event.market.negRisk,
        tradeKey,
        strategyMode: "ladder_v6",
        phaseId: LADDER_V6_PHASE.id,
        pairId: `${V6_OPENING_PREFIX}paired`,
        orderPolicy: "post_only",
        pairLockRole: "opening",
        referenceTokenId: opposite.tokenId,
        referenceAllInPrice:
          quote.prices[missingIndex === 0 ? 1 : 0],
        plannedAllInPairCost: quote.pairCost,
        plannedNetEdgePerPair: 1 - quote.pairCost,
      },
    ],
    plannedOpeningBid: price,
    plannedAllInPairCost: quote.pairCost,
    plannedNetEdgePerPair: 1 - quote.pairCost,
  };
}
