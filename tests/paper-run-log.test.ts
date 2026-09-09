import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperRunLog } from "../src/paper-run-log.js";
import { residualCalibration } from "../src/ladder-v14-calibration.js";

test("normal paper run emits three compact files and suppresses equivalent decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compact-paper-"));
  try {
    const log = await PaperRunLog.open(directory);
    const decision = { t: 1, m: "btc-updown-15m-1", side: "up", qty: 10,
      entry: 0.4, hold: 0.28, sell: 0.22, hedge: 0.13, wait: 0.3,
      action: "wait", age: 10, left: 800 };
    log.residual(decision); log.residual({ ...decision, t: 2, age: 11, left: 799 });
    log.residual({ ...decision, t: 3, action: "hold", age: 880, left: 20 });
    log.market({ m: decision.m, asset: "btc", winner: "up", openingShares: 10,
      makerPairShares: 0, takerPairShares: 0, heldShares: 10, pairedPnl: 1,
      residualPnl: -0.5, fees: 0.1, pnl: 0.4, grossCapital: 4, maxResidual: 10 });
    await log.close();
    assert.deepEqual((await readdir(directory)).sort(), ["markets.jsonl", "run-summary.json", "trades.jsonl"]);
    const trades = (await readFile(join(directory, "trades.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(trades.length, 2);
    assert.ok(trades.every(row => !Object.values(row).includes(null)));
    const market = JSON.parse((await readFile(join(directory, "markets.jsonl"), "utf8")).trim());
    assert.equal(market.holdRealizedCf, 6);
    const summary = JSON.parse(await readFile(join(directory, "run-summary.json"), "utf8"));
    assert.equal(summary.markets, 1);
    assert.equal(summary.residualActions.wait, 1);
    assert.equal(summary.residualActions.hold, 1);
    assert.equal(summary.residualResults.holdWins, 1);
    const calibration = await residualCalibration(directory);
    assert.equal(calibration.buckets[2]!.settled, 2);
    assert.equal(calibration.buckets[2]!.actualWinRate, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
