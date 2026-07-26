import type { BotConfig } from "./config.js";
import {
  ladderPhaseAt,
  LadderTracker,
  pairedShares,
} from "./ladder.js";
import type {
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

export interface PairLockLot {
  fillId: string;
  tokenId: string;
  outcome: string;
  entryPrice: number;
  originalShares: number;
  residualShares: number;
  remainingShares: number;
  timestamp: string;
}

export interface PairLockInventory {
  residualOutcome: string | null;
  lots: PairLockLot[];
  naturallyPairedShares: number;
  completedShares: number;
}

export interface PairLockPlan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  inventory: PairLockInventory;
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorShares(value: number): number {
  return Math.floor((value + 1e-9) / SHARE_STEP) * SHARE_STEP;
}

function floorToTick(value: number, tick: number): number {
  return Math.floor((value + 1e-9) / tick) * tick;
}

function orderForFill(
  snapshot: MarketExecutionSnapshot,
  fill: PaperFill,
): PaperOrder | undefined {
  return snapshot.orders.find((order) => order.id === fill.orderId);
}

function fillTime(fill: PaperFill): number {
  const numeric = Number(fill.timestamp);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  }
  const parsed = Date.parse(fill.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function derivePairLockInventory(
  config: BotConfig,
  snapshot: MarketExecutionSnapshot,
): PairLockInventory {
  const lots: PairLockLot[] = [];
  let residualOutcome: string | null = null;
  let naturallyPairedShares = 0;
  let completedShares = 0;

  const events = snapshot.fills
    .map((fill, index) => ({
      fill,
      order: orderForFill(snapshot, fill),
      sortTime: fillTime(fill),
      index,
    }))
    .filter(
      (
        item,
      ): item is {
        fill: PaperFill;
        order: PaperOrder;
        sortTime: number;
        index: number;
      } => item.order !== undefined && item.order.pairLockRole !== undefined,
    )
    .sort(
      (left, right) =>
        left.sortTime - right.sortTime || left.index - right.index,
    );

  for (const { fill, order } of events) {
    if (order.pairLockRole === "opening") {
      if (
        residualOutcome === null &&
        fill.price <= config.pairLockResidualMaxPrice + EPSILON
      ) {
        residualOutcome = fill.outcome;
      }
      const residualShares =
        residualOutcome === fill.outcome &&
        fill.price <= config.pairLockResidualMaxPrice + EPSILON
          ? floorShares(fill.size * config.pairLockResidualFraction)
          : 0;
      const lot: PairLockLot = {
        fillId: fill.id,
        tokenId: fill.tokenId,
        outcome: fill.outcome,
        entryPrice: fill.price,
        originalShares: fill.size,
        residualShares,
        remainingShares: round(fill.size - residualShares),
        timestamp: fill.timestamp,
      };

      const candidates = lots
        .filter(
          (candidate) =>
            candidate.outcome !== lot.outcome &&
            candidate.remainingShares > EPSILON &&
            candidate.entryPrice + lot.entryPrice <=
              config.pairLockMaxCost + EPSILON,
        )
        .sort(
          (left, right) =>
            right.entryPrice - left.entryPrice ||
            left.fillId.localeCompare(right.fillId),
        );
      for (const candidate of candidates) {
        if (lot.remainingShares <= EPSILON) break;
        const matched = Math.min(
          lot.remainingShares,
          candidate.remainingShares,
        );
        lot.remainingShares = round(lot.remainingShares - matched);
        candidate.remainingShares = round(
          candidate.remainingShares - matched,
        );
        naturallyPairedShares = round(naturallyPairedShares + matched);
      }
      lots.push(lot);
      continue;
    }

    const source = lots.find(
      (lot) => lot.fillId === order.pairLockSourceFillId,
    );
    if (!source || source.remainingShares <= EPSILON) continue;
    const matched = Math.min(source.remainingShares, fill.size);
    source.remainingShares = round(source.remainingShares - matched);
    completedShares = round(completedShares + matched);

    // A completion can race an opening fill in live trading. Preserve any
    // excess as real inventory so it can never be counted as a second pair.
    const excess = round(fill.size - matched);
    if (excess > EPSILON) {
      lots.push({
        fillId: fill.id,
        tokenId: fill.tokenId,
        outcome: fill.outcome,
        entryPrice: fill.price + fill.fee / fill.size,
        originalShares: excess,
        residualShares: 0,
        remainingShares: excess,
        timestamp: fill.timestamp,
      });
    }
  }

  return {
    residualOutcome,
    lots,
    naturallyPairedShares,
    completedShares,
  };
}

export async function findPairLockOpeningOpportunities(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  books: TokenBook[],
  nowSeconds = Date.now() / 1000,
): Promise<TradeOpportunity[]> {
  const phase = ladderPhaseAt(event, nowSeconds, config.ladderPreset);
  if (!phase) return [];

  const lock = await tracker.lockPhase(event, phase, books);
  if (!lock) return [];
  const cheap = books.find((book) => book.tokenId === lock.cheapTokenId);
  const favorite = books.find((book) => book.tokenId === lock.favoriteTokenId);
  if (!cheap || !favorite || cheap.bestAsk === null) return [];

  const opportunities: TradeOpportunity[] = [];
  for (const rung of phase.rungs) {
    const size = pairedShares(
      rung.lowPrice,
      rung.highPrice,
      cheap.minOrderSize,
      favorite.minOrderSize,
      config.ladderSizeScale,
    );
    if (
      size * rung.lowPrice + EPSILON < 1 ||
      size + EPSILON < cheap.minOrderSize ||
      rung.lowPrice + EPSILON >= cheap.bestAsk
    ) {
      continue;
    }
    const tradeKey = `pair-lock-opening:${tracker.makeKey(
      event.slug,
      phase.id,
      cheap.outcome,
      rung.lowPrice,
    )}`;
    if (tracker.has(tradeKey)) continue;
    opportunities.push({
      kind: "cheap",
      event,
      token: cheap,
      price: rung.lowPrice,
      size,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey,
      strategyMode: "odahoa_ladder_2",
      phaseId: phase.id,
      pairId: `opening-${rung.lowPrice.toFixed(2)}`,
      orderPolicy: "post_only",
      pairLockRole: "opening",
    });
  }
  return opportunities;
}

function feePerShare(
  price: number,
  rate: number,
  exponent: number,
): number {
  return rate * Math.pow(price * (1 - price), exponent);
}

function profitableTakerSize(
  config: BotConfig,
  snapshot: MarketExecutionSnapshot,
  lot: PairLockLot,
  oppositeBook: TokenBook,
): { size: number; limitPrice: number } | null {
  let selected = 0;
  let pairCost = 0;
  let limitPrice = 0;
  for (const ask of oppositeBook.asks) {
    if (selected >= lot.remainingShares - EPSILON) break;
    const available = Math.min(
      ask.size,
      lot.remainingShares - selected,
    );
    if (available <= EPSILON) continue;
    const unitCost =
      lot.entryPrice +
      ask.price +
      feePerShare(
        ask.price,
        snapshot.takerFeeRate,
        snapshot.takerFeeExponent,
      );
    let accepted = available;
    if (unitCost > config.pairLockMaxCost + EPSILON) {
      const remainingEdge =
        config.pairLockMaxCost * selected - pairCost;
      accepted =
        remainingEdge > EPSILON
          ? Math.min(
              available,
              remainingEdge / (unitCost - config.pairLockMaxCost),
            )
          : 0;
    }
    accepted = floorShares(accepted);
    if (accepted <= EPSILON) break;
    selected = round(selected + accepted);
    pairCost = round(pairCost + accepted * unitCost);
    limitPrice = ask.price;
    if (accepted + EPSILON < available) break;
  }
  if (
    selected <= EPSILON ||
    pairCost / selected > config.pairLockMaxCost + EPSILON
  ) {
    return null;
  }
  return { size: selected, limitPrice };
}

function completionKey(
  role: "maker" | "taker",
  lot: PairLockLot,
  price: number,
  size: number,
  sourceOrderCount: number,
): string {
  return [
    "pair-lock",
    role,
    lot.fillId,
    price.toFixed(4),
    size.toFixed(2),
    sourceOrderCount,
  ].join(":");
}

export function planPairLockCompletions(
  config: BotConfig,
  event: UpDownEvent,
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1000,
): PairLockPlan {
  const inventory = derivePairLockInventory(config, snapshot);
  const phase = ladderPhaseAt(event, nowSeconds, config.ladderPreset);
  const completionOrders = snapshot.openOrders.filter(
    (order) =>
      order.pairLockRole === "completion_maker" ||
      order.pairLockRole === "completion_taker",
  );
  if (!phase) {
    return {
      cancelOrderIds: completionOrders.map((order) => order.id),
      opportunities: [],
      inventory,
    };
  }

  const cancelIds = new Set<string>();
  const opportunities: TradeOpportunity[] = [];
  const availableLots = inventory.lots
    .filter((lot) => lot.remainingShares > EPSILON)
    .sort(
      (left, right) =>
        right.entryPrice - left.entryPrice ||
        left.fillId.localeCompare(right.fillId),
    );

  for (const lot of availableLots) {
    const oppositeBook = snapshot.books.find(
      (book) => book.tokenId !== lot.tokenId,
    );
    if (!oppositeBook) continue;
    const existing = completionOrders.filter(
      (order) => order.pairLockSourceFillId === lot.fillId,
    );
    const sourceOrderCount = snapshot.orders.filter(
      (order) => order.pairLockSourceFillId === lot.fillId,
    ).length;

    const taker = profitableTakerSize(config, snapshot, lot, oppositeBook);
    if (
      taker &&
      taker.size + EPSILON >= oppositeBook.minOrderSize &&
      taker.size * taker.limitPrice + EPSILON >= 1
    ) {
      for (const order of existing) cancelIds.add(order.id);
      opportunities.push({
        kind: "expensive",
        event,
        token: oppositeBook,
        price: taker.limitPrice,
        size: taker.size,
        tickSize: tickSizeFromMarket(event.market),
        negRisk: event.market.negRisk,
        tradeKey: completionKey(
          "taker",
          lot,
          taker.limitPrice,
          taker.size,
          sourceOrderCount,
        ),
        strategyMode: "odahoa_ladder_2",
        phaseId: phase.id,
        pairId: `completion-${lot.fillId}`,
        orderPolicy: "fak",
        pairLockRole: "completion_taker",
        pairLockSourceFillId: lot.fillId,
        pairLockEntryPrice: lot.entryPrice,
      });
      continue;
    }

    const tick = Number(tickSizeFromMarket(event.market));
    const askCeiling =
      oppositeBook.bestAsk === null
        ? 0
        : floorToTick(oppositeBook.bestAsk - tick, tick);
    const profitableCeiling = floorToTick(
      config.pairLockMaxCost - lot.entryPrice,
      tick,
    );
    const makerPrice = round(Math.min(askCeiling, profitableCeiling), 4);
    const makerSize = floorShares(lot.remainingShares);
    const validMaker =
      makerPrice > 0 &&
      oppositeBook.bestAsk !== null &&
      makerPrice + EPSILON < oppositeBook.bestAsk &&
      lot.entryPrice + makerPrice <= config.pairLockMaxCost + EPSILON &&
      makerSize + EPSILON >= oppositeBook.minOrderSize &&
      makerSize * makerPrice + EPSILON >= 1;

    const matching = existing.find(
      (order) =>
        order.pairLockRole === "completion_maker" &&
        order.phaseId === phase.id &&
        Math.abs(order.limitPrice - makerPrice) <= EPSILON &&
        Math.abs(order.remainingSize - makerSize) <= EPSILON,
    );
    for (const order of existing) {
      if (!matching || order.id !== matching.id) cancelIds.add(order.id);
    }
    if (!validMaker || matching) continue;

    opportunities.push({
      kind: "maker",
      event,
      token: oppositeBook,
      price: makerPrice,
      size: makerSize,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey: completionKey(
        "maker",
        lot,
        makerPrice,
        makerSize,
        sourceOrderCount,
      ),
      strategyMode: "odahoa_ladder_2",
      phaseId: phase.id,
      pairId: `completion-${lot.fillId}`,
      orderPolicy: "post_only",
      pairLockRole: "completion_maker",
      pairLockSourceFillId: lot.fillId,
      pairLockEntryPrice: lot.entryPrice,
    });
  }

  const activeSources = new Set(availableLots.map((lot) => lot.fillId));
  for (const order of completionOrders) {
    if (
      !order.pairLockSourceFillId ||
      !activeSources.has(order.pairLockSourceFillId) ||
      order.phaseId !== phase.id
    ) {
      cancelIds.add(order.id);
    }
  }

  return {
    cancelOrderIds: [...cancelIds],
    opportunities,
    inventory,
  };
}
