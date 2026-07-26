import assert from "node:assert/strict";
import test from "node:test";
import {
  findStaticMakerOpportunities,
  projectedStaticMakerCapital,
  STATIC_MAKER_LEVELS,
} from "../src/static-maker.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

test("static maker submits nine symmetric 90-share levels for $405", () => {
  const event = testEvent();
  const opportunities = findStaticMakerOpportunities(
    testConfig({
      strategyMode: "odahoa_static_maker",
      staticMakerMaxShares: 90,
      staticMakerMaxUsdcPerMarket: 500,
    }),
    new TradeTracker(),
    event,
    testBooks(0.51, 0.51, 5),
    event.windowEnd - 14 * 60,
  );

  assert.equal(opportunities.length, 18);
  assert.deepEqual(
    [...new Set(opportunities.map((opportunity) => opportunity.price))],
    [...STATIC_MAKER_LEVELS],
  );
  assert.ok(
    opportunities.every(
      (opportunity) =>
        opportunity.size === 90 &&
        opportunity.kind === "maker" &&
        opportunity.strategyMode === "odahoa_static_maker",
    ),
  );
  assert.equal(
    opportunities.reduce(
      (sum, opportunity) => sum + opportunity.price * opportunity.size,
      0,
    ),
    405,
  );
  assert.equal(projectedStaticMakerCapital(90), 405);
});

test("static maker only submits levels passive on both outcomes and retries", () => {
  const event = testEvent();
  const tracker = new TradeTracker();
  const config = testConfig({
    strategyMode: "odahoa_static_maker",
    staticMakerMaxShares: 90,
    staticMakerMaxUsdcPerMarket: 500,
  });
  const first = findStaticMakerOpportunities(
    config,
    tracker,
    event,
    testBooks(0.41, 0.51, 5),
    event.windowEnd - 14 * 60,
  );
  assert.deepEqual(
    [...new Set(first.map((opportunity) => opportunity.price))],
    [0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05],
  );
  for (const opportunity of first) tracker.mark(opportunity.tradeKey);

  const retry = findStaticMakerOpportunities(
    config,
    tracker,
    event,
    testBooks(0.51, 0.51, 5),
    event.windowEnd - 13.5 * 60,
  );
  assert.deepEqual(
    retry.map((opportunity) => opportunity.price),
    [0.45, 0.45],
  );
  for (const opportunity of retry) tracker.mark(opportunity.tradeKey);
  assert.deepEqual(
    findStaticMakerOpportunities(
      config,
      tracker,
      event,
      testBooks(0.51, 0.51, 5),
      event.windowEnd - 13.5 * 60,
    ),
    [],
  );
});

test("static maker enforces entry window, complete books, minimums, and cap", () => {
  const event = testEvent();
  const baseConfig = testConfig({
    strategyMode: "odahoa_static_maker",
    staticMakerMaxShares: 90,
    staticMakerMaxUsdcPerMarket: 500,
  });
  const find = (
    minutesLeft: number,
    books = testBooks(0.51, 0.51, 5),
    config = baseConfig,
  ) =>
    findStaticMakerOpportunities(
      config,
      new TradeTracker(),
      event,
      books,
      event.windowEnd - minutesLeft * 60,
    );

  assert.equal(find(15).length, 18);
  assert.equal(find(13.01).length, 18);
  assert.deepEqual(find(13), []);
  assert.deepEqual(find(15.01), []);

  const incomplete = testBooks(0.51, 0.51, 5);
  incomplete[1]!.bestAsk = null;
  assert.deepEqual(find(14, incomplete), []);
  assert.deepEqual(find(14, testBooks(0.51, 0.51, 91)), []);
  assert.deepEqual(
    find(
      14,
      testBooks(0.51, 0.51, 5),
      testConfig({
        strategyMode: "odahoa_static_maker",
        staticMakerMaxShares: 90,
        staticMakerMaxUsdcPerMarket: 400,
      }),
    ),
    [],
  );
});
