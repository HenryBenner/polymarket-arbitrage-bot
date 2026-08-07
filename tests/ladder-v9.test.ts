import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LadderTracker } from "../src/ladder.js";
import { planLadderV9 } from "../src/ladder-v9.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  TokenBook,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function order(
  role: string,
  tokenId: string,
  outcome: string,
  price: number,
  size: number,
  status: PaperOrder["status"],
  createdAt: string,
  policy: PaperOrder["orderPolicy"] = "fak",
): PaperOrder {
  const filled = status === "filled" ? size : 0;
  return {
    id: `v9-${role}`,
    tradeKey: `ladder-v9:${testEvent().slug}:5-2:${role}`,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId,
    outcome,
    limitPrice: price,
    originalSize: size,
    remainingSize: status === "partial" ? size / 2 : size - filled,
    queueAhead: 0,
    status,
    side: "BUY",
    phaseId: "5-2",
    pairId: `ladder-v9:${role}`,
    orderPolicy: policy,
    createdAt,
  };
}

function fill(
  orderValue: PaperOrder,
  size: number,
  price = orderValue.limitPrice,
  fee = 0,
  timestamp = orderValue.createdAt,
): PaperFill {
  return {
    id: `fill-${orderValue.id}-${size}`,
    orderId: orderValue.id,
    marketSlug: orderValue.marketSlug,
    tokenId: orderValue.tokenId,
    outcome: orderValue.outcome,
    price,
    size,
    fee,
    liquidity: orderValue.orderPolicy === "post_only" ? "maker" : "taker",
    side: "BUY",
    timestamp,
  };
}

function snapshot(
  books: TokenBook[],
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
    books,
    capitalUsed: 0,
    openCommitted: 0,
    capitalCommitted: 0,
    availableCash: 2_000,
    totalFees: fills.reduce((sum, item) => sum + item.fee, 0),
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
  const directory = await mkdtemp(join(tmpdir(), "ladder-v9-"));
  try {
    const tracker = new LadderTracker(directory, "ladder-v9-state.json");
    await tracker.init();
    await run(tracker, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ladder_v9 requires a confirmed cheap order before the initial favorite", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const now = event.windowEnd - 4 * 60;
    const books = testBooks(0.4, 0.6);
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v9",
      paperStatePath: directory,
    });
    const first = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books),
      now,
    );
    assert.deepEqual(
      first.opportunities.map((item) => ({
        role: item.pairId,
        size: item.size,
        price: item.price,
        policy: item.orderPolicy,
      })),
      [{
        role: "ladder-v9:cheap-entry",
        size: 40,
        price: 0.1,
        policy: "post_only",
      }],
    );

    const createdAt = new Date(now * 1_000).toISOString();
    const cheapOpen = order(
      "cheap-entry",
      "up-token",
      "Up",
      0.1,
      40,
      "open",
      createdAt,
      "post_only",
    );
    const second = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheapOpen]),
      now,
    );
    assert.equal(second.opportunities[0]?.pairId, "ladder-v9:favorite-initial");
    assert.equal(second.opportunities[0]?.size, 20);
    assert.equal(second.opportunities[0]?.price, 0.8);
    assert.equal(second.opportunities[0]?.orderPolicy, "fak");

    const cheapCancelled = { ...cheapOpen, status: "cancelled" as const };
    const rejected = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheapCancelled]),
      now,
    );
    assert.deepEqual(rejected.opportunities, []);
  });
});

test("ladder_v9 crosses a cheap ask at ten cents with FAK before any favorite", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.08, 0.92);
    const plan = await planLadderV9(
      testConfig({
        exchange: "kalshi",
        strategyMode: "ladder_v9",
        paperStatePath: directory,
      }),
      tracker,
      event,
      books,
      snapshot(books),
      event.windowEnd - 4 * 60,
    );
    assert.equal(plan.opportunities.length, 1);
    assert.equal(plan.opportunities[0]?.pairId, "ladder-v9:cheap-entry");
    assert.equal(plan.opportunities[0]?.orderPolicy, "fak");
    assert.equal(plan.opportunities[0]?.size, 40);
  });
});

test("ladder_v9 tops up cheap fills with fee-aware favorite retries and cooldown", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const now = event.windowEnd - 3 * 60;
    const createdAt = new Date((now - 10) * 1_000).toISOString();
    const books = testBooks(0.4, 0.6);
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v9",
      paperStatePath: directory,
    });
    const cheap = order(
      "cheap-entry",
      "up-token",
      "Up",
      0.1,
      40,
      "filled",
      createdAt,
      "post_only",
    );
    const favorite = order(
      "favorite-initial",
      "down-token",
      "Down",
      0.8,
      20,
      "filled",
      createdAt,
    );
    const initial = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheap, favorite], [fill(cheap, 40), fill(favorite, 20)]),
      now,
    );
    assert.equal(initial.opportunities[0]?.pairId, "ladder-v9:favorite-completion-1");
    assert.equal(initial.opportunities[0]?.size, 20);
    assert.equal(initial.opportunities[0]?.price, 0.86);

    const attempt = order(
      "favorite-completion-1",
      "down-token",
      "Down",
      0.86,
      20,
      "cancelled",
      new Date(now * 1_000).toISOString(),
    );
    const duringCooldown = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(
        books,
        [cheap, favorite, attempt],
        [fill(cheap, 40), fill(favorite, 20)],
      ),
      now + 0.2,
    );
    assert.deepEqual(duringCooldown.opportunities, []);
    const retry = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(
        books,
        [cheap, favorite, attempt],
        [fill(cheap, 40), fill(favorite, 20)],
      ),
      now + 0.36,
    );
    assert.equal(retry.opportunities[0]?.pairId, "ladder-v9:favorite-completion-2");
  });
});

