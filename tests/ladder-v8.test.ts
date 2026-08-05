import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ladderV8ScheduledShares,
  planLadderV8,
} from "../src/ladder-v8.js";
import { LadderTracker } from "../src/ladder.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  UpDownEvent,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function eventAt(iso: string): UpDownEvent {
  const start = Date.parse(iso) / 1_000;
  return {
    ...testEvent(),
    slug: `btc-updown-15m-${start}`,
    windowStart: start,
    windowEnd: start + 15 * 60,
    market: {
      ...testEvent().market,
      slug: `btc-updown-15m-${start}`,
    },
  };
}

function order(
  event: UpDownEvent,
  id: string,
  tokenId: string,
  outcome: string,
  price: number,
  status: PaperOrder["status"] = "open",
): PaperOrder {
  return {
    id,
    tradeKey: `ladder-v8:${event.slug}:${outcome}:${price.toFixed(2)}`,
    marketSlug: event.slug,
    marketTitle: event.title,
    conditionId: event.market.conditionId,
    tokenId,
    outcome,
    limitPrice: price,
    originalSize: 120,
    remainingSize: status === "filled" ? 0 : 120,
    queueAhead: 0,
    status,
    phaseId: "15-2",
    pairId: "ladder-v8:0.45-0.55",
    orderPolicy: "post_only",
    createdAt: "2026-08-03T14:00:00.000Z",
  };
}

function fill(orderValue: PaperOrder, size: number): PaperFill {
  return {
    id: `fill-${orderValue.id}`,
    orderId: orderValue.id,
    marketSlug: orderValue.marketSlug,
    tokenId: orderValue.tokenId,
    outcome: orderValue.outcome,
    price: orderValue.limitPrice,
    size,
    fee: 0,
    liquidity: "maker",
    timestamp: "2026-08-03T14:01:00.000Z",
  };
}

function snapshot(
  event: UpDownEvent,
  orders: PaperOrder[] = [],
  fills: PaperFill[] = [],
): MarketExecutionSnapshot {
  const books = testBooks(0.5, 0.6, 5);
  return {
    marketSlug: event.slug,
    orders,
    openOrders: orders.filter(
      (candidate) =>
        candidate.status === "open" || candidate.status === "partial",
    ),
    fills,
    positions: [],
    books,
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 25_000,
    totalFees: 0,
    estimatedMakerRebate: 0,
    takerFeeRate: 0.07,
    makerFeeRate: 0,
    takerFeeExponent: 1,
    settledPnl: null,
  };
}

const v8Config = () =>
  testConfig({
    strategyMode: "ladder_v8",
    ladderMaxUsdcPerMarket: 1_100,
    ladderV8SizeScale: 1,
    ladderV8MaxSharesPerOrder: 120,
    ladderV8MaxUnmatchedShares: 240,
  });

