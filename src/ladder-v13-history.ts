import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LadderV13BayesianModel,
  ladderV13Center,
  type LadderV13BayesianBucket,
  type LadderV13MarketFeatures,
  type LadderV13Plan,
  type LadderV13QuoteContext,
} from "./ladder-v13.js";
import type { MarketExecutionSnapshot, UpDownEvent } from "./types.js";

const EPSILON = 1e-8;

interface ActiveAttempt {
  context: LadderV13QuoteContext;
  baselineYes: number;
  baselineNo: number;
  startedAtMs: number;
}

interface HistoryState {
  version: 1;
  model: Record<string, LadderV13BayesianBucket>;
  active: Record<string, ActiveAttempt>;
}

function strategyShares(snapshot: MarketExecutionSnapshot): [number, number] {
  const books = [...snapshot.books].sort((left, right) => left.outcomeIndex - right.outcomeIndex);
  const ids = new Set(
    snapshot.orders
      .filter((order) => order.pairId?.startsWith("ladder-v13:"))
      .map((order) => order.id),
  );
  const totals = books.slice(0, 2).map((book) =>
    snapshot.fills
      .filter(
        (fill) =>
          ids.has(fill.orderId) &&
          fill.tokenId === book.tokenId &&
          (fill.side ?? "BUY") === "BUY",
      )
      .reduce((sum, fill) => sum + fill.size, 0),
  );
  return [totals[0] ?? 0, totals[1] ?? 0];
}

function realizedUnwindLoss(
  snapshot: MarketExecutionSnapshot,
  attempt: ActiveAttempt,
  tokenIndex: 0 | 1,
): number | undefined {
  const books = [...snapshot.books].sort((left, right) => left.outcomeIndex - right.outcomeIndex);
  const tokenId = books[tokenIndex]?.tokenId;
  if (!tokenId) return undefined;
  const attemptOrderIds = new Set(
    snapshot.orders
      .filter(
        (order) =>
          order.pairId?.startsWith("ladder-v13:") &&
          Date.parse(order.createdAt) + 1_000 >= attempt.startedAtMs,
      )
      .map((order) => order.id),
  );
  const fills = snapshot.fills.filter(
    (fill) => attemptOrderIds.has(fill.orderId) && fill.tokenId === tokenId,
  );
  const buys = fills.filter((fill) => (fill.side ?? "BUY") === "BUY");
  const sells = fills.filter((fill) => fill.side === "SELL");
  const bought = buys.reduce((sum, fill) => sum + fill.size, 0);
  const sold = sells.reduce((sum, fill) => sum + fill.size, 0);
  const unwound = Math.min(bought, sold);
  if (unwound <= EPSILON) return undefined;
  const buyAllIn = buys.reduce(
    (sum, fill) => sum + fill.price * fill.size + fill.fee,
    0,
  ) / bought;
  const sellNet = sells.reduce(
    (sum, fill) => sum + fill.price * fill.size - fill.fee,
    0,
  ) / sold;
  return Math.max(0, buyAllIn - sellNet);
}

/** Persists learned fill outcomes without storing any BTC-direction signal. */
export class LadderV13HistoryStore {
  readonly model: LadderV13BayesianModel;
  private readonly path: string;
  private readonly active = new Map<string, ActiveAttempt>();
  private persistence: Promise<void> = Promise.resolve();
  private readonly telemetry = new Map<
    string,
    Array<{ atMs: number; center: number; bidSize: number; askSize: number }>
  >();

  private constructor(path: string, state: HistoryState) {
    this.path = path;
    this.model = new LadderV13BayesianModel(state.model);
    for (const [slug, attempt] of Object.entries(state.active)) {
      this.active.set(slug, attempt);
    }
  }

  static async load(directory: string): Promise<LadderV13HistoryStore> {
    const path = join(directory, "ladder-v13-history.json");
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as HistoryState;
      if (parsed.version !== 1) throw new Error(`Unsupported V13 history version: ${parsed.version}`);
      return new LadderV13HistoryStore(path, {
        version: 1,
        model: parsed.model ?? {},
        active: parsed.active ?? {},
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code !== "ENOENT") throw error;
      return new LadderV13HistoryStore(path, { version: 1, model: {}, active: {} });
    }
  }

