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

test("ladder_v6 posts competitive two-sided maker quotes under the pair cap", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.4, 0.6);
    const config = testConfig({
      strategyMode: "ladder_v6",
      paperStatePath: directory,
    });
    const first = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(books),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(
      first.opportunities.map((opportunity) => [
        opportunity.token.outcome,
        opportunity.price,
        opportunity.size,
        opportunity.orderPolicy,
      ]),
      [["Up", 0.39, 40, "post_only"]],
    );

    const up = openingOrder("up-opening", 0.39, 40);
    const second = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(books, [up]),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(
      second.opportunities.map((opportunity) => [
        opportunity.token.outcome,
        opportunity.price,
        opportunity.size,
        opportunity.orderPolicy,
      ]),
      [["Down", 0.59, 40, "post_only"]],
    );
    assert.equal(second.plannedAllInPairCost, 0.98);
    assert.ok((second.plannedNetEdgePerPair ?? 0) >= 0.02);
    assert.equal(
      second.opportunities[0]?.referenceTokenId,
      "up-token",
    );
  });
});

test("V6 refuses opening quotes when competitive bids exceed the pair cap", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const books = testBooks(0.4, 0.6);
    books[0]!.bestBid = 0.4;
    books[1]!.bestBid = 0.59;
    const cancel = await planLadderV6(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(books),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(cancel.opportunities, []);
  });
});

test("opening fill cancels the quote and creates an exact profitable FOK hedge", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const cheap = openingOrder("cheap-10", 0.1, 20, "filled");
    const other = openingOrder("cheap-15", 0.15);
    const books = testBooks(0.4, 0.88);
    books[1]!.asks = [{ price: 0.88, size: 20 }];
    const cancel = await planLadderV6(
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
    assert.deepEqual(cancel.cancelOrderIds, [other.id]);
    assert.deepEqual(cancel.opportunities, []);

    other.status = "cancelled";
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
    const hedge = plan.opportunities[0]!;
    assert.equal(hedge.token.outcome, "Down");
    assert.equal(hedge.orderPolicy, "fok");
    assert.equal(hedge.size, 20);
    assert.equal(hedge.price, 0.88);
    assert.ok((plan.plannedNetEdgePerPair ?? 0) >= 0.01);
  });
});

test("V6 cancels and replaces stale opening quotes", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const stale = openingOrder("stale", 0.2, 40);
    const books = testBooks(0.4, 0.72);
    books[0]!.asks[0]!.size = 40;
    books[1]!.asks[0]!.size = 40;
    const config = testConfig({
      strategyMode: "ladder_v6",
      paperStatePath: directory,
    });

    const cancel = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(books, [stale]),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(cancel.cancelOrderIds, [stale.id]);
    assert.equal(cancel.plannedAllInPairCost, 0.98);

    stale.status = "cancelled";
    const replace = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(books, [stale]),
      event.windowEnd - 4 * 60,
    );
    assert.equal(replace.opportunities.length, 1);
    assert.equal(replace.opportunities[0]?.price, 0.39);
    assert.equal(replace.opportunities[0]?.size, 40);
  });
});

test("V6 posts the highest profitable maker completion when FOK is unavailable", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const opening = openingOrder("opening", 0.1, 20, "filled");
    const books = testBooks(0.4, 0.95);
    books[1]!.asks = [{ price: 0.95, size: 20 }];
    const plan = await planLadderV6(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(books, [opening], [fill("opening-fill", opening)]),
      event.windowEnd - 4 * 60,
    );
    assert.equal(plan.opportunities.length, 1);
    assert.equal(plan.opportunities[0]?.token.outcome, "Down");
    assert.equal(plan.opportunities[0]?.orderPolicy, "post_only");
    assert.equal(plan.opportunities[0]?.pairLockRole, "completion_maker");
    assert.equal(plan.opportunities[0]?.price, 0.89);
  });
});

test("V6 preserves an already-correct opposite quote after the first fill", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const opening = openingOrder("up-opening", 0.39, 40, "filled");
    const counterpart = openingOrder("down-opening", 0.59, 40);
    counterpart.tokenId = "down-token";
    counterpart.outcome = "Down";
    const plan = await planLadderV6(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
      }),
      tracker,
      event,
      snapshot(
        testBooks(0.4, 0.6),
        [opening, counterpart],
        [fill("up-fill", opening)],
      ),
      event.windowEnd - 4 * 60,
    );
    assert.deepEqual(plan.cancelOrderIds, []);
    assert.deepEqual(plan.opportunities, []);
    assert.equal(plan.plannedOpeningBid, 0.59);
    assert.equal(plan.plannedAllInPairCost, 0.98);
  });
});

test("V6 caps an unmatched leg with a small-loss FOK rescue at two minutes", async () => {
  await withTracker(async (tracker, directory) => {
    const event = testEvent();
    const opening = openingOrder("opening", 0.1, 20, "filled");
    const books = testBooks(0.4, 0.91);
    books[1]!.asks = [{ price: 0.91, size: 20 }];
    const plan = await planLadderV6(
      testConfig({
        strategyMode: "ladder_v6",
        paperStatePath: directory,
        ladderV6MaxRescueLoss: 0.02,
      }),
      tracker,
      event,
      snapshot(books, [opening], [fill("opening-fill", opening)]),
      event.windowEnd - 1.9 * 60,
    );
    assert.equal(plan.opportunities.length, 1);
    assert.equal(plan.opportunities[0]?.orderPolicy, "fok");
    assert.ok((plan.plannedNetEdgePerPair ?? 0) < 0);
    assert.ok((plan.plannedNetEdgePerPair ?? -1) >= -0.02);
  });
});

test("V6 falls back to maker completion when profitable FOK depth is unavailable", async () => {
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
    assert.equal(noDepth.opportunities[0]?.orderPolicy, "post_only");
    assert.equal(
      noDepth.opportunities[0]?.pairLockRole,
      "completion_maker",
    );

    const expensive = testBooks(0.4, 0.89);
    expensive[1]!.asks = [{ price: 0.89, size: 20 }];
    const noEdge = await planLadderV6(
      config,
      tracker,
      event,
      snapshot(expensive, [cheap], [cheapFill]),
      event.windowEnd - 4 * 60,
    );
    assert.equal(noEdge.opportunities[0]?.orderPolicy, "post_only");
    assert.equal(
      noEdge.opportunities[0]?.pairLockRole,
      "completion_maker",
    );
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
    assert.equal(unchanged.opportunities[0]?.orderPolicy, "post_only");
    assert.equal(
      unchanged.opportunities[0]?.pairLockRole,
      "completion_maker",
    );

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