async function withTracker<T>(
  operation: (tracker: LadderTracker, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ladder-v8-"));
  try {
    const tracker = new LadderTracker(directory);
    await tracker.init();
    return await operation(tracker, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ladder_v8 reproduces Odahoa's ET share tiers", () => {
  assert.equal(
    ladderV8ScheduledShares(eventAt("2026-08-03T04:00:00Z")),
    5,
  );
  assert.equal(
    ladderV8ScheduledShares(eventAt("2026-08-03T10:00:00Z")),
    16,
  );
  assert.equal(
    ladderV8ScheduledShares(eventAt("2026-08-03T13:00:00Z")),
    120,
  );
  assert.equal(
    ladderV8ScheduledShares(eventAt("2026-08-03T19:00:00Z")),
    32,
  );
  assert.equal(
    ladderV8ScheduledShares(eventAt("2026-08-03T22:00:00Z")),
    8,
  );
  assert.equal(
    ladderV8ScheduledShares(
      eventAt("2026-08-03T14:00:00Z"),
      0.5,
      40,
    ),
    40,
  );
});

test("ladder_v8 submits complementary one-shot post-only maker legs", async () => {
  const event = eventAt("2026-08-03T14:00:00Z");
  const books = testBooks(0.5, 0.6, 5);
  await withTracker(async (tracker) => {
    const first = await planLadderV8(
      v8Config(),
      tracker,
      event,
      books,
      snapshot(event),
      event.windowStart + 60,
    );
    assert.deepEqual(
      first.opportunities.map((opportunity) => ({
        outcome: opportunity.token.outcome,
        price: opportunity.price,
        size: opportunity.size,
        policy: opportunity.orderPolicy,
      })),
      [{ outcome: "Up", price: 0.45, size: 120, policy: "post_only" }],
    );

    const cheap = order(event, "cheap", "up-token", "Up", 0.45);
    const second = await planLadderV8(
      v8Config(),
      tracker,
      event,
      books,
      snapshot(event, [cheap]),
      event.windowStart + 60,
    );
    assert.deepEqual(
      second.opportunities.map((opportunity) => ({
        outcome: opportunity.token.outcome,
        price: opportunity.price,
        size: opportunity.size,
        policy: opportunity.orderPolicy,
      })),
      [{ outcome: "Down", price: 0.55, size: 120, policy: "post_only" }],
    );
  });
});

test("ladder_v8 cancels only exposure-increasing orders at two minutes", async () => {
  const event = eventAt("2026-08-03T14:00:00Z");
  const tracker = new LadderTracker("unused");
  const filled = order(
    event,
    "filled-up",
    "up-token",
    "Up",
    0.45,
    "filled",
  );
  const openUp = order(event, "open-up", "up-token", "Up", 0.4);
  const openDown = order(
    event,
    "open-down",
    "down-token",
    "Down",
    0.55,
  );
  const plan = await planLadderV8(
    v8Config(),
    tracker,
    event,
    testBooks(0.5, 0.6, 5),
    snapshot(event, [filled, openUp, openDown], [fill(filled, 120)]),
    event.windowEnd - 60,
  );
  assert.deepEqual(plan.cancelOrderIds, ["open-up"]);
  assert.deepEqual(plan.opportunities, []);
  assert.equal(plan.unmatchedShares, 120);
});

test("ladder_v8 reacts to its unmatched-share guard", async () => {
  const event = eventAt("2026-08-03T14:00:00Z");
  const filled = order(
    event,
    "filled-up",
    "up-token",
    "Up",
    0.45,
    "filled",
  );
  const openUp = order(event, "open-up", "up-token", "Up", 0.4);
  const openDown = order(
    event,
    "open-down",
    "down-token",
    "Down",
    0.55,
  );
  await withTracker(async (tracker) => {
    const plan = await planLadderV8(
      v8Config(),
      tracker,
      event,
      testBooks(0.5, 0.6, 5),
      snapshot(event, [filled, openUp, openDown], [fill(filled, 240)]),
      event.windowStart + 5 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, ["open-up"]);
    assert.equal(plan.unmatchedShares, 240);
  });
});

test("ladder_v8 permanently flip-locks instead of rebuilding the stack", async () => {
  const event = eventAt("2026-08-03T14:00:00Z");
  await withTracker(async (tracker, directory) => {
    const initialBooks = testBooks(0.5, 0.6, 5);
    await planLadderV8(
      v8Config(),
      tracker,
      event,
      initialBooks,
      snapshot(event),
      event.windowStart + 60,
    );

    const filledDown = order(
      event,
      "filled-down",
      "down-token",
      "Down",
      0.55,
      "filled",
    );
    const openUp = order(event, "open-up", "up-token", "Up", 0.45);
    const openDown = order(
      event,
      "open-down",
      "down-token",
      "Down",
      0.6,
    );
    const flippedBooks = testBooks(0.65, 0.35, 5);
    const flippedSnapshot = snapshot(
      event,
      [filledDown, openUp, openDown],
      [fill(filledDown, 120)],
    );
    flippedSnapshot.books = flippedBooks;

    const flipped = await planLadderV8(
      v8Config(),
      tracker,
      event,
      flippedBooks,
      flippedSnapshot,
      event.windowStart + 5 * 60,
    );
    assert.equal(flipped.flipLocked, true);
    assert.deepEqual(flipped.cancelOrderIds, ["open-up", "open-down"]);
    assert.deepEqual(flipped.opportunities, []);
    assert.equal(tracker.isExposureBlocked(event.slug), true);

    const afterCancellation = snapshot(
      event,
      [
        filledDown,
        { ...openUp, status: "cancelled" },
        { ...openDown, status: "cancelled" },
      ],
      [fill(filledDown, 120)],
    );
    afterCancellation.books = flippedBooks;
    const completion = await planLadderV8(
      v8Config(),
      tracker,
      event,
      flippedBooks,
      afterCancellation,
      event.windowStart + 5 * 60,
    );
    assert.deepEqual(
      completion.opportunities.map((opportunity) => ({
        outcome: opportunity.token.outcome,
        price: opportunity.price,
        size: opportunity.size,
        pairId: opportunity.pairId,
      })),
      [
        {
          outcome: "Up",
          price: 0.44,
          size: 120,
          pairId: "ladder-v8:flip-completion",
        },
      ],
    );

    const restarted = new LadderTracker(directory);
    await restarted.init();
    assert.equal(restarted.isExposureBlocked(event.slug), true);
    const stillLocked = await planLadderV8(
      v8Config(),
      restarted,
      event,
      flippedBooks,
      afterCancellation,
      event.windowStart + 5 * 60,
    );
    assert.equal(stillLocked.flipLocked, true);
    assert.equal(stillLocked.opportunities.length, 1);
    assert.equal(stillLocked.opportunities[0]?.pairId, "ladder-v8:flip-completion");
  });
});