  marketFeatures(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowMs = Date.now(),
  ): LadderV13MarketFeatures {
    const books = [...snapshot.books].sort((left, right) => left.outcomeIndex - right.outcomeIndex);
    const yes = books[0];
    const no = books[1];
    if (!yes || !no) return { volatility: 0, orderFlow: 0 };
    const center = ladderV13Center(yes, no);
    if (center === null) return { volatility: 0, orderFlow: 0 };
    const samples = this.telemetry.get(event.slug) ?? [];
    samples.push({
      atMs: nowMs,
      center,
      bidSize: yes.bids[0]?.size ?? 0,
      askSize: yes.asks[0]?.size ?? 0,
    });
    const cutoff = nowMs - 60_000;
    while (samples[0] && samples[0].atMs < cutoff) samples.shift();
    this.telemetry.set(event.slug, samples);
    const returns: number[] = [];
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!.center;
      const current = samples[index]!.center;
      if (previous > EPSILON) returns.push((current - previous) / previous);
    }
    const volatility = returns.length === 0
      ? 0
      : Math.sqrt(returns.reduce((sum, value) => sum + value * value, 0) / returns.length);
    const first = samples[0]!;
    const latest = samples[samples.length - 1]!;
    const flowNumerator =
      (latest.bidSize - first.bidSize) - (latest.askSize - first.askSize);
    const flowDenominator = Math.max(
      1,
      first.bidSize + first.askSize + latest.bidSize + latest.askSize,
    );
    return {
      volatility,
      orderFlow: Math.max(-1, Math.min(1, flowNumerator / flowDenominator)),
    };
  }

  async observe(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    plan: LadderV13Plan,
    nowMs = Date.now(),
  ): Promise<void> {
    const slug = event.slug;
    const shares = strategyShares(snapshot);
    const current = this.active.get(slug);
    const openingStillActive = snapshot.openOrders.some(
      (order) => order.pairId?.startsWith("ladder-v13:opening"),
    );
    if (current) {
      const yesDelta = Math.max(0, shares[0] - current.baselineYes);
      const noDelta = Math.max(0, shares[1] - current.baselineNo);
      const completedPairCycle =
        yesDelta > EPSILON && noDelta > EPSILON && !openingStillActive;
      if (completedPairCycle || event.windowEnd * 1_000 <= nowMs) {
        const outcome = yesDelta > EPSILON && noDelta > EPSILON
          ? "both"
          : yesDelta > EPSILON
            ? "yesOnly"
            : noDelta > EPSILON
              ? "noOnly"
              : "neither";
        this.model.observe({
          context: current.context,
          outcome,
          unwindLoss: outcome === "yesOnly"
            ? realizedUnwindLoss(snapshot, current, 0)
            : outcome === "noOnly"
              ? realizedUnwindLoss(snapshot, current, 1)
              : undefined,
          secondsToPair: outcome === "both"
            ? Math.max(1, (nowMs - current.startedAtMs) / 1_000)
            : undefined,
        });
        this.active.delete(slug);
        await this.persist();
      }
    }
    if (
      !this.active.has(slug) &&
      plan.selectedCandidate &&
      plan.opportunities[0]?.pairId?.startsWith("ladder-v13:opening")
    ) {
      this.active.set(slug, {
        context: plan.selectedCandidate.context,
        baselineYes: shares[0],
        baselineNo: shares[1],
        startedAtMs: nowMs,
      });
      await this.persist();
    }
  }

  async finalize(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowMs = Date.now(),
  ): Promise<void> {
    const attempt = this.active.get(event.slug);
    if (!attempt) return;
    const shares = strategyShares(snapshot);
    const yesDelta = Math.max(0, shares[0] - attempt.baselineYes);
    const noDelta = Math.max(0, shares[1] - attempt.baselineNo);
    const outcome = yesDelta > EPSILON && noDelta > EPSILON
      ? "both"
      : yesDelta > EPSILON
        ? "yesOnly"
        : noDelta > EPSILON
          ? "noOnly"
          : "neither";
    this.model.observe({
      context: attempt.context,
      outcome,
      unwindLoss: outcome === "yesOnly"
        ? realizedUnwindLoss(snapshot, attempt, 0)
        : outcome === "noOnly"
          ? realizedUnwindLoss(snapshot, attempt, 1)
          : undefined,
      secondsToPair: outcome === "both"
        ? Math.max(1, (nowMs - attempt.startedAtMs) / 1_000)
        : undefined,
    });
    this.active.delete(event.slug);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const state: HistoryState = {
      version: 1,
      model: this.model.toJSON(),
      active: Object.fromEntries(this.active),
    };
    const operation = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), "utf8");
      try {
        await rename(temporary, this.path);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await writeFile(this.path, JSON.stringify(state), "utf8");
        await rm(temporary, { force: true });
      }
    };
    this.persistence = this.persistence.then(operation, operation);
    await this.persistence;
  }
}
