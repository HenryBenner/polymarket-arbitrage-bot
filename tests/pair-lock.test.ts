import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderTracker } from "../src/ladder.js";
import {
  derivePairLockInventory,
  findPairLockOpeningOpportunities,
  planPairLockCompletions,
} from "../src/pair-lock.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function openingOrder(
  id: string,
  tokenId: string,
  outcome: string,
  price: number,
  size = 10,
): PaperOrder {
  return {
    id,
    tradeKey: id,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId,
    outcome,
    limitPrice: price,
    originalSize: size,
    remainingSize: 0,
    queueAhead: 0,
    status: "filled",
    orderPolicy: "post_only",
    pairLockRole: "opening",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function fill(
  id: string,
  order: PaperOrder,
  price = order.limitPrice,
  size = order.originalSize,
  timestamp = "2026-01-01T00:00:00.000Z",
): PaperFill {
  return {
    id,
    orderId: order.id,
    marketSlug: order.marketSlug,
    tokenId: order.tokenId,
    outcome: order.outcome,
    price,
    size,
    fee: 0,
    liquidity: "maker",
    timestamp,
  };
}

function snapshot(
  orders: PaperOrder[],
  fills: PaperFill[],
  books = testBooks(0.4, 0.7),
): MarketExecutionSnapshot {
  return {
    marketSlug: testEvent().slug,
    orders,
    openOrders: orders.filter(
      (order) => order.status === "open" || order.status === "partial",
    ),
    fills,
    positions: [],
    books,
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 1_000,
    totalFees: 0,
    estimatedMakerRebate: 0,
    takerFeeRate: 0.07,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

test("pair-lock openings reuse V1 phases and sizes but submit only the cheap side post-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pair-lock-open-"));
  try {
    const tracker = new LadderTracker(directory);
    await tracker.init();
    const event = testEvent();
    const now = event.windowEnd - 12 * 60;
    const opportunities = await findPairLockOpeningOpportunities(
      testConfig({
        strategyMode: "odahoa_ladder_2",
        paperStatePath: directory,
      }),
      tracker,
      event,
      testBooks(0.5, 0.6),
      now,
    );
    assert.deepEqual(
      opportunities.map((opportunity) => [
        opportunity.token.outcome,
        opportunity.price,
        opportunity.size,
        opportunity.orderPolicy,
        opportunity.pairLockRole,
      ]),
      [
        ["Up", 0.45, 2.23, "post_only", "opening"],
        ["Up", 0.4, 2.5, "post_only", "opening"],
      ],
    );

    await tracker.mark(opportunities[0]!.tradeKey);
    const retry = await findPairLockOpeningOpportunities(
      testConfig({
        strategyMode: "odahoa_ladder_2",
        paperStatePath: directory,
      }),
      tracker,
      event,
      testBooks(0.41, 0.6),
      now,
    );
    assert.deepEqual(retry.map((opportunity) => opportunity.price), [0.4]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inventory reserves one cheap residual side and matches higher-cost lots first", () => {
  const cheapUp = openingOrder("up-10", "up-token", "Up", 0.1);
  const costlyUp = openingOrder("up-35", "up-token", "Up", 0.35);
  const down = openingOrder("down-60", "down-token", "Down", 0.6);
  const inventory = derivePairLockInventory(
    testConfig({ strategyMode: "odahoa_ladder_2" }),
    snapshot(
      [cheapUp, costlyUp, down],
      [
        fill("fill-up-10", cheapUp, 0.1, 10, "2026-01-01T00:00:00Z"),
        fill("fill-up-35", costlyUp, 0.35, 10, "2026-01-01T00:00:01Z"),
        fill("fill-down", down, 0.6, 10, "2026-01-01T00:00:02Z"),
      ],
    ),
  );
  assert.equal(inventory.residualOutcome, "Up");
  assert.equal(inventory.naturallyPairedShares, 10);
  assert.equal(
    inventory.lots.find((lot) => lot.fillId === "fill-up-35")
      ?.remainingShares,
    0,
  );
  const cheapLot = inventory.lots.find(
    (lot) => lot.fillId === "fill-up-10",
  );
  assert.equal(cheapLot?.residualShares, 1);
  assert.equal(cheapLot?.remainingShares, 9);
  assert.equal(
    inventory.lots.find((lot) => lot.fillId === "fill-down")
      ?.residualShares,
    0,
  );
});

test("maker completion uses the highest passive profitable tick and is resized by source inventory", () => {
  const source = openingOrder("source", "up-token", "Up", 0.35, 10);
  const execution = snapshot(
    [source],
    [fill("source-fill", source)],
    testBooks(0.4, 0.7),
  );
  const event = testEvent();
  const plan = planPairLockCompletions(
    testConfig({ strategyMode: "odahoa_ladder_2" }),
    event,
    execution,
    event.windowEnd - 8 * 60,
  );
  assert.equal(plan.opportunities.length, 1);
  assert.equal(plan.opportunities[0]?.orderPolicy, "post_only");
  assert.equal(plan.opportunities[0]?.pairLockRole, "completion_maker");
  assert.equal(plan.opportunities[0]?.price, 0.63);
  assert.equal(plan.opportunities[0]?.size, 10);
  assert.ok(0.35 + (plan.opportunities[0]?.price ?? 1) <= 0.985);
});

test("FAK completion consumes only fee-adjusted profitable visible depth and cancels its maker", () => {
  const source = openingOrder("source", "up-token", "Up", 0.35, 10);
  const maker: PaperOrder = {
    ...openingOrder("maker", "down-token", "Down", 0.63, 10),
    remainingSize: 10,
    status: "open",
    phaseId: "10-5",
    pairLockRole: "completion_maker",
    pairLockSourceFillId: "source-fill",
  };
  const books = testBooks(0.4, 0.6);
  books[1]!.asks = [
    { price: 0.6, size: 4 },
    { price: 0.62, size: 10 },
  ];
  books[1]!.bestAsk = 0.6;
  const execution = snapshot(
    [source, maker],
    [fill("source-fill", source)],
    books,
  );
  const event = testEvent();
  const plan = planPairLockCompletions(
    testConfig({ strategyMode: "odahoa_ladder_2" }),
    event,
    execution,
    event.windowEnd - 8 * 60,
  );
  assert.deepEqual(plan.cancelOrderIds, ["maker"]);
  const taker = plan.opportunities[0]!;
  assert.equal(taker.orderPolicy, "fak");
  assert.equal(taker.pairLockRole, "completion_taker");
  assert.equal(taker.pairLockSourceFillId, "source-fill");
  assert.equal(taker.size, 10);
  assert.equal(taker.price, 0.62);

  const firstFee = 0.07 * 0.6 * 0.4;
  const secondFee = 0.07 * 0.62 * 0.38;
  const averagePairCost =
    (4 * (0.35 + 0.6 + firstFee) +
      (taker.size - 4) * (0.35 + 0.62 + secondFee)) /
    taker.size;
  assert.ok(averagePairCost <= 0.985 + 1e-8);
});

test("completion orders are cancelled when the market phase has ended", () => {
  const source = openingOrder("source", "up-token", "Up", 0.35, 10);
  const maker: PaperOrder = {
    ...openingOrder("maker", "down-token", "Down", 0.63, 10),
    remainingSize: 10,
    status: "open",
    pairLockRole: "completion_maker",
    pairLockSourceFillId: "source-fill",
  };
  const event = testEvent();
  const plan = planPairLockCompletions(
    testConfig({ strategyMode: "odahoa_ladder_2" }),
    event,
    snapshot([source, maker], [fill("source-fill", source)]),
    event.windowEnd + 1,
  );
  assert.deepEqual(plan.cancelOrderIds, ["maker"]);
  assert.deepEqual(plan.opportunities, []);
});
