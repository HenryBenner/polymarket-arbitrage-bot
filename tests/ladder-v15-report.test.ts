import assert from "node:assert/strict";
import test from "node:test";
import { v15ComparisonConfigs } from "../src/ladder-v15-comparison.js";
import { summarizeV15 } from "../src/ladder-v15-report.js";
import type { V15CycleReport } from "../src/ladder-v15-inventory.js";
import { testConfig } from "./helpers.js";

test("V15 comparison isolates portfolios and scales only V15 inventory sizing", () => {
  const base = testConfig({ ladderV9TargetShares: 37, ladderV14CycleShares: 11 });
  const variants = v15ComparisonConfigs(base, "experiment");
  assert.equal(new Set(variants.map(v => v.config.paperStatePath)).size, 5);
  assert.deepEqual(variants.slice(2).map(v => v.config.ladderV15CycleShares), [40, 160, 640]);
  assert.deepEqual(variants.slice(2).map(v => v.config.ladderV15MaxUnmatchedPortfolio), [120, 480, 1920]);
  assert.equal(variants[0]!.config.ladderV9TargetShares, 37);
  assert.equal(variants[1]!.config.ladderV14CycleShares, 11);
  assert.ok(variants.every(v => v.config.executionMode === "paper"));
});

test("V15 timing report separates unfilled and unresolved cycles from resolved profit per contract", () => {
  const cycle: V15CycleReport = { marketSlug: "btc-test", series: "KXBTC15M", cycleId: 1,
    bucket: "15-10", firstFillAt: "2026-09-07T00:00:00Z", minutesRemaining: 12,
    entryShares: 40, pairedShares: 40, soldShares: 0, residualShares: 0,
    deployedNotional: 36, fees: 1, realizedPnl: 3, residualPnl: 0, holdingSeconds: 60,
    settled: true, exitReasons: ["completion-taker"] };
  const report = summarizeV15({ orders: [], fills: [], settlements: [], v15Cycles: [cycle,
    { ...cycle, cycleId: 2, pairedShares: 0, residualShares: 40, realizedPnl: 0, settled: false, holdingSeconds: null },
    { ...cycle, cycleId: 3, bucket: "unfilled", entryShares: 0, pairedShares: 0, realizedPnl: 0, deployedNotional: 0, fees: 0 }] });
  const group = report.byEntryTiming.find(row => row.group === "KXBTC15M/15-10")!;
  assert.equal(group.profitPerEntryContract, 0.075);
  assert.equal(group.completionRate, 0.5);
  assert.equal(group.openResidualShares, 40);
  assert.equal(group.meanHoldingSeconds, 60);
  assert.equal(report.byEntryTiming.find(row => row.group.endsWith("unfilled"))!.unfilledEntryAttempts, 1);
});
