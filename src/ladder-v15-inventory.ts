import type { MarketExecutionSnapshot, PaperFill, PaperOrder, PaperSettlement, TradeOpportunity } from "./types.js";
import type { BotConfig } from "./config.js";
import { exactKalshiDepthCost, exactKalshiOrderFee } from "./kalshi-fees.js";

export const V15_PREFIX = "ladder-v15:";
export const v15Round = (value: number): number => Math.round(value * 1e8) / 1e8;
export function v15OrderRole(order: Pick<PaperOrder, "pairId">): string {
  return order.pairId?.startsWith(V15_PREFIX) ? order.pairId.split(":")[2] ?? "" : "";
}
export function v15CycleId(order: Pick<PaperOrder, "pairId">): number {
  return order.pairId?.startsWith(V15_PREFIX) ? Number(order.pairId.split(":")[1]) : 0;
}
export interface V15Lot { tokenId: string; size: number; allInPrice: number; }
export interface V15Cycle {
  id: number;
  orders: PaperOrder[];
  lots: V15Lot[];
  entryTokenId: string;
  entryShares: number;
  pairedShares: number;
  soldShares: number;
  deployedNotional: number;
  fees: number;
  realizedPnl: number;
  residualPnl: number;
  firstFillAt: string | null;
  lastFillAt: string | null;
  minutesRemaining: number | null;
  bucket: string;
}

/** The executor's checkpoint is the source of truth; no independent mutable fill ledger. */
export function v15Inventory(snapshot: Pick<MarketExecutionSnapshot, "orders" | "fills">): V15Cycle[] {
  const cycles = new Map<number, V15Cycle>();
  const byOrder = new Map<string, V15Cycle>();
  for (const order of snapshot.orders) {
    const id = v15CycleId(order);
    if (!id) continue;
    let cycle = cycles.get(id);
    if (!cycle) {
      cycle = { id, orders: [], lots: [], entryTokenId: "", entryShares: 0,
        pairedShares: 0, soldShares: 0, deployedNotional: 0, fees: 0,
        realizedPnl: 0, residualPnl: 0, firstFillAt: null, lastFillAt: null,
        minutesRemaining: null, bucket: "unfilled" };
      cycles.set(id, cycle);
    }
    cycle.orders.push(order);
    if (v15OrderRole(order) === "entry") cycle.entryTokenId = order.tokenId;
    byOrder.set(order.id, cycle);
  }
  const seen = new Set<string>();
  const fills = [...snapshot.fills].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const fill of fills) {
    if (seen.has(fill.id)) continue;
    seen.add(fill.id);
    const cycle = byOrder.get(fill.orderId);
    if (!cycle) continue;
    const order = cycle.orders.find(item => item.id === fill.orderId)!;
    const sale = fill.side === "SELL";
    const allIn = fill.price + (sale ? -1 : 1) * fill.fee / fill.size;
    cycle.fees += fill.fee;
    cycle.lastFillAt = fill.timestamp;
    if (!sale) cycle.deployedNotional += fill.size * fill.price;
    if (v15OrderRole(order) === "entry" && !sale) {
      cycle.entryShares += fill.size;
      if (!cycle.firstFillAt) {
        cycle.firstFillAt = fill.timestamp;
        cycle.minutesRemaining = (order.submittedMinutesLeft ?? 0) -
          (Date.parse(fill.timestamp) - Date.parse(order.createdAt)) / 60_000;
        const minutes = cycle.minutesRemaining;
        cycle.bucket = minutes > 10 ? "15-10" : minutes > 5 ? "10-5" : minutes >= 2 ? "5-2" : "late-fill";
      }
    }
    let remaining = fill.size;
    for (const lot of cycle.lots) {
      if (sale ? lot.tokenId !== fill.tokenId : lot.tokenId === fill.tokenId) continue;
      const size = Math.min(remaining, lot.size);
      if (size <= 0) continue;
      const pnl = size * (sale ? allIn - lot.allInPrice : 1 - allIn - lot.allInPrice);
      cycle.realizedPnl += pnl;
      if (sale) { cycle.soldShares += size; cycle.residualPnl += pnl; }
      else cycle.pairedShares += size;
      lot.size = v15Round(lot.size - size);
      remaining = v15Round(remaining - size);
    }
    cycle.lots = cycle.lots.filter(lot => lot.size > 1e-8);
    if (!sale && remaining > 1e-8) cycle.lots.push({ tokenId: fill.tokenId, size: remaining, allInPrice: allIn });
    if (sale && remaining > 1e-8) throw new Error("V15 sale exceeds remaining cycle inventory");
  }
  return [...cycles.values()].sort((a, b) => a.id - b.id);
}

export function v15Exposure(snapshot: Pick<MarketExecutionSnapshot, "orders" | "fills" | "openOrders">): number {
  return v15Round(v15Inventory(snapshot).reduce((sum, cycle) =>
    sum + cycle.lots.reduce((n, lot) => n + lot.size, 0), 0) +
    snapshot.openOrders.filter(order => v15OrderRole(order) === "entry")
      .reduce((sum, order) => sum + order.remainingSize, 0));
}

export function v15NetPositions(fills: readonly PaperFill[]): Map<string, { size: number; cost: number }> {
  const positions = new Map<string, { size: number; cost: number }>();
  for (const fill of fills) {
    const position = positions.get(fill.tokenId) ?? { size: 0, cost: 0 };
    if (fill.side === "SELL") {
      position.cost *= position.size > 0 ? Math.max(0, position.size - fill.size) / position.size : 0;
      position.size = v15Round(Math.max(0, position.size - fill.size));
    } else {
      let remaining = fill.size;
      for (const [token, other] of positions) {
        if (token === fill.tokenId) continue;
        const paired = Math.min(remaining, other.size);
        other.cost *= other.size > 0 ? (other.size - paired) / other.size : 0;
        other.size = v15Round(other.size - paired);
        remaining = v15Round(remaining - paired);
      }
      position.size = v15Round(position.size + remaining);
      position.cost += remaining * fill.price;
    }
    positions.set(fill.tokenId, position);
  }
  return positions;
}