test("ladder_v9 stages cheap rescue amendments at twelve and fifteen cents", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.4, 0.6);
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v9",
      paperStatePath: directory,
    });
    const favoriteFillAt = event.windowEnd - 220;
    const cheap = order(
      "cheap-entry",
      "up-token",
      "Up",
      0.1,
      40,
      "open",
      new Date((favoriteFillAt - 10) * 1_000).toISOString(),
      "post_only",
    );
    const favorite = order(
      "favorite-initial",
      "down-token",
      "Down",
      0.8,
      20,
      "filled",
      new Date(favoriteFillAt * 1_000).toISOString(),
    );
    const fills = [fill(favorite, 20, 0.8, 0, new Date(favoriteFillAt * 1_000).toISOString())];
    const twelve = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheap, favorite], fills),
      event.windowEnd - 100,
    );
    assert.equal(twelve.managementStage, "rescue-12");
    assert.equal(twelve.amendments[0]?.opportunity.price, 0.12);
    assert.equal(twelve.amendments[0]?.opportunity.size, 20);

    const fifteen = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheap, favorite], fills),
      event.windowEnd - 80,
    );
    assert.equal(fifteen.managementStage, "rescue-15");
    assert.equal(fifteen.amendments[0]?.opportunity.price, 0.15);
  });
});

test("ladder_v9 uses emergency pair limits then flattens an uncompletable residual", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.4, 0.9);
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v9",
      paperStatePath: directory,
    });
    const createdAt = new Date((event.windowEnd - 240) * 1_000).toISOString();
    const cheap = order(
      "cheap-entry",
      "up-token",
      "Up",
      0.1,
      40,
      "filled",
      createdAt,
      "post_only",
    );
    const plan = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheap], [fill(cheap, 40)]),
      event.windowEnd - 15,
    );
    assert.equal(plan.maximumCompletionPrice, 0.91);
    assert.equal(plan.opportunities.length, 0);
    assert.equal(plan.flattenOpportunities[0]?.pairId, "ladder-v9:flatten-cheap-1");
    assert.equal(plan.flattenOpportunities[0]?.price, 0.39);
    assert.equal(plan.flattenOpportunities[0]?.size, 40);
  });
});

test("ladder_v9 holds an underwater unmatched favorite through settlement", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.4, 0.6);
    books[1]!.bestBid = 0.22;
    books[1]!.bids = [{ price: 0.22, size: 40 }];
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v9",
      paperStatePath: directory,
    });
    const createdAt = new Date((event.windowEnd - 240) * 1_000).toISOString();
    const cheap = order(
      "cheap-entry",
      "up-token",
      "Up",
      0.1,
      40,
      "cancelled",
      createdAt,
      "post_only",
    );
    const favorite = order(
      "favorite-initial",
      "down-token",
      "Down",
      0.8,
      20,
      "filled",
      createdAt,
    );
    const plan = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheap, favorite], [fill(favorite, 20, 0.8, 0.224)]),
      event.windowEnd - 15,
    );
    assert.equal(plan.managementStage, "hold-favorite");
    assert.deepEqual(plan.flattenOpportunities, []);
    assert.ok(
      plan.opportunities.every(
        (item) => !item.pairId?.startsWith("ladder-v9:flatten-favorite-"),
      ),
    );
  });
});

test("ladder_v9 sells an unmatched favorite only at an after-fee profit", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.4, 0.6);
    books[1]!.bestBid = 0.85;
    books[1]!.bids = [{ price: 0.85, size: 40 }];
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v9",
      paperStatePath: directory,
    });
    const createdAt = new Date((event.windowEnd - 240) * 1_000).toISOString();
    const cheap = order(
      "cheap-entry",
      "up-token",
      "Up",
      0.1,
      40,
      "cancelled",
      createdAt,
      "post_only",
    );
    const favorite = order(
      "favorite-initial",
      "down-token",
      "Down",
      0.8,
      20,
      "filled",
      createdAt,
    );
    const plan = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheap, favorite], [fill(favorite, 20, 0.8, 0.224)]),
      event.windowEnd - 15,
    );
    assert.equal(plan.managementStage, "favorite-profit-exit");
    assert.equal(
      plan.flattenOpportunities[0]?.pairId,
      "ladder-v9:favorite-profit-exit-1",
    );
    assert.equal(plan.flattenOpportunities[0]?.price, 0.85);
    assert.equal(plan.flattenOpportunities[0]?.size, 20);
  });
});

test("ladder_v9 cancels an empty initial market at two minutes but keeps managing exposure", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.4, 0.6);
    const config = testConfig({
      exchange: "kalshi",
      strategyMode: "ladder_v9",
      paperStatePath: directory,
    });
    const createdAt = new Date((event.windowEnd - 240) * 1_000).toISOString();
    const cheap = order(
      "cheap-entry",
      "up-token",
      "Up",
      0.1,
      40,
      "open",
      createdAt,
      "post_only",
    );
    const empty = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [cheap]),
      event.windowEnd - 120,
    );
    assert.deepEqual(empty.cancelOrderIds, [cheap.id]);

    const filledCheap = { ...cheap, status: "filled" as const, remainingSize: 0 };
    const exposed = await planLadderV9(
      config,
      tracker,
      event,
      books,
      snapshot(books, [filledCheap], [fill(filledCheap, 40)]),
      event.windowEnd - 119,
    );
    assert.equal(exposed.opportunities[0]?.pairId, "ladder-v9:favorite-completion-1");
  });
});
