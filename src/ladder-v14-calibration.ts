import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Two streaming passes keep every evaluation on disk rather than in the trading loop's RAM. */
export async function residualCalibration(directory: string) {
  const path = join(directory, "ladder-v14-residual-shadow.jsonl");
  const settlements = new Map<string, { winningTokenId: string; lifecycle: { settlementResidualPnl: number | null } }>();
  const rows = async function* () {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line);
    }
  };
  for await (const row of rows()) if (row.type === "settlement") settlements.set(row.marketSlug, row);
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    range: `${i * 10}-${(i + 1) * 10}%`, observations: 0, settled: 0, wins: 0,
    probabilitySum: 0, holdPnlSum: 0, sellPnlSum: 0, hedgePnlSum: 0, sells: 0, hedges: 0,
  }));
  const actions: Record<string, number> = {};
  const markets = new Set<string>();
  for await (const row of rows()) {
    if (row.type !== "evaluation") continue;
    actions[row.action] = (actions[row.action] ?? 0) + 1;
    markets.add(row.marketSlug);
    if (row.holdValue === null || !Number.isFinite(row.holdValue)) continue;
    const bucket = buckets[Math.min(9, Math.max(0, Math.floor(row.holdValue * 10)))]!;
    bucket.observations++;
    const settlement = settlements.get(row.marketSlug);
    if (!settlement) continue;
    const win = Number(settlement.winningTokenId === row.heldTokenId);
    bucket.settled++;
    bucket.wins += win;
    bucket.probabilitySum += row.holdValue;
    bucket.holdPnlSum += win - row.context.entryPrice;
    if (row.sellPnl !== null) { bucket.sellPnlSum += row.sellPnl; bucket.sells++; }
    if (row.hedgePnl !== null) { bucket.hedgePnlSum += row.hedgePnl; bucket.hedges++; }
  }
  return {
    observationUnit: "Evaluation, not independent trade. Repeated evaluations are correlated; averages are per share. Counterfactuals reuse historical depth and do not simulate a changed strategy.",
    marketCount: markets.size, settledMarketCount: settlements.size, actionEvaluations: actions,
    actualResidualSettlementPnl: [...settlements.values()].reduce((sum, s) => sum + (s.lifecycle.settlementResidualPnl ?? 0), 0),
    buckets: buckets.map(b => ({ range: b.range, observations: b.observations, settled: b.settled,
      actualWinRate: b.settled ? b.wins / b.settled : null,
      averageEstimatedProbability: b.settled ? b.probabilitySum / b.settled : null,
      calibrationError: b.settled ? (b.wins - b.probabilitySum) / b.settled : null,
      averageHoldPnl: b.settled ? b.holdPnlSum / b.settled : null,
      averageSellCounterfactualPnl: b.sells ? b.sellPnlSum / b.sells : null,
      averageHedgeCounterfactualPnl: b.hedges ? b.hedgePnlSum / b.hedges : null,
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: npx tsx src/ladder-v14-calibration.ts <paper-directory>");
  console.log(JSON.stringify(await residualCalibration(process.argv[2]), null, 2));
}
