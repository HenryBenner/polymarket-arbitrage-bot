import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { v15CycleReports, type V15CycleReport } from "./ladder-v15-inventory.js";
import type { PaperFill, PaperOrder, PaperSettlement } from "./types.js";

export interface V15ReportState {
  orders: PaperOrder[]; fills: PaperFill[]; settlements: PaperSettlement[]; v15Cycles?: V15CycleReport[];
}

export function summarizeV15(state: V15ReportState) {
  const cycles = [...(state.v15Cycles ?? [])];
  for (const slug of new Set(state.orders.map(order => order.marketSlug))) {
    if (state.settlements.some(s => s.marketSlug === slug)) continue;
    const orders = state.orders.filter(order => order.marketSlug === slug);
    cycles.push(...v15CycleReports({ orders, fills: state.fills.filter(fill => fill.marketSlug === slug) },
      slug, orders[0]?.tokenId.split("-")[0] ?? "unknown"));
  }
  const groups = new Map<string, V15CycleReport[]>();
  for (const cycle of cycles) {
    const key = `${cycle.series}/${cycle.bucket}`;
    groups.set(key, [...(groups.get(key) ?? []), cycle]);
  }
  const byEntryTiming = [...groups].map(([group, rows]) => {
    const filled = rows.filter(row => row.entryShares > 0);
    const resolved = filled.filter(row => row.settled || row.residualShares <= 1e-8);
    const sum = (key: "entryShares" | "pairedShares" | "deployedNotional" | "realizedPnl" | "fees") => rows.reduce((n, row) => n + row[key], 0);
    const entryShares = sum("entryShares");
    return { group, cycles: filled.length, resolvedCycles: resolved.length,
      unfilledEntryAttempts: rows.filter(row => row.entryShares === 0).length,
      realizedPnl: sum("realizedPnl"), deployedNotional: sum("deployedNotional"), fees: sum("fees"),
      entryShares, pairedShares: sum("pairedShares"),
      profitPerEntryContract: resolved.length ? resolved.reduce((n, row) => n + row.realizedPnl, 0) /
        resolved.reduce((n, row) => n + row.entryShares, 0) : null,
      completionRate: entryShares ? sum("pairedShares") / entryShares : null,
      residualLosses: rows.reduce((n, row) => n + Math.min(0, row.residualPnl), 0),
      meanHoldingSeconds: resolved.length ? resolved.reduce((n, row) => n + (row.holdingSeconds ?? 0), 0) / resolved.length : null,
      openResidualShares: rows.filter(row => !row.settled).reduce((n, row) => n + row.residualShares, 0) };
  });
  let equity = 0; let peak = 0; let settledDrawdown = 0;
  for (const settlement of [...state.settlements].sort((a, b) => a.settledAt.localeCompare(b.settledAt))) {
    equity += settlement.realizedPnl; peak = Math.max(peak, equity); settledDrawdown = Math.max(settledDrawdown, peak - equity);
  }
  return { settledMarkets: state.settlements.length, settledNetPnl: equity, settledDrawdown,
    settledFees: state.settlements.reduce((sum, settlement) => sum + settlement.totalFees, 0),
    worstMarket: [...state.settlements].sort((a, b) => a.realizedPnl - b.realizedPnl)[0] ?? null,
    byEntryTiming, caveat: "Timing buckets are observational: earlier residuals can prevent later entries. Open inventory is not marked as realized profit. Drawdown here uses settlements, not intramarket marks." };
}

export async function readV15Report(directory: string) {
  return summarizeV15(JSON.parse(await readFile(join(directory, "paper-state.json"), "utf8")) as V15ReportState);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directories = process.argv.slice(2);
  if (!directories.length || directories.includes("--help")) {
    console.log("Usage: npm run report:ladder-v15 -- <paper-directory> [more directories]");
  } else {
    for (const directory of directories) console.log(JSON.stringify({ directory, ...await readV15Report(directory) }, null, 2));
  }
}
