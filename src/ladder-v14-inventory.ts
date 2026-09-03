import type { MarketExecutionSnapshot, PaperFill, TradeOpportunity } from "./types.js";

const EPSILON = 1e-8;
const round = (value: number): number => Math.round(value * 1e8) / 1e8;

export interface LadderV14Lot {
  tokenId: string;
  size: number;
  entryPrice: number;
  allInPrice: number;
  filledAtMs: number;
  orderId: string;
  role: string;
}

export interface LadderV14ResidualEpisode {
  id: string;
  residualStartedAt: string;
  surplusTokenId: string;
  residualQuantity: number;
  residualAgeSeconds: number;
}

function fillTimeMs(fill: PaperFill, fallback: number): number {
  const numeric = Number(fill.timestamp);
  if (Number.isFinite(numeric) && numeric > 1e11) return numeric;
  const parsed = Date.parse(fill.timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function lotCost(
  lots: readonly LadderV14Lot[],
  quantity: number,
  highestFirst: boolean,
): number {
  let remaining = quantity;
  let cost = 0;
  for (const lot of [...lots].sort((left, right) =>
    highestFirst
      ? right.allInPrice - left.allInPrice
      : left.allInPrice - right.allInPrice)) {
    const selected = Math.min(remaining, lot.size);
    cost += selected * lot.allInPrice;
    remaining -= selected;
    if (remaining <= EPSILON) break;
  }
  return remaining > EPSILON ? Number.POSITIVE_INFINITY : cost;
}

function takeHighestCostLots(
  lots: LadderV14Lot[],
  quantity: number,
): void {
  let remaining = quantity;
  lots.sort((left, right) => right.allInPrice - left.allInPrice);
  for (const lot of lots) {
    const selected = Math.min(remaining, lot.size);
    lot.size = round(lot.size - selected);
    remaining = round(remaining - selected);
    if (remaining <= EPSILON) break;
  }
  for (let index = lots.length - 1; index >= 0; index -= 1) {
    if (lots[index]!.size <= EPSILON) lots.splice(index, 1);
  }
}

/** Replays fee-inclusive V14 lots; sales consume the riskiest/highest-cost lots. */
export function ladderV14Inventory(
  snapshot: MarketExecutionSnapshot,
  nowSeconds = Date.now() / 1_000,
) {
  const books = [...snapshot.books].sort(
    (left, right) => left.outcomeIndex - right.outcomeIndex,
  );
  const yesId = books[0]?.tokenId ?? "";
  const noId = books[1]?.tokenId ?? "";
  const orders = snapshot.orders.filter((order) =>
    order.pairId?.startsWith("ladder-v14:"),
  );
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const orderIds = new Set(orderById.keys());
  const fills = snapshot.fills
    .filter((fill) => orderIds.has(fill.orderId))
    .map((fill, index) => ({ fill, index }))
    .sort((left, right) =>
      fillTimeMs(left.fill, left.index) - fillTimeMs(right.fill, right.index) ||
      left.index - right.index)
    .map(({ fill }) => fill);
  const lots = new Map<string, LadderV14Lot[]>([
    [yesId, []],
    [noId, []],
  ]);
  const quantities = new Map<string, number>([
    [yesId, 0],
    [noId, 0],
  ]);
  let episode: LadderV14ResidualEpisode | null = null;

  for (const fill of fills) {
    const tokenLots = lots.get(fill.tokenId);
    if (!tokenLots) continue;
    if ((fill.side ?? "BUY") === "BUY") {
      const order = orderById.get(fill.orderId);
      tokenLots.push({
        tokenId: fill.tokenId,
        size: fill.size,
        entryPrice: fill.price,
        allInPrice: fill.price + fill.fee / Math.max(EPSILON, fill.size),
        filledAtMs: fillTimeMs(fill, nowSeconds * 1_000),
        orderId: fill.orderId,
        role: order?.pairId ?? "ladder-v14:unknown",
      });
      quantities.set(
        fill.tokenId,
        round((quantities.get(fill.tokenId) ?? 0) + fill.size),
      );
    } else {
      takeHighestCostLots(tokenLots, fill.size);
      quantities.set(
        fill.tokenId,
        round(Math.max(0, (quantities.get(fill.tokenId) ?? 0) - fill.size)),
      );
    }

    const yes = quantities.get(yesId) ?? 0;
    const no = quantities.get(noId) ?? 0;
    const residualQuantity = round(Math.abs(yes - no));
    if (residualQuantity <= EPSILON) {
      episode = null;
      continue;
    }
    const surplusTokenId = yes > no ? yesId : noId;
    if (!episode || episode.surplusTokenId !== surplusTokenId) {
      const startedAtMs = fillTimeMs(fill, nowSeconds * 1_000);
      episode = {
        id: `${snapshot.marketSlug}:${fill.id}`,
        residualStartedAt: new Date(startedAtMs).toISOString(),
        surplusTokenId,
        residualQuantity,
        residualAgeSeconds: Math.max(0, nowSeconds - startedAtMs / 1_000),
      };
    } else {
      episode.residualQuantity = residualQuantity;
    }
  }

  const yesShares = quantities.get(yesId) ?? 0;
  const noShares = quantities.get(noId) ?? 0;
  const pairedShares = Math.min(yesShares, noShares);
  const unpairedShares = round(Math.abs(yesShares - noShares));
  const residualLots = episode
    ? (() => {
        let remaining = unpairedShares;
        const selected: LadderV14Lot[] = [];
        for (const lot of [...(lots.get(episode.surplusTokenId) ?? [])]
          .sort((left, right) => right.allInPrice - left.allInPrice)) {
          const size = Math.min(remaining, lot.size);
          if (size > EPSILON) selected.push({ ...lot, size });
          remaining = round(remaining - size);
          if (remaining <= EPSILON) break;
        }
        return selected;
      })()
    : [];

  return {
    fills,
    lots,
    yesShares,
    noShares,
    pairedShares,
    unpairedShares,
    episode,
    residualLots,
    unpairedCost: episode
      ? lotCost(lots.get(episode.surplusTokenId) ?? [], unpairedShares, true)
      : 0,
    lockedPnl: round(
      pairedShares -
      lotCost(lots.get(yesId) ?? [], pairedShares, false) -
      lotCost(lots.get(noId) ?? [], pairedShares, false),
    ),
  };
}

/** Volume-first state-machine invariant, rechecked inside the mutation lock. */
export function ladderV14BuyGuard(
  snapshot: MarketExecutionSnapshot | null | undefined,
  opportunity: TradeOpportunity,
  replacingOrderId?: string,
): string | null {
  if (!snapshot || snapshot.marketDataValid === false) return "invalid_market_data";
  if (snapshot.executionPending) return "pending_execution_reconciliation";
  if (!Number.isFinite(opportunity.size) || opportunity.size <= 0) return "invalid_size";
  const inventory = ladderV14Inventory(snapshot);
  const open = snapshot.openOrders.filter((order) =>
    order.id !== replacingOrderId && order.pairId?.startsWith("ladder-v14:"));
  if (opportunity.pairId === "ladder-v14:opening") {
    if (inventory.unpairedShares > EPSILON) return "repair_only_while_unpaired";
    if (open.some((order) => order.pairId !== "ladder-v14:opening")) {
      return "cancel_finished_repair_before_opening";
    }
    return null;
  }
  if (!opportunity.pairId?.startsWith("ladder-v14:repair-") ||
    !inventory.episode ||
    !snapshot.books.some((book) => book.tokenId === opportunity.token.tokenId) ||
    opportunity.token.tokenId === inventory.episode.surplusTokenId ||
    opportunity.size > inventory.unpairedShares + EPSILON) {
    return "buy_exceeds_v14_missing_quantity";
  }
  if (open.length > 0) return "cancel_v14_orders_before_repair";
  if (opportunity.orderPolicy === "post_only" &&
    Math.abs(opportunity.size - inventory.unpairedShares) > EPSILON) {
    return "repair_maker_must_match_residual";
  }
  return null;
}

/** Rechecked inside the executor mutation lock. */
export function ladderV14SellGuard(
  snapshot: MarketExecutionSnapshot,
  tokenId: string,
  size: number,
): string | null {
  if (!Number.isFinite(size) || size <= 0) return "invalid_size";
  if (snapshot.marketDataValid === false) return "invalid_market_data";
  if (snapshot.executionPending) return "pending_execution_reconciliation";
  if (snapshot.openOrders.some((order) =>
    order.pairId?.startsWith("ladder-v14:"))) {
    return "cancel_v14_orders_before_sale";
  }
  const inventory = ladderV14Inventory(snapshot);
  if (
    !inventory.episode ||
    inventory.episode.surplusTokenId !== tokenId ||
    size > inventory.unpairedShares + EPSILON
  ) {
    return "sale_exceeds_v14_residual";
  }
  return null;
}
