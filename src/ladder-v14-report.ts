import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MarketExecutionSnapshot } from "./types.js";

/** Non-overlapping FIFO accounting attribution, including both legs' fees. */
export function v14LifecycleReport(snapshot: MarketExecutionSnapshot, endMs: number) {
  const orders = new Map(snapshot.orders.filter(order =>
    order.pairId?.startsWith("ladder-v14:")).map(order => [order.id, order]));
  const fills = [...new Map(snapshot.fills.filter(fill => orders.has(fill.orderId))
    .map(fill => [fill.id, fill])).values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const lots: Array<{ token: string; size: number; cost: number; opening: boolean; taker: boolean }> = [];
  let openingPairPnl = 0, makerRepairPairPnl = 0, takerRepairPairPnl = 0;
  let takerHedgeLosses = 0, residualSalePnl = 0, residualSaleLosses = 0;
  let unpairedSeconds = 0, unpairedShareSeconds = 0, episodes = 0;
  let previousMs: number | null = null;
  let priorQuantity = 0;
  let maxResidualShares = 0;
  let openingShares = 0, grossCapitalDeployed = 0;
  let openingCost = 0, maxOpeningFill = 0;
  let makerRepairShares = 0, takerRepairShares = 0, soldResidualShares = 0;
  let openingPairShares = 0;
  const advance = (atMs: number) => {
    if (previousMs !== null && priorQuantity > 1e-8) {
      const seconds = Math.max(0, atMs - previousMs) / 1000;
      unpairedSeconds += seconds;
      unpairedShareSeconds += priorQuantity * seconds;
    }
    previousMs = atMs;
  };
  for (const fill of fills) {
    const atMs = Date.parse(fill.timestamp);
    if (!Number.isFinite(atMs) || atMs > endMs || fill.size <= 0) continue;
    advance(atMs);
    const order = orders.get(fill.orderId)!;
    let remaining = fill.size;
    const selling = fill.side === "SELL";
    const allIn = fill.price + (selling ? -1 : 1) * fill.fee / fill.size;
    const opening = order.pairId === "ladder-v14:opening";
    const taker = !opening && fill.liquidity === "taker";
    if (!selling) grossCapitalDeployed += fill.price * fill.size + fill.fee;
    if (opening && !selling) { openingShares += fill.size; openingCost += fill.price * fill.size + fill.fee;
      maxOpeningFill = Math.max(maxOpeningFill, fill.size); }
    // Sales consume highest-cost residual lots, matching inventory replay.
    const eligible = lots.filter(lot => selling ? lot.token === fill.tokenId : lot.token !== fill.tokenId);
    if (selling) eligible.sort((a, b) => b.cost - a.cost);
    for (const lot of eligible) {
      const size = Math.min(remaining, lot.size);
      const pnl = size * (selling ? allIn - lot.cost : 1 - allIn - lot.cost);
      if (selling) {
        soldResidualShares += size;
        residualSalePnl += pnl;
        residualSaleLosses += Math.max(0, -pnl);
      } else if (opening && lot.opening) { openingPairPnl += pnl; openingPairShares += size; }
      else if (taker || lot.taker) {
        takerRepairShares += size;
        takerRepairPairPnl += pnl;
        takerHedgeLosses += Math.max(0, -pnl);
      } else { makerRepairPairPnl += pnl; makerRepairShares += size; }
      remaining -= size;
      lot.size -= size;
      if (remaining <= 1e-8) break;
    }
    if (!selling && remaining > 1e-8) lots.push({ token: fill.tokenId,
      size: remaining, cost: allIn, opening, taker });
    const quantity = lots.reduce((sum, lot) => sum + lot.size, 0);
    maxResidualShares = Math.max(maxResidualShares, quantity);
    if (priorQuantity <= 1e-8 && quantity > 1e-8) episodes++;
    priorQuantity = quantity;
  }
  advance(endMs);
  const pairedPnl = openingPairPnl + makerRepairPairPnl + takerRepairPairPnl;
  return {
    marketSlug: snapshot.marketSlug, asOf: new Date(endMs).toISOString(),
    openingPairPnl, makerRepairPairPnl, takerRepairPairPnl, pairedPnl,
    takerHedgeLosses, residualSalePnl, residualSaleLosses,
    repairLosses: takerHedgeLosses + residualSaleLosses,
    unpairedSeconds, unpairedShareSeconds, episodes,
    endingUnpairedShares: priorQuantity,
    openingShares, openingCost, grossCapitalDeployed, maxOpeningFill,
    openingPairShares, makerRepairShares, takerRepairShares, soldResidualShares,
    maxResidualShares,
    pnlPerOpeningShare: snapshot.settledPnl === null || openingShares === 0 ? null : snapshot.settledPnl / openingShares,
    pnlPerDeployedDollar: snapshot.settledPnl === null || grossCapitalDeployed === 0 ? null : snapshot.settledPnl / grossCapitalDeployed,
    settledPnl: snapshot.settledPnl,
    // Kept separate: settlement losses must not disappear from repair reporting.
    settlementResidualPnl: snapshot.settledPnl === null ? null
      : snapshot.settledPnl - pairedPnl - residualSalePnl,
  };
}

export type V14LifecycleReport = ReturnType<typeof v14LifecycleReport>;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: npm run report:ladder-v14 -- <paper-directory>");
  const state = JSON.parse(await readFile(join(directory, "ladder-v14-history.json"), "utf8"));
  const markets = (state.lifecycleReports ?? []) as V14LifecycleReport[];
  const totals = Object.fromEntries([
    "openingPairPnl", "makerRepairPairPnl", "takerRepairPairPnl", "pairedPnl",
    "takerHedgeLosses", "residualSalePnl", "residualSaleLosses", "repairLosses",
    "unpairedSeconds", "unpairedShareSeconds", "episodes", "settlementResidualPnl",
    "openingShares", "openingCost", "grossCapitalDeployed", "maxOpeningFill", "openingPairShares", "makerRepairShares", "takerRepairShares", "soldResidualShares", "endingUnpairedShares", "settledPnl",
  ].map(key => [key, markets.reduce((sum, row) =>
    sum + Number(row[key as keyof V14LifecycleReport] ?? 0), 0)]));
  console.log(JSON.stringify({
    coverage: "Markets finalized by this version; historical markets without lifecycle reports are excluded.",
    marketCount: markets.length, totals,
    pnlPerOpeningShare: totals.openingShares ? totals.settledPnl! / totals.openingShares : null,
    pnlPerDeployedDollar: totals.grossCapitalDeployed ? totals.settledPnl! / totals.grossCapitalDeployed : null,
    worstMarkets: [...markets].filter(m => m.settledPnl !== null).sort((a, b) => a.settledPnl! - b.settledPnl!).slice(0, 10),
    markets,
  }, null, 2));
}
