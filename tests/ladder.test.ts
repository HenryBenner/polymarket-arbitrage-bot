import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findLadderOpportunities,
  ladderPhaseAt,
  LadderTracker,
  minimumShares,
  pairedShares,
  projectedLadderCapital,
} from "../src/ladder.js";
import { testBooks, testConfig, testEvent } from "./helpers.js";

test("scale 1 matches the exact independently minimized table", () => {
  const rows = [
    [0.45, 0.55, 2.23],
    [0.4, 0.6, 2.5],
    [0.35, 0.65, 2.86],
    [0.3, 0.7, 3.34],
    [0.25, 0.75, 4],
    [0.2, 0.8, 5],
    [0.15, 0.85, 6.67],
    [0.1, 0.9, 10],
    [0.05, 0.95, 20],
  ] as const;

  for (const [low, high, expected] of rows) {
    assert.equal(pairedShares(low, high, 0, 0, 1), expected);
  }
  assert.equal(projectedLadderCapital(1), 56.6);
  assert.equal(projectedLadderCapital(2), 113.2);
});

test("minimum sizing rounds upward and honors a larger live minimum", () => {
  assert.equal(minimumShares(0.3), 3.34);
  assert.equal(minimumShares(0.3, 5.001), 5.01);
  assert.equal(pairedShares(0.45, 0.55, 5, 3, 1), 5);
  assert.equal(pairedShares(0.45, 0.55, 5, 3, 3), 15);
});

test("phase boundaries enter the next phase without overlap", () => {
  const event = testEvent();
  const atMinutesLeft = (minutes: number) =>
    ladderPhaseAt(event, event.windowEnd - minutes * 60)?.id;
  assert.equal(atMinutesLeft(15), "15-10");
  assert.equal(atMinutesLeft(10), "10-5");
  assert.equal(atMinutesLeft(5), "5-2");
  assert.equal(atMinutesLeft(2), "2-0");
  assert.equal(atMinutesLeft(0), "2-0");
  assert.equal(atMinutesLeft(15.01), undefined);
  assert.equal(atMinutesLeft(-0.01), undefined);
});

test("late startup submits only the current phase and locks roles until next phase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-phase-"));
  try {
    const tracker = new LadderTracker(directory);
    await tracker.init();
    const event = testEvent();
    const config = testConfig({ paperStatePath: directory });
    const fourMinutesLeft = event.windowEnd - 4 * 60;

    const initial = await findLadderOpportunities(
      config,
      tracker,
      event,
      testBooks(0.35, 0.65),
      fourMinutesLeft,
    );
    assert.equal(initial.length, 6);
    assert.deepEqual(
      [...new Set(initial.map((opportunity) => opportunity.phaseId))],
      ["5-2"],
    );
    assert.ok(
      initial
        .filter((opportunity) => opportunity.kind === "cheap")
        .every((opportunity) => opportunity.token.tokenId === "up-token"),
    );

    const flippedInsidePhase = await findLadderOpportunities(
      config,
      tracker,
      event,
      testBooks(0.8, 0.2),
      fourMinutesLeft - 30,
    );
    assert.ok(
      flippedInsidePhase
        .filter((opportunity) => opportunity.kind === "cheap")
        .every((opportunity) => opportunity.token.tokenId === "up-token"),
    );

    const nextPhase = await findLadderOpportunities(
      config,
      tracker,
      event,
      testBooks(0.8, 0.2),
      event.windowEnd - 60,
    );
    assert.equal(nextPhase.length, 2);
    assert.equal(nextPhase[0]?.phaseId, "2-0");
    assert.equal(nextPhase[0]?.token.tokenId, "down-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("incomplete books do not lock or submit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-book-"));
  try {
    const tracker = new LadderTracker(directory);
    await tracker.init();
    const books = testBooks();
    books[1]!.bestAsk = null;
    books[1]!.asks = [];
    const opportunities = await findLadderOpportunities(
      testConfig({ paperStatePath: directory }),
      tracker,
      testEvent(),
      books,
      testEvent().windowEnd - 12 * 60,
    );
    assert.deepEqual(opportunities, []);
    assert.equal(tracker.getLock(testEvent().slug, "15-10"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted submission keys prevent duplicates after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ladder-restart-"));
  try {
    const event = testEvent();
    const now = event.windowEnd - 12 * 60;
    const config = testConfig({ paperStatePath: directory });
    const firstTracker = new LadderTracker(directory);
    await firstTracker.init();
    const first = await findLadderOpportunities(
      config,
      firstTracker,
      event,
      testBooks(),
      now,
    );
    for (const opportunity of first) {
      await firstTracker.mark(opportunity.tradeKey);
    }

    const restarted = new LadderTracker(directory);
    await restarted.init();
    assert.deepEqual(
      await findLadderOpportunities(config, restarted, event, testBooks(), now),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
