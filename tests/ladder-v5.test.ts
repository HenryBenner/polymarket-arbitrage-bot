import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planLadderV5 } from "../src/ladder-v5.js";
import { LadderTracker } from "../src/ladder.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  PaperPosition,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function position(
  tokenId: string,
  outcome: string,
  shares: number,
): PaperPosition {
  return {
    marketSlug: testEvent().slug,
    tokenId,
    outcome,
    shares,
    totalCost: 0,
  };
}

function fill(
  tokenId: string,
  outcome: string,
  price: number,
  size: number,
): PaperFill {
  return {
    id: `fill-${tokenId}-${price}`,
    orderId: `order-${tokenId}-${price}`,
    marketSlug: testEvent().slug,
    tokenId,
    outcome,
    price,
    size,
    fee: 0,
    liquidity: "taker",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function openV5Order(
  tokenId: string,
  outcome: string,
  price: number,
  size: number,
): PaperOrder {
  return {
    id: `open-${tokenId}-${price}`,
    tradeKey: `ladder-v5:test:${tokenId}:${price}`,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId,
    outcome,
    limitPrice: price,
    originalSize: size,
    remainingSize: size,
    queueAhead: 0,
    status: "open",
    phaseId: "5-2",
    pairId: "ladder-v5:0.10-0.90",
    orderPolicy: "gtc",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function snapshot(
  positions: PaperPosition[] = [],
  fills: PaperFill[] = [],
  openOrders: PaperOrder[] = [],
): MarketExecutionSnapshot {
  return {
    marketSlug: testEvent().slug,
    orders: openOrders,
    openOrders,
    fills,
    positions,
    books: testBooks(0.4, 0.6),
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 2_000,
    totalFees: 0,
    estimatedMakerRebate: 0,
    takerFeeRate: 0.07,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

async function withTracker(
  run: (tracker: LadderTracker, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v5-"));
  try {
    const tracker = new LadderTracker(directory, "ladder-v5-state.json");
    await tracker.init();
    await run(tracker, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ladder_v5 trades only 10/90 and 15/85 during the 5-2 window", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const config = testConfig({
      strategyMode: "ladder_v5",
      paperStatePath: directory,
    });
    const active = await planLadderV5(
      config,
      tracker,
      event,
      testBooks(0.4, 0.6),
      snapshot(),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(
      active.opportunities.map((opportunity) => [
        opportunity.token.outcome,
        opportunity.price,
        opportunity.size,
        opportunity.orderPolicy,
      ]),
      [
        ["Up", 0.1, 10, "gtc"],
        ["Down", 0.9, 10, "gtc"],
        ["Up", 0.15, 6.67, "gtc"],
        ["Down", 0.85, 6.67, "gtc"],
      ],
    );

    const early = await planLadderV5(
      config,
      tracker,
      event,
      testBooks(),
      snapshot(),
      event.windowEnd - 6 * 60,
    );
    assert.deepEqual(early.opportunities, []);
    const late = await planLadderV5(
      config,
      tracker,
      event,
      testBooks(),
      snapshot(),
      event.windowEnd - 2 * 60,
    );
    assert.deepEqual(late.opportunities, []);
  });
});

test("ladder_v5 caps each side's filled-plus-open risk at 70 shares", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const plan = await planLadderV5(
      testConfig({
        strategyMode: "ladder_v5",
        ladderSizeScale: 6,
        paperStatePath: directory,
      }),
      tracker,
      event,
      testBooks(),
      snapshot(),
      event.windowEnd - 4 * 60,
    );
    const totals = new Map<string, number>();
    for (const opportunity of plan.opportunities) {
      totals.set(
        opportunity.token.outcome,
        (totals.get(opportunity.token.outcome) ?? 0) + opportunity.size,
      );
    }
    assert.equal(totals.get("Up"), 70);
    assert.equal(totals.get("Down"), 70);
  });
});

test("opposite open orders never count as a filled hedge", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const upPosition = position("up-token", "Up", 65);
    const upFill = fill("up-token", "Up", 0.1, 65);
    const oppositeOpen = openV5Order(
      "down-token",
      "Down",
      0.85,
      60,
    );
    const plan = await planLadderV5(
      testConfig({
        strategyMode: "ladder_v5",
        paperStatePath: directory,
      }),
      tracker,
      event,
      testBooks(),
      snapshot([upPosition], [upFill], [oppositeOpen]),
      event.windowEnd - 4 * 60,
    );
    assert.ok(
      plan.opportunities.every(
        (opportunity) => opportunity.token.tokenId !== "up-token",
      ),
    );
  });
});

test("deficient-side orders must pass the fee-adjusted 0.98 pair-cost gate", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const plan = await planLadderV5(
      testConfig({
        strategyMode: "ladder_v5",
        paperStatePath: directory,
        ladderV5MaxPairCost: 0.98,
      }),
      tracker,
      event,
      testBooks(),
      snapshot(
        [position("up-token", "Up", 10)],
        [fill("up-token", "Up", 0.1, 10)],
      ),
      event.windowEnd - 4 * 60,
    );
    const downPrices = plan.opportunities
      .filter((opportunity) => opportunity.token.tokenId === "down-token")
      .map((opportunity) => opportunity.price);
    assert.deepEqual(downPrices, [0.85]);
  });
});

test("a resting deficient-side order is cancelled if fills make its pair too expensive", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const expensiveHedge = openV5Order(
      "down-token",
      "Down",
      0.9,
      10,
    );
    const plan = await planLadderV5(
      testConfig({
        strategyMode: "ladder_v5",
        paperStatePath: directory,
        ladderV5MaxPairCost: 0.98,
      }),
      tracker,
      event,
      testBooks(),
      snapshot(
        [position("up-token", "Up", 10)],
        [fill("up-token", "Up", 0.1, 10)],
        [expensiveHedge],
      ),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, [expensiveHedge.id]);
  });
});

test("ladder_v5 cancels its resting orders when the 5-2 window ends", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const order = openV5Order("up-token", "Up", 0.1, 10);
    const plan = await planLadderV5(
      testConfig({
        strategyMode: "ladder_v5",
        paperStatePath: directory,
      }),
      tracker,
      event,
      testBooks(),
      snapshot([], [], [order]),
      event.windowEnd - 90,
    );
    assert.deepEqual(plan.cancelOrderIds, [order.id]);
    assert.deepEqual(plan.opportunities, []);
  });
});
