import type { MarketExecutionSnapshot, PaperFill } from "./types.js";

const EPSILON = 1e-8;
const round = (value: number): number => Math.round(value * 1e8) / 1e8;

export interface LadderV13ResidualEpisode {
  id: string;
  residualStartedAt: string;
  surplusTokenId: string;
  residualQuantity: number;
  hasMatchedShares: boolean;
  residualAgeSeconds: number;
}

interface Lot { size: number; allIn: number }

function lotCost(lots: readonly Lot[], quantity: number, highestFirst: boolean): number {
  let remaining = quantity;
  let cost = 0;
  for (const lot of [...lots].sort((a, b) => highestFirst ? b.allIn - a.allIn : a.allIn - b.allIn)) {
    const size = Math.min(remaining, lot.size);
    cost += size * lot.allIn;
    remaining -= size;
    if (remaining <= EPSILON) break;
  }
  return remaining > EPSILON ? Number.POSITIVE_INFINITY : cost;
}

/** Replays actual fills, including sales, so sold lots cannot price future completions. */
export function ladderV13Inventory(snapshot: MarketExecutionSnapshot, nowSeconds = Date.now() / 1_000) {
  const books = [...snapshot.books].sort((a, b) => a.outcomeIndex - b.outcomeIndex);
  const yesId = books[0]?.tokenId ?? "";
  const noId = books[1]?.tokenId ?? "";
  const ids = new Set(snapshot.orders.filter((order) => order.pairId?.startsWith("ladder-v13:")).map((order) => order.id));
  const fills: PaperFill[] = snapshot.fills.filter((fill) => ids.has(fill.orderId))
    .map((fill, index) => ({ fill, index }))
    .sort((a, b) => Date.parse(a.fill.timestamp) - Date.parse(b.fill.timestamp) || a.index - b.index)
    .map(({ fill }) => fill);
  const lots = new Map<string, Lot[]>([[yesId, []], [noId, []]]);
  const quantities = new Map<string, number>([[yesId, 0], [noId, 0]]);
  let episode: LadderV13ResidualEpisode | null = null;
  for (const fill of fills) {
    const tokenLots = lots.get(fill.tokenId);
    if (!tokenLots) continue;
    if ((fill.side ?? "BUY") === "BUY") {
      tokenLots.push({ size: fill.size, allIn: fill.price + fill.fee / fill.size });
      quantities.set(fill.tokenId, round((quantities.get(fill.tokenId) ?? 0) + fill.size));
    } else {
      // Match cheaper lots into pairs first; residual sales consume expensive lots.
      tokenLots.sort((a, b) => b.allIn - a.allIn);
      let remaining = fill.size;
      for (const lot of tokenLots) {
        const size = Math.min(remaining, lot.size);
        lot.size = round(lot.size - size);
        remaining = round(remaining - size);
        if (remaining <= EPSILON) break;
      }
      quantities.set(fill.tokenId, round(Math.max(0, (quantities.get(fill.tokenId) ?? 0) - fill.size)));
    }
    const yes = quantities.get(yesId) ?? 0;
    const no = quantities.get(noId) ?? 0;
    const quantity = round(Math.abs(yes - no));
    if (quantity <= EPSILON) {
      episode = null;
    } else {
      const surplusTokenId = yes > no ? yesId : noId;
      if (!episode || episode.surplusTokenId !== surplusTokenId) {
        const startedAtMs = Number.isFinite(Date.parse(fill.timestamp)) ? Date.parse(fill.timestamp) : nowSeconds * 1_000;
        episode = {
          id: `${snapshot.marketSlug}:${fill.id}`,
          residualStartedAt: new Date(startedAtMs).toISOString(),
          surplusTokenId, residualQuantity: quantity, hasMatchedShares: Math.min(yes, no) > EPSILON,
          residualAgeSeconds: Math.max(0, nowSeconds - startedAtMs / 1_000),
        };
      }
      episode.residualQuantity = quantity;
      episode.hasMatchedShares = Math.min(yes, no) > EPSILON;
    }
  }
  const yesShares = quantities.get(yesId) ?? 0;
  const noShares = quantities.get(noId) ?? 0;
  const pairedShares = Math.min(yesShares, noShares);
  return {
    fills, yesShares, noShares, pairedShares,
    unpairedShares: round(Math.abs(yesShares - noShares)),
    episode,
    unpairedCost: episode ? lotCost(lots.get(episode.surplusTokenId) ?? [], episode.residualQuantity, true) : 0,
    lockedPnl: round(pairedShares - lotCost(lots.get(yesId) ?? [], pairedShares, false) - lotCost(lots.get(noId) ?? [], pairedShares, false)),
  };
}

/** Rechecked inside each executor's mutation lock, not just when planning. */
export function ladderV13SellGuard(snapshot: MarketExecutionSnapshot, tokenId: string, size: number): string | null {
  if (!Number.isFinite(size) || size <= 0) return "invalid_size";
  if (snapshot.marketDataValid === false) return "invalid_market_data";
  if (snapshot.executionPending) return "pending_execution_reconciliation";
  if (snapshot.openOrders.some((order) => order.pairId?.startsWith("ladder-v13:"))) return "cancel_v13_orders_before_sale";
  const inventory = ladderV13Inventory(snapshot);
  if (!inventory.episode || inventory.episode.surplusTokenId !== tokenId || size > inventory.unpairedShares + EPSILON) {
    return "sale_exceeds_v13_residual";
  }
  return null;
}
