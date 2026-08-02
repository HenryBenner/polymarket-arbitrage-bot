import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planLadderV7 } from "../src/ladder-v7.js";
import { LadderTracker } from "../src/ladder.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function order(
  role: "cheap-maker" | "favorite-fak",
  tokenId: string,
  outcome: string,
  price: number,
  status: PaperOrder["status"] = "open",
): PaperOrder {
  return {
    id: `v7-${role}`,
    tradeKey: `ladder-v7:${testEvent().slug}:5-2:${role}`,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId,
    outcome,
    limitPrice: price,
    originalSize: 20,
    remainingSize: status === "filled" ? 0 : 20,
    queueAhead: 0,
    status,
    phaseId: "5-2",
    pairId: `ladder-v7:${role}`,
    orderPolicy: role === "cheap-maker" ? "post_only" : "fak",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function fill(orderValue: PaperOrder, size = 20): PaperFill {
  return {
    id: `fill-${orderValue.id}`,
    orderId: orderValue.id,
    marketSlug: orderValue.marketSlug,
    tokenId: orderValue.tokenId,
    outcome: orderValue.outcome,
    price: orderValue.limitPrice,
    size,
    fee: 0,
    liquidity:
      orderValue.orderPolicy === "post_only" ? "maker" : "taker",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function snapshot(
  orders: PaperOrder[] = [],
  fills: PaperFill[] = [],
): MarketExecutionSnapshot {
  return {
    marketSlug: testEvent().slug,
    orders,
    openOrders: orders.filter(
      (candidate) =>
        candidate.status === "open" || candidate.status === "partial",
    ),
    fills,
    positions: [],
    books: testBooks(0.4, 0.6),
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 2_000,
    totalFees: 0,
    estimatedMakerRebate: 0,
    takerFeeRate: 0.07,
    makerFeeRate: 0,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

async function withTracker(
  run: (tracker: LadderTracker, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v7-"));
  try {
    const tracker = new LadderTracker(directory, "ladder-v7-state.json");
    await tracker.init();
    await run(tracker, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ladder_v7 posts one fixed cheap maker then one capped favorite FAK", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v7",
      ladderSizeScale: 2,
      ladderV7MaxShares: 20,
      paperStatePath: directory,
    });
    const first = await planLadderV7(
      config,
      tracker,
      event,
      testBooks(0.4, 0.6),
      snapshot(),
      event.windowEnd - 4 * 60,
    );
    assert.equal(first.opportunities.length, 1);
    assert.deepEqual(
      {
        kind: first.opportunities[0]!.kind,
        outcome: first.opportunities[0]!.token.outcome,
        price: first.opportunities[0]!.price,
        size: first.opportunities[0]!.size,
        policy: first.opportunities[0]!.orderPolicy,
      },
      {
        kind: "cheap",
        outcome: "Up",
        price: 0.1,
        size: 20,
        policy: "post_only",
      },
    );

    const cheap = order("cheap-maker", "up-token", "Up", 0.1);
    const second = await planLadderV7(
      config,
      tracker,
      event,
      testBooks(0.4, 0.6),
      snapshot([cheap]),
      event.windowEnd - 4 * 60,
    );
    assert.equal(second.opportunities.length, 1);
    assert.deepEqual(
      {
        kind: second.opportunities[0]!.kind,
        outcome: second.opportunities[0]!.token.outcome,
        price: second.opportunities[0]!.price,
        size: second.opportunities[0]!.size,
        policy: second.opportunities[0]!.orderPolicy,
      },
      {
        kind: "expensive",
        outcome: "Down",
        price: 0.8,
        size: 20,
        policy: "fak",
      },
    );
  });
});

test("ladder_v7 hard-caps both sides even when scale requests more", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v7",
      ladderSizeScale: 6,
      ladderV7MaxShares: 20,
      paperStatePath: directory,
    });
    const cheapPlan = await planLadderV7(
      config,
      tracker,
      event,
      testBooks(0.4, 0.6),
      snapshot(),
      event.windowEnd - 4 * 60,
    );
    assert.equal(cheapPlan.opportunities[0]!.size, 20);

    const cheap = order("cheap-maker", "up-token", "Up", 0.1);
    const favoritePlan = await planLadderV7(
      config,
      tracker,
      event,
      testBooks(0.4, 0.6),
      snapshot([cheap]),
      event.windowEnd - 4 * 60,
    );
    assert.equal(favoritePlan.opportunities[0]!.size, 20);
  });
});

test("ladder_v7 never submits a cheap taker when the 10-cent bid would cross", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.08, 0.92);
    const plan = await planLadderV7(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v7",
        ladderSizeScale: 2,
        paperStatePath: directory,
      }),
      tracker,
      event,
      books,
      { ...snapshot(), books },
      event.windowEnd - 4 * 60,
    );
    assert.equal(plan.opportunities.length, 1);
    assert.equal(plan.opportunities[0]!.orderPolicy, "fak");
    assert.equal(plan.opportunities[0]!.price, 0.8);
  });
});

test("ladder_v7 records paired and unmatched inventory without reopening", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = order("cheap-maker", "up-token", "Up", 0.1, "filled");
    const favorite = order(
      "favorite-fak",
      "down-token",
      "Down",
      0.8,
      "filled",
    );
    const plan = await planLadderV7(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v7",
        ladderSizeScale: 2,
        paperStatePath: directory,
      }),
      tracker,
      event,
      testBooks(0.4, 0.6),
      snapshot(
        [cheap, favorite],
        [fill(cheap, 20), fill(favorite, 12)],
      ),
      event.windowEnd - 3 * 60,
    );
    assert.deepEqual(plan.opportunities, []);
    assert.equal(plan.pairedShares, 12);
    assert.equal(plan.unmatchedShares, 8);
    assert.deepEqual(plan.filledSharesByOutcome, { Up: 20, Down: 12 });
  });
});

test("ladder_v7 cancels its resting maker at the two-minute cutoff", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = order("cheap-maker", "up-token", "Up", 0.1);
    const plan = await planLadderV7(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v7",
        ladderSizeScale: 2,
        paperStatePath: directory,
      }),
      tracker,
      event,
      testBooks(0.4, 0.6),
      snapshot([cheap]),
      event.windowEnd - 2 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, [cheap.id]);
    assert.deepEqual(plan.opportunities, []);
  });
});
