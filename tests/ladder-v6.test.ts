import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planLadderV6 } from "../src/ladder-v6.js";
import { LadderTracker } from "../src/ladder.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  PaperOrder,
  TokenBook,
} from "../src/types.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

function openingOrder(
  id: string,
  price: number,
  size = 20,
  status: PaperOrder["status"] = "open",
): PaperOrder {
  return {
    id,
    tradeKey: `ladder-v6:opening:${price}`,
    marketSlug: testEvent().slug,
    marketTitle: testEvent().title,
    conditionId: testEvent().market.conditionId,
    tokenId: "up-token",
    outcome: "Up",
    limitPrice: price,
    originalSize: size,
    remainingSize: status === "filled" ? 0 : size,
    queueAhead: 0,
    status,
    phaseId: "5-2",
    pairId: `ladder-v6:opening:${price.toFixed(2)}`,
    orderPolicy: "post_only",
    pairLockRole: "opening",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function hedgeOrder(
  id: string,
  price: number,
  size: number,
): PaperOrder {
  return {
    ...openingOrder(id, price, size, "filled"),
    tradeKey: id,
    tokenId: "down-token",
    outcome: "Down",
    pairId: "ladder-v6:hedge:completion",
    orderPolicy: "fok",
    pairLockRole: "completion_taker",
  };
}

function fill(
  id: string,
  order: PaperOrder,
  price = order.limitPrice,
  size = order.originalSize,
  liquidity: PaperFill["liquidity"] = "maker",
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
    liquidity,
    timestamp: "2026-01-01T00:00:00.000Z",
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
      (order) => order.status === "open" || order.status === "partial",
    ),
    fills,
    positions: [],
    books,
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
  const directory = await mkdtemp(join(tmpdir(), "ladder-v6-"));
  try {
    const tracker = new LadderTracker(directory, "ladder-v6-state.json");
    await tracker.init();
    await run(tracker, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ladder_v6 posts only two cheap maker orders with 40 total shares", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const plan = await planLadderV6(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(testBooks(0.4, 0.6)),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(
      plan.opportunities.map((opportunity) => [
        opportunity.token.outcome,
        opportunity.price,
        opportunity.size,
        opportunity.orderPolicy,
      ]),
      [
        ["Up", 0.1, 20, "post_only"],
        ["Up", 0.15, 20, "post_only"],
      ],
    );
    assert.equal(
      plan.opportunities.reduce(
        (sum, opportunity) => sum + opportunity.size,
        0,
      ),
      40,
    );
  });
});

test("first cheap fill cancels openings and creates an exact profitable FOK hedge", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = openingOrder("cheap-10", 0.1, 20, "filled");
    const other = openingOrder("cheap-15", 0.15);
    const books = testBooks(0.4, 0.88);
    books[1]!.asks = [{ price: 0.88, size: 20 }];
    const plan = await planLadderV6(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
        ladderV6MinNetEdge: 0.01,
      }),
      tracker,
      event,
      snapshot(books, [cheap, other], [fill("cheap-fill", cheap)]),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, [other.id]);
    const hedge = plan.opportunities[0]!;
    assert.equal(hedge.token.outcome, "Down");
    assert.equal(hedge.orderPolicy, "fok");
    assert.equal(hedge.size, 20);
    assert.equal(hedge.price, 0.88);
    assert.ok((plan.plannedNetEdgePerPair ?? 0) >= 0.01);
  });
});

test("V6 waits when depth is incomplete or the one-cent edge is unavailable", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = openingOrder("cheap", 0.1, 20, "filled");
    const cheapFill = fill("cheap-fill", cheap);
    const config = testConfig({
      strategyMode: "ladder_v6",
      paperStatePath: directory,
      ladderV6MinNetEdge: 0.01,
    });

    const shallow = testBooks(0.4, 0.88);
    shallow[1]!.asks = [{ price: 0.88, size: 19.99 }];
    const noDepth = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(shallow, [cheap], [cheapFill]),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(noDepth.opportunities, []);

    const expensive = testBooks(0.4, 0.89);
    expensive[1]!.asks = [{ price: 0.89, size: 20 }];
    const noEdge = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(expensive, [cheap], [cheapFill]),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(noEdge.opportunities, []);
  });
});

test("V6 retries a failed FOK only after relevant depth changes", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = openingOrder("cheap", 0.1, 20, "filled");
    const cheapFill = fill("cheap-fill", cheap);
    const books = testBooks(0.4, 0.88);
    books[1]!.asks = [{ price: 0.88, size: 20 }];
    const config = testConfig({
      strategyMode: "ladder_v6",
      paperStatePath: directory,
    });
    const first = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(books, [cheap], [cheapFill]),
      event.windowEnd - 4 * 60,
    );
    const failed: PaperOrder = {
      ...hedgeOrder(
        first.opportunities[0]!.tradeKey,
        0.88,
        20,
      ),
      id: "failed-fok",
      tradeKey: first.opportunities[0]!.tradeKey,
      status: "cancelled",
      remainingSize: 20,
    };
    const unchanged = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(books, [cheap, failed], [cheapFill]),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(unchanged.opportunities, []);

    const changedBooks = structuredClone(books);
    changedBooks[1]!.asks = [
      { price: 0.87, size: 10 },
      { price: 0.88, size: 10 },
    ];
    const changed = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(changedBooks, [cheap, failed], [cheapFill]),
      event.windowEnd - 4 * 60,
    );
    assert.equal(changed.opportunities.length, 1);
    assert.notEqual(
      changed.opportunities[0]?.tradeKey,
      first.opportunities[0]?.tradeKey,
    );
  });
});

test("V6 never reopens cheap exposure and cancels everything at two minutes", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = openingOrder("cheap", 0.1, 20, "filled");
    const hedge = hedgeOrder("hedge", 0.8, 20);
    const completed = await planLadderV6(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(
        testBooks(),
        [cheap, hedge],
        [fill("cheap-fill", cheap), fill("hedge-fill", hedge, 0.8, 20, "taker")],
      ),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(completed.opportunities, []);
    assert.equal(completed.unmatchedCheapShares, 0);

    const open = openingOrder("still-open", 0.15);
    const cutoff = await planLadderV6(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(testBooks(), [open]),
      event.windowEnd - 2 * 60,
    );
    assert.deepEqual(cutoff.cancelOrderIds, [open.id]);
    assert.deepEqual(cutoff.opportunities, []);
  });
});
