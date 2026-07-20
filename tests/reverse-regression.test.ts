import assert from "node:assert/strict";
import test from "node:test";
import { findOpportunities } from "../src/strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

test("reverse mode prices, sizing, keys, and tracker behavior are unchanged", () => {
  const config = testConfig({
    strategyMode: "reverse",
    marketSlugPrefixes: ["btc-updown-15m", "eth-updown-15m"],
  });
  const tracker = new TradeTracker();
  const opportunities = findOpportunities(
    config,
    tracker,
    testEvent(),
    testBooks(),
  );

  assert.deepEqual(
    opportunities.map((opportunity) => opportunity.price),
    [0.07, 0.08, 0.09, 0.1, 0.9, 0.91, 0.92, 0.93, 0.94, 0.95],
  );
  assert.deepEqual(
    opportunities.slice(0, 4).map((opportunity) => opportunity.size),
    [90, 90, 90, 90],
  );
  assert.equal(
    opportunities[0]?.tradeKey,
    `${testEvent().slug}:Up:cheap-0.07`,
  );
  tracker.mark(opportunities[0]!.tradeKey);
  const repeated = findOpportunities(
    config,
    tracker,
    testEvent(),
    testBooks(),
  );
  assert.equal(repeated.some((item) => item.price === 0.07), false);
  assert.equal(repeated.length, opportunities.length - 1);
});
