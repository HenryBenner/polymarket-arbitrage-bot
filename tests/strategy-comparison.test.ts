import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePaperStrategies,
  type PaperLedger,
} from "../src/strategy-comparison.js";
import type { PaperFill, PaperSettlement } from "../src/types.js";

function settlement(
  marketSlug: string,
  payout: number,
  totalCost: number,
  totalFees = 0,
): PaperSettlement {
  return {
    marketSlug,
    winningTokenId: "up",
    winningOutcome: "Up",
    payout,
    totalCost,
    totalFees,
    realizedPnl: payout - totalCost - totalFees,
    settledAt: new Date(Number(marketSlug.match(/(\d+)$/)?.[1]) * 1000).toISOString(),
  };
}

function fill(
  marketSlug: string,
  outcome: string,
  liquidity: "maker" | "taker",
  price: number,
  size: number,
  fee = 0,
): PaperFill {
  return {
    id: `${marketSlug}-${outcome}-${liquidity}`,
    orderId: `${marketSlug}-${outcome}`,
    marketSlug,
    tokenId: outcome.toLowerCase(),
    outcome,
    price,
    size,
    fee,
    liquidity,
    timestamp: "1",
  };
}

test("paired comparison uses common markets and rebate-adjusted profit", () => {
  const first = "btc-updown-15m-100";
  const second = "btc-updown-15m-200";
  const baseline: PaperLedger = {
    settlements: [
      settlement(first, 10, 11, 0.2),
      settlement(second, 10, 9, 0.2),
      settlement("btc-updown-15m-300", 10, 0),
    ],
    fills: [
      fill(first, "Up", "taker", 0.5, 10, 0.2),
      fill(second, "Down", "maker", 0.4, 10),
    ],
  };
  const candidate: PaperLedger = {
    settlements: [
      settlement(first, 10, 8),
      settlement(second, 10, 8),
    ],
    fills: [
      fill(first, "Up", "maker", 0.4, 10),
      fill(first, "Down", "maker", 0.4, 10),
      fill(second, "Up", "maker", 0.4, 10),
      fill(second, "Down", "maker", 0.4, 10),
    ],
  };

  const comparison = comparePaperStrategies(baseline, candidate, 2);
  assert.equal(comparison.commonMarkets, 2);
  assert.equal(comparison.winner, "candidate");
  assert.ok(comparison.candidate.adjustedPnl > comparison.baseline.adjustedPnl);
  assert.equal(comparison.candidate.makerFillShare, 1);
  assert.equal(comparison.candidate.twoSidedMarketShare, 1);
  assert.ok(comparison.candidate.estimatedMakerRebate > 0);
  assert.ok(comparison.pairedBootstrap95.low > 0);
});
