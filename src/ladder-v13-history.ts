import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LadderV13FillHazardModel,
  type LadderV13HazardObservation,
  type LadderV13MarketFeatures,
  type LadderV13OrderHazardContext,
  type LadderV13Plan,
} from "./ladder-v13.js";
import type { MarketExecutionSnapshot, PaperOrder, UpDownEvent } from "./types.js";
import { LadderV13CompletionHazardModel, type LadderV13CompletionContext, type LadderV13CompletionObservation } from "./ladder-v13-completion-model.js";
import type { LadderV13ResidualEpisode } from "./ladder-v13-inventory.js";

const EPSILON = 1e-8;

interface LiveObservation {
  context: LadderV13OrderHazardContext;
  startedAtMs: number;
}

interface CompletionExposure {
  context: LadderV13CompletionContext;
  startedAtMs: number;
  initialFilledSize: number;
  targetShares: number;
}

interface HistoryState {
  version: number;
  observations: LadderV13HazardObservation[];
  observedOrderIds: string[];
  completionObservations?: LadderV13CompletionObservation[];
  completionObservedIds?: string[];
  completionLive?: Array<[string, CompletionExposure]>;
  completionPlanned?: Array<[string, LadderV13CompletionContext]>;
  residualEpisodes?: Array<[string, LadderV13ResidualEpisode]>;
}

