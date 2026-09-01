import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig } from "./config.js";
import {
  LadderV14ConditionalModel,
  ladderV14Parameters,
  type LadderV14ConditionalContext,
  type LadderV14ModelState,
} from "./ladder-v14-model.js";
import type {
  LadderV14MarketFeatures,
  LadderV14PlacementContext,
  LadderV14Plan,
} from "./ladder-v14.js";
import type {
  MarketExecutionSnapshot,
  PaperFill,
  UpDownEvent,
} from "./types.js";

const EPSILON = 1e-8;

interface TradeSample {
  atMs: number;
  price: number;
  size: number;
}

interface MidSample {
  atMs: number;
  price: number;
}

interface TradeWindow {
  samples: TradeSample[];
  volume: number;
}

interface MidWindow {
  samples: MidSample[];
  sum: number;
  sumSquares: number;
}

interface Exposure {
  placement: LadderV14PlacementContext;
  startedAtMs: number;
  tradeKey?: string;
}

interface HistoryState {
  version: 1;
  model: LadderV14ModelState;
  planned: Array<[string, LadderV14PlacementContext]>;
  active: Array<[string, Exposure]>;
  observedOrderIds: string[];
  observedFillIds: string[];
}

function eventTimeMs(event: Record<string, unknown>): number | null {
  const raw = event.source_timestamp ?? event.timestamp ?? event.ts;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1_000 : raw;
  }
  if (typeof raw !== "string") return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventTokenId(event: Record<string, unknown>): string | null {
  const value = event.asset_id ?? event.token_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finitePositive(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function fillTimeMs(fill: PaperFill, fallback: number): number {
  const parsed = Date.parse(fill.timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function standardDeviation(window: MidWindow): number {
  const count = window.samples.length;
  if (count < 2) return 0;
  const variance = (
    window.sumSquares - window.sum * window.sum / count
  ) / (count - 1);
  return Math.sqrt(Math.max(0, variance));
}

/**
 * V14's hot-path learner. Estimates use indexed sufficient statistics only;
 * disk writes are coalesced and never awaited by a book-update planning pass.
 */
export class LadderV14HistoryStore {
  readonly model: LadderV14ConditionalModel;
  private readonly path: string;
  private readonly planned: Map<string, LadderV14PlacementContext>;
  private readonly active: Map<string, Exposure>;
  private readonly observedOrderIds: Set<string>;
  private readonly observedFillIds: Set<string>;
  private readonly trades = new Map<string, TradeWindow>();
  private readonly mids = new Map<string, MidWindow>();
  private persistence: Promise<void> = Promise.resolve();
  private persistenceTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  private constructor(
    path: string,
    private readonly config: BotConfig,
    state?: Partial<HistoryState>,
  ) {
    this.path = path;
    this.model = new LadderV14ConditionalModel(
      ladderV14Parameters({
        priorStrength: config.ladderV14PriorStrength,
        flowWindowSeconds: config.ladderV14FlowWindowSeconds,
        volatilityWindowSeconds: config.ladderV14VolatilityWindowSeconds,
        finalCleanupSeconds: config.ladderV14FinalCleanupSeconds,
      }),
      state?.model,
    );
    this.planned = new Map(state?.planned ?? []);
    this.active = new Map(state?.active ?? []);
    this.observedOrderIds = new Set(state?.observedOrderIds ?? []);
    this.observedFillIds = new Set(state?.observedFillIds ?? []);
  }

  static async load(
    directory: string,
    config: BotConfig,
  ): Promise<LadderV14HistoryStore> {
    const path = join(directory, "ladder-v14-history.json");
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<HistoryState>;
      return new LadderV14HistoryStore(
        path,
        config,
        parsed.version === 1 ? parsed : undefined,
      );
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code !== "ENOENT") throw error;
      return new LadderV14HistoryStore(path, config);
    }
  }

  ingestTelemetry(event: Record<string, unknown>): void {
    if (String(event.event_type ?? event.type ?? "") !== "last_trade_price") return;
    const tokenId = eventTokenId(event);
    const atMs = eventTimeMs(event);
    const price = finitePositive(event.price);
    const size = finitePositive(event.size ?? event.count);
    if (!tokenId || atMs === null || price === null || size === null) return;
    const window = this.trades.get(tokenId) ?? { samples: [], volume: 0 };
    window.samples.push({ atMs, price, size });
    window.volume += size;
    window.samples.sort((left, right) => left.atMs - right.atMs);
    const cutoff = atMs - Math.max(
      this.config.ladderV14FlowWindowSeconds,
      this.config.ladderV14VolatilityWindowSeconds,
    ) * 2_000;
    while (window.samples[0] && window.samples[0].atMs < cutoff) {
      window.volume -= window.samples.shift()!.size;
    }
    this.trades.set(tokenId, window);
  }

  marketFeatures(
    _event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowMs = Date.now(),
  ): LadderV14MarketFeatures {
    const eligibleVolumePerSecondByToken: Record<string, number> = {};
    const volatilityByToken: Record<string, number> = {};
    const midpointByToken: Record<string, number | null> = {};
    for (const book of snapshot.books) {
      const currentMid = book.bestBid === null || book.bestAsk === null
        ? null
        : (book.bestBid + book.bestAsk) / 2;
      midpointByToken[book.tokenId] = currentMid;
      if (currentMid !== null) {
        const window = this.mids.get(book.tokenId) ?? {
          samples: [], sum: 0, sumSquares: 0,
        };
        if (
          !window.samples.at(-1) ||
          Math.abs(window.samples.at(-1)!.price - currentMid) > EPSILON
        ) {
          window.samples.push({ atMs: nowMs, price: currentMid });
          window.sum += currentMid;
          window.sumSquares += currentMid * currentMid;
        }
        const cutoff = nowMs - this.config.ladderV14VolatilityWindowSeconds * 1_000;
        while (window.samples[0] && window.samples[0].atMs < cutoff) {
          const expired = window.samples.shift()!;
          window.sum -= expired.price;
          window.sumSquares -= expired.price * expired.price;
        }
        this.mids.set(book.tokenId, window);
      }
      const flowCutoff = nowMs - this.config.ladderV14FlowWindowSeconds * 1_000;
      const tradeWindow = this.trades.get(book.tokenId);
      while (tradeWindow?.samples[0] && tradeWindow.samples[0].atMs < flowCutoff) {
        tradeWindow.volume -= tradeWindow.samples.shift()!.size;
      }
      eligibleVolumePerSecondByToken[book.tokenId] =
        Math.max(0, tradeWindow?.volume ?? 0) /
        this.config.ladderV14FlowWindowSeconds;
      const midWindow = this.mids.get(book.tokenId) ?? {
        samples: [], sum: 0, sumSquares: 0,
      };
      volatilityByToken[book.tokenId] = standardDeviation(midWindow);
    }
    return { eligibleVolumePerSecondByToken, volatilityByToken, midpointByToken };
  }

  observe(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    plan: LadderV14Plan,
    nowMs = Date.now(),
  ): void {
    let changed = false;
    for (const [tradeKey, placement] of Object.entries(plan.placementContexts)) {
      this.planned.set(tradeKey, structuredClone(placement));
      changed = true;
    }
    for (const order of snapshot.orders) {
      if (!order.pairId?.startsWith("ladder-v14:") || this.observedOrderIds.has(order.id)) {
        continue;
      }
      const replacement = this.planned.get(order.tradeKey);
      const existingExposure = this.active.get(order.id);
      if (
        existingExposure &&
        replacement &&
        existingExposure.tradeKey !== order.tradeKey
      ) {
        if (existingExposure.placement.kind !== "failed_exit") {
          this.model.observeHazard(
            existingExposure.placement.kind === "fill" ? "fill" : "completion",
            existingExposure.placement.context,
            Math.max(0.01, (nowMs - existingExposure.startedAtMs) / 1_000),
            false,
          );
        }
        this.active.set(order.id, {
          placement: replacement,
          startedAtMs: nowMs,
          tradeKey: order.tradeKey,
        });
        this.planned.delete(order.tradeKey);
        changed = true;
      } else if (!existingExposure) {
        const placement = this.planned.get(order.tradeKey);
        if (!placement) continue;
        this.active.set(order.id, {
          placement,
          startedAtMs: Date.parse(order.createdAt) || nowMs,
          tradeKey: order.tradeKey,
        });
        this.planned.delete(order.tradeKey);
        changed = true;
      }
      const exposure = this.active.get(order.id)!;
      const fills = snapshot.fills.filter((fill) => fill.orderId === order.id);
      const relevant = fills.filter((fill) =>
        exposure.placement.kind === "failed_exit"
          ? (fill.side ?? "BUY") === "SELL"
          : (fill.side ?? "BUY") === "BUY",
      );
      for (const fill of relevant) {
        if (this.observedFillIds.has(fill.id)) continue;
        if (exposure.placement.kind === "completion") {
          this.model.observeCompletionCost(
            exposure.placement.context,
            fill.price + fill.fee / Math.max(EPSILON, fill.size),
          );
        } else if (exposure.placement.kind === "failed_exit") {
          this.model.observeFailedExit(
            exposure.placement.context,
            fill.price - fill.fee / Math.max(EPSILON, fill.size),
          );
        }
        this.observedFillIds.add(fill.id);
        changed = true;
      }
      const firstFillMs = relevant.length === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(...relevant.map((fill) => fillTimeMs(fill, nowMs)));
      const terminal = order.status === "cancelled" || order.status === "filled";
      if (!Number.isFinite(firstFillMs) && !terminal) continue;
      const elapsed = Math.max(
        0.01,
        ((Number.isFinite(firstFillMs) ? firstFillMs : nowMs) - exposure.startedAtMs) / 1_000,
      );
      if (exposure.placement.kind === "fill") {
        this.model.observeHazard(
          "fill",
          exposure.placement.context,
          elapsed,
          Number.isFinite(firstFillMs),
        );
      } else if (exposure.placement.kind === "completion") {
        this.model.observeHazard(
          "completion",
          exposure.placement.context,
          elapsed,
          Number.isFinite(firstFillMs),
        );
      }
      this.observedOrderIds.add(order.id);
      this.active.delete(order.id);
      changed = true;
    }

    if (changed) this.schedulePersist();

    // Bound stale planned contexts after a market is gone without scanning history.
    if (event.windowEnd * 1_000 < nowMs) {
      for (const key of this.planned.keys()) {
        if (key.startsWith(`ladder-v14:${event.slug}:`)) this.planned.delete(key);
      }
    }
  }

  finalize(snapshot: MarketExecutionSnapshot, nowMs = Date.now()): void {
    for (const order of snapshot.orders) {
      const exposure = this.active.get(order.id);
      if (!exposure || this.observedOrderIds.has(order.id)) continue;
      if (exposure.placement.kind !== "failed_exit") {
        this.model.observeHazard(
          exposure.placement.kind === "fill" ? "fill" : "completion",
          exposure.placement.context,
          Math.max(0.01, (nowMs - exposure.startedAtMs) / 1_000),
          false,
        );
      }
      this.observedOrderIds.add(order.id);
      this.active.delete(order.id);
    }
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = null;
    }
    if (this.dirty) await this.persist();
    await this.persistence;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      void this.persist();
    }, 500);
    this.persistenceTimer.unref?.();
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    const state: HistoryState = {
      version: 1,
      model: this.model.toJSON(),
      planned: [...this.planned],
      active: [...this.active],
      observedOrderIds: [...this.observedOrderIds],
      observedFillIds: [...this.observedFillIds],
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