export function v15OrderGuard(config: BotConfig, snapshot: MarketExecutionSnapshot | null,
  order: TradeOpportunity, portfolioExposure: number, sale = false): string | null {
  if (!snapshot || snapshot.marketDataValid === false || snapshot.executionPending) return "v15_invalid_snapshot";
  if (snapshot.settledPnl !== null || Date.now() >= order.event.windowEnd * 1000) return "v15_closed";
  const cycles = v15Inventory(snapshot);
  const cycle = cycles.at(-1);
  const lots = cycle?.lots ?? [];
  const role = v15OrderRole(order);
  if (role === "entry") {
    const remaining = order.event.windowEnd - Date.now() / 1000;
    if (remaining > config.ladderV15EntryMinutesMax * 60 || remaining <= config.ladderV15EntryMinutesMin * 60 ||
      order.price > config.ladderV15CheapPrice + 1e-8 || order.size > config.ladderV15CycleShares + 1e-8 ||
      v15CycleId(order) !== (cycle?.id ?? 0) + 1) return "v15_invalid_entry";
    if (sale || lots.some(lot => lot.size > 1e-8) || snapshot.openOrders.length) return "v15_pending_cycle";
    if (order.size + v15Exposure(snapshot) > config.ladderV15MaxUnmatchedPerMarket + 1e-8 ||
      order.size + portfolioExposure > config.ladderV15MaxUnmatchedPortfolio + 1e-8) return "v15_exposure_limit";
  } else {
    if (!cycle || v15CycleId(order) !== cycle.id || snapshot.openOrders.some(o => v15OrderRole(o) === "entry")) return "v15_stale_cycle";
    const available = lots.filter(lot => sale ? lot.tokenId === order.token.tokenId : lot.tokenId !== order.token.tokenId)
      .reduce((sum, lot) => sum + lot.size, 0);
    const reserved = snapshot.openOrders.filter(o => v15OrderRole(o) !== "entry")
      .reduce((sum, o) => sum + o.remainingSize, 0);
    if (order.size + reserved > available + 1e-8) return "v15_unconfirmed_inventory";
    if (!sale) {
      const worstEntry = Math.max(...lots.map(lot => lot.allInPrice));
      const maker = order.orderPolicy === "post_only";
      const book = snapshot.books.find(b => b.tokenId === order.token.tokenId);
      const cost = maker ? order.price * order.size + exactKalshiOrderFee({ price: order.price, size: order.size,
        rate: snapshot.makerFeeRate ?? 0, exponent: snapshot.takerFeeExponent }) : exactKalshiDepthCost({
          levels: (book?.asks ?? []).filter(level => level.price <= order.price + 1e-8), size: order.size,
          rate: snapshot.takerFeeRate, exponent: snapshot.takerFeeExponent })?.total;
      const emergency = role === "cleanup-hedge";
      if (emergency && order.event.windowEnd - Date.now() / 1000 > config.ladderV15CleanupSeconds) return "v15_early_emergency";
      if (cost === undefined || worstEntry + cost / order.size >
        (emergency ? config.ladderV15EmergencyPairCost : 1 - config.ladderV15MinNetEdge) + 1e-8) return "v15_pair_cost_limit";
    }
  }
  return null;
}

export interface V15CycleReport {
  marketSlug: string; series: string; cycleId: number; bucket: string;
  firstFillAt: string | null; minutesRemaining: number | null;
  entryShares: number; pairedShares: number; soldShares: number; residualShares: number;
  deployedNotional: number; fees: number; realizedPnl: number; residualPnl: number;
  holdingSeconds: number | null; settled: boolean; exitReasons: string[];
}

export function v15CycleReports(snapshot: Pick<MarketExecutionSnapshot, "orders" | "fills">,
  marketSlug: string, series: string, settlement?: PaperSettlement): V15CycleReport[] {
  return v15Inventory(snapshot).map(cycle => {
    const residualShares = cycle.lots.reduce((sum, lot) => sum + lot.size, 0);
    const settlementPnl = settlement ? cycle.lots.reduce((sum, lot) => sum + lot.size *
      ((lot.tokenId === settlement.winningTokenId ? 1 : 0) - lot.allInPrice), 0) : 0;
    const closedAt = residualShares > 1e-8 ? settlement?.settledAt : cycle.lastFillAt;
    return { marketSlug, series, cycleId: cycle.id, bucket: cycle.bucket,
      firstFillAt: cycle.firstFillAt, minutesRemaining: cycle.minutesRemaining,
      entryShares: cycle.entryShares, pairedShares: cycle.pairedShares, soldShares: cycle.soldShares,
      residualShares, deployedNotional: cycle.deployedNotional, fees: cycle.fees,
      realizedPnl: v15Round(cycle.realizedPnl + settlementPnl),
      residualPnl: v15Round(cycle.residualPnl + settlementPnl),
      holdingSeconds: closedAt && cycle.firstFillAt ? (Date.parse(closedAt) - Date.parse(cycle.firstFillAt)) / 1000 : null,
      settled: !!settlement, exitReasons: [...new Set(cycle.orders.filter(o => v15OrderRole(o) !== "entry" &&
        snapshot.fills.some(fill => fill.orderId === o.id)).map(v15OrderRole))] };
  });
}