function eventTimestampMs(event: Record<string, unknown>): number | null {
  const raw = event.source_timestamp ?? event.timestamp ?? event.ts;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1_000 : raw;
  if (typeof raw === "string") {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1_000 : numeric;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function tokenId(event: Record<string, unknown>): string | null {
  const value = event.asset_id ?? event.token_id;
  return typeof value === "string" && value ? value : null;
}

function tradeSize(event: Record<string, unknown>): number {
  const value = Number(event.size ?? event.count ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isOpening(order: PaperOrder): boolean {
  return order.pairId?.startsWith("ladder-v13:opening") ?? false;
}

/** Persists fill-time and censored-cancel observations for individual V13 orders. */
export class LadderV13HistoryStore {
  readonly model: LadderV13FillHazardModel;
  readonly completionModel: LadderV13CompletionHazardModel;
  private readonly completionObservedIds: Set<string>;
  private readonly completionLive: Map<string, CompletionExposure>;
  private readonly completionPlanned: Map<string, LadderV13CompletionContext>;
  private readonly residualEpisodes: Map<string, LadderV13ResidualEpisode>;
  private readonly path: string;
  private readonly observedOrderIds: Set<string>;
  private readonly live = new Map<string, LiveObservation>();
  private readonly trades = new Map<string, Array<{ atMs: number; size: number }>>();
  private persistence: Promise<void> = Promise.resolve();

  private constructor(path: string, state: HistoryState) {
    this.path = path;
    this.model = new LadderV13FillHazardModel(state.observations);
    this.observedOrderIds = new Set(state.observedOrderIds);
    this.completionModel = new LadderV13CompletionHazardModel(state.completionObservations);
    this.completionObservedIds = new Set(state.completionObservedIds);
    this.completionLive = new Map(state.completionLive);
    this.completionPlanned = new Map(state.completionPlanned);
    this.residualEpisodes = new Map(state.residualEpisodes);
  }

  static async load(directory: string): Promise<LadderV13HistoryStore> {
    const path = join(directory, "ladder-v13-history.json");
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<HistoryState>;
      // V1 stored incompatible eight-dimensional attempt buckets. Starting the
      // new order-hazard model empty is the only unbiased migration.
      return new LadderV13HistoryStore(path, parsed.version === 2 || parsed.version === 3 ? {
        ...parsed,
        version: 3,
        observations: parsed.observations ?? [],
        observedOrderIds: parsed.observedOrderIds ?? [],
      } : { version: 3, observations: [], observedOrderIds: [] });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
      return new LadderV13HistoryStore(path, { version: 3, observations: [], observedOrderIds: [] });
    }
  }

  ingestTelemetry(event: Record<string, unknown>): void {
    if (String(event.event_type ?? event.type ?? "") !== "last_trade_price") return;
    const side = String(event.side ?? "").toUpperCase();
    if (side && side !== "SELL") return;
    const id = tokenId(event);
    const atMs = eventTimestampMs(event);
    const size = tradeSize(event);
    if (!id || atMs === null || size <= EPSILON) return;
    const samples = this.trades.get(id) ?? [];
    samples.push({ atMs, size });
    samples.sort((left, right) => left.atMs - right.atMs);
    const cutoff = atMs - 300_000;
    while (samples[0] && samples[0].atMs < cutoff) samples.shift();
    this.trades.set(id, samples);
  }

  marketFeatures(
    _event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowMs = Date.now(),
  ): LadderV13MarketFeatures {
    const eligibleVolumePerSecondByToken: Record<string, number> = {};
    for (const book of snapshot.books) {
      const samples = (this.trades.get(book.tokenId) ?? []).filter((sample) => sample.atMs >= nowMs - 60_000 && sample.atMs <= nowMs);
      eligibleVolumePerSecondByToken[book.tokenId] = samples.reduce((sum, sample) => sum + sample.size, 0) / 60;
    }
    return { eligibleVolumePerSecondByToken };
  }

  async observe(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    plan: LadderV13Plan,
    nowMs = Date.now(),
  ): Promise<void> {
    const contexts = new Map<string, LadderV13OrderHazardContext>();
    if (plan.selectedCandidate) {
      contexts.set(snapshot.books[0]?.tokenId ?? "", plan.selectedCandidate.yesContext);
      contexts.set(snapshot.books[1]?.tokenId ?? "", plan.selectedCandidate.noContext);
    }
    let changed = this.observeCompletion(event, snapshot, plan, nowMs);
    for (const order of snapshot.orders.filter(isOpening)) {
      if (this.observedOrderIds.has(order.id)) continue;
      if (!this.live.has(order.id)) {
        const context = contexts.get(order.tokenId) ?? this.contextForOrder(order, snapshot, nowMs);
        if (!context) continue;
        this.live.set(order.id, { context, startedAtMs: Date.parse(order.createdAt) || nowMs });
      }
      const active = this.live.get(order.id)!;
      const fills = snapshot.fills.filter((fill) => fill.orderId === order.id && (fill.side ?? "BUY") === "BUY");
      const firstFillMs = fills.length
        ? Math.min(...fills.map((fill) => Date.parse(fill.timestamp)).filter(Number.isFinite))
        : Number.POSITIVE_INFINITY;
      const finished = Number.isFinite(firstFillMs) || order.status === "cancelled" || order.status === "filled";
      if (!finished) continue;
      const endMs = Number.isFinite(firstFillMs) ? firstFillMs : nowMs;
      const exposureSeconds = Math.max(0.01, (endMs - active.startedAtMs) / 1_000);
      this.model.observe({
        context: active.context,
        exposureSeconds,
        filled: Number.isFinite(firstFillMs),
        fillSeconds: Number.isFinite(firstFillMs) ? exposureSeconds : undefined,
      });
      this.observedOrderIds.add(order.id);
      this.live.delete(order.id);
      changed = true;
    }
    if (changed) await this.persist();
  }

  async finalize(
    event: UpDownEvent,
    snapshot: MarketExecutionSnapshot,
    nowMs = Date.now(),
  ): Promise<void> {
    // An immediately filled final submission may settle before another plan.
    // Attach its saved placement context without reconstructing later features.
    for (const order of snapshot.orders) {
      const context = this.completionPlanned.get(order.tradeKey);
      if (!context || this.completionObservedIds.has(order.id) || this.completionLive.has(order.id)) continue;
      this.completionLive.set(order.id, { context, startedAtMs: Date.parse(order.createdAt) || nowMs,
        initialFilledSize: 0, targetShares: order.originalSize });
      this.completionPlanned.delete(order.tradeKey);
    }
    this.finishCompletionObservations(snapshot, nowMs, true);
    this.residualEpisodes.delete(event.slug);
    for (const key of this.completionPlanned.keys()) {
      if (key.startsWith(`ladder-v13:${event.slug}:`)) this.completionPlanned.delete(key);
    }
    for (const order of snapshot.orders.filter(isOpening)) {
      if (this.observedOrderIds.has(order.id)) continue;
      const active = this.live.get(order.id);
      const context = active?.context ?? this.contextForOrder(order, snapshot, nowMs);
      if (!context) continue;
      const startedAtMs = active?.startedAtMs ?? (Date.parse(order.createdAt) || nowMs);
      const fill = snapshot.fills
        .filter((candidate) => candidate.orderId === order.id && (candidate.side ?? "BUY") === "BUY")
        .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))[0];
      const endMs = fill ? Date.parse(fill.timestamp) : nowMs;
      const exposureSeconds = Math.max(0.01, (endMs - startedAtMs) / 1_000);
      this.model.observe({ context, exposureSeconds, filled: Boolean(fill), fillSeconds: fill ? exposureSeconds : undefined });
      this.observedOrderIds.add(order.id);
      this.live.delete(order.id);
    }
    await this.persist();
  }

  private observeCompletion(event: UpDownEvent, snapshot: MarketExecutionSnapshot, plan: LadderV13Plan, nowMs: number): boolean {
    let changed = false;
    if (plan.residualEpisode) {
      const previous = this.residualEpisodes.get(event.slug);
      changed = previous?.id !== plan.residualEpisode.id ||
        previous?.residualQuantity !== plan.residualEpisode.residualQuantity ||
        previous?.hasMatchedShares !== plan.residualEpisode.hasMatchedShares;
      this.residualEpisodes.set(event.slug, { ...plan.residualEpisode });
    } else if (this.residualEpisodes.delete(event.slug)) changed = true;
    if (plan.completionContext) {
      for (const opportunity of plan.opportunities.filter((item) => item.orderPolicy === "post_only")) {
        this.completionPlanned.set(opportunity.tradeKey, { ...plan.completionContext });
        changed = true;
      }
    }
    for (const order of snapshot.orders) {
      if (!order.pairId?.startsWith("ladder-v13:") || order.orderPolicy !== "post_only" ||
        (order.side ?? "BUY") !== "BUY" || this.completionLive.has(order.id) || this.completionObservedIds.has(order.id)) continue;
      const planned = this.completionPlanned.get(order.tradeKey);
      const retainedCompletion = plan.managementStage === "waiting-completion-maker" &&
        plan.residualEpisode && order.tokenId !== plan.residualEpisode.surplusTokenId &&
        snapshot.openOrders.some((item) => item.id === order.id);
      const context = planned ?? (retainedCompletion ? plan.completionContext : null);
      // Never reconstruct placement features from a later book: missing legacy
      // contexts are skipped instead of biasing the cross-market estimator.
      if (!context) continue;
      const filledSize = snapshot.fills.filter((fill) => fill.orderId === order.id)
        .reduce((sum, fill) => sum + fill.size, 0);
      this.completionLive.set(order.id, {
        context: { ...context }, startedAtMs: planned ? Date.parse(order.createdAt) || nowMs : nowMs,
        targetShares: planned ? order.originalSize : order.remainingSize,
        initialFilledSize: planned ? 0 : filledSize,
      });
      this.completionPlanned.delete(order.tradeKey);
      changed = true;
    }
    return this.finishCompletionObservations(snapshot, nowMs) || changed;
  }

  private finishCompletionObservations(snapshot: MarketExecutionSnapshot, nowMs: number, finalize = false): boolean {
    if (snapshot.executionPending) return false;
    let changed = false;
    for (const order of snapshot.orders) {
      const active = this.completionLive.get(order.id);
      if (!active) continue;
      const fills = snapshot.fills.filter((fill) => fill.orderId === order.id);
      const filledSize = fills.reduce((sum, fill) => sum + fill.size, 0) - active.initialFilledSize;
      const filled = filledSize + EPSILON >= active.targetShares;
      if (!filled && !finalize && order.status !== "cancelled") continue;
      const lastFillMs = Math.max(...fills.map((fill) => Date.parse(fill.timestamp)).filter(Number.isFinite));
      const exposureSeconds = Math.max(0.01, ((filled && Number.isFinite(lastFillMs) ? lastFillMs : nowMs) - active.startedAtMs) / 1_000);
      this.completionModel.observe({ context: active.context, filled, exposureSeconds,
        fillSeconds: filled ? exposureSeconds : undefined });
      this.completionObservedIds.add(order.id);
      this.completionLive.delete(order.id);
      changed = true;
    }
    return changed;
  }

  private contextForOrder(
    order: PaperOrder,
    snapshot: MarketExecutionSnapshot,
    nowMs: number,
  ): LadderV13OrderHazardContext | null {
    const book = snapshot.books.find((candidate) => candidate.tokenId === order.tokenId);
    if (!book) return null;
    const tick = 0.01;
    return {
      tokenId: order.tokenId,
      queueAhead: order.queueAhead,
      distanceTicks: Math.max(0, Math.round(((book.bestBid ?? order.limitPrice) - order.limitPrice) / tick)),
      eligibleVolumePerSecond: this.marketFeatures({} as UpDownEvent, snapshot, nowMs).eligibleVolumePerSecondByToken[order.tokenId] ?? 0,
      quoteSize: order.originalSize,
      horizonSeconds: 60,
    };
  }

  private async persist(): Promise<void> {
    const state: HistoryState = {
      version: 3,
      observations: this.model.toJSON(),
      observedOrderIds: [...this.observedOrderIds],
      completionObservations: this.completionModel.toJSON(),
      completionObservedIds: [...this.completionObservedIds],
      completionLive: [...this.completionLive],
      completionPlanned: [...this.completionPlanned],
      residualEpisodes: [...this.residualEpisodes],
    };
    const operation = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), "utf8");
      try {
        await rename(temporary, this.path);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await writeFile(this.path, JSON.stringify(state), "utf8");
        await rm(temporary, { force: true });
      }
    };
    this.persistence = this.persistence.then(operation, operation);
    await this.persistence;
  }
}
