import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LadderV14LifecycleModel, type LifecycleState, type LifecycleEpisode, sizeBucket as sizeBucketForSubmitted, entryBucket as entryBucketForActual } from "./ladder-v14-lifecycle-ev.js";
import { ladderV14Inventory } from "./ladder-v14-inventory.js";
import { residualHoldValue } from "./ladder-v14.js";
import { v14LifecycleReport, type V14LifecycleReport } from "./ladder-v14-report.js";
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
  /** Cumulative order fills required, including fills before an amendment. */
  targetFilledSize?: number;
}

interface HistoryState {
  version: 1;
  lifecycle?: LifecycleState;
  model: LadderV14ModelState;
  planned: Array<[string, LadderV14PlacementContext]>;
  active: Array<[string, Exposure]>;
  observedOrderIds: string[];
  observedFillIds: string[];
  lifecycleReports?: V14LifecycleReport[];
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
  readonly lifecycle: LadderV14LifecycleModel;
  onLifecycleRecord?: (row: Record<string, unknown>) => void;
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
  private writing = false;
  private readonly lifecycleReports: Map<string, V14LifecycleReport>;

  private constructor(
    path: string,
    private readonly config: BotConfig,
    state?: Partial<HistoryState>,
  ) {
    this.path = path;
    this.lifecycle = new LadderV14LifecycleModel(state?.lifecycle);
    if (!state?.lifecycle) {
      // Historical reports already contributed to the economic calibration.
      // Migration must not count them as newly settled post-update markets.
      this.lifecycle.state.finalized = (state?.lifecycleReports ?? []).filter(r=>r.settledPnl !== null).map(r=>r.marketSlug);
    }
    this.model = new LadderV14ConditionalModel(
      ladderV14Parameters({
        priorStrength: config.ladderV14PriorStrength,
        flowWindowSeconds: config.ladderV14FlowWindowSeconds,
        volatilityWindowSeconds: config.ladderV14VolatilityWindowSeconds,
        finalCleanupSeconds: config.ladderV14FinalCleanupSeconds,
        quoteLifetimeSeconds: config.ladderV14QuoteLifetimeSeconds,
        pseudoFlowDepthFraction: config.ladderV14PseudoFlowDepthFraction,
        quantityQueueWeight: config.ladderV14QuantityQueueWeight,
        reachabilityMultiplier: config.ladderV14ReachabilityMultiplier,
      }),
      state?.model,
    );
    this.planned = new Map(state?.planned ?? []);
    this.active = new Map(state?.active ?? []);
    this.observedOrderIds = new Set(state?.observedOrderIds ?? []);
    this.observedFillIds = new Set(state?.observedFillIds ?? []);
    this.lifecycleReports = new Map((state?.lifecycleReports ?? []).map(row => [row.marketSlug, row]));
    // Old versions leaked every rejected/amended placement after settlement.
    // Remove expired quote contexts on load, but preserve learned statistics.
    for (const key of this.planned.keys()) {
      const match = /^ladder-v14:[^:]+-updown-(\d+)m-(\d+):/.exec(key);
      if (match && (Number(match[2]) + Number(match[1]) * 60) * 1000 < Date.now()) {
        this.planned.delete(key);
        this.dirty = true;
      }
    }
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
      if (directory.endsWith(".runtime")) {
        try {
          const legacy = JSON.parse(await readFile(join(dirname(directory), "ladder-v14-history.json"), "utf8")) as Partial<HistoryState>;
          return new LadderV14HistoryStore(path, config, legacy.version === 1 ? legacy : undefined);
        } catch (legacyError) {
          const legacyCode = legacyError && typeof legacyError === "object" && "code" in legacyError
            ? String(legacyError.code) : "";
          if (legacyCode !== "ENOENT") throw legacyError;
        }
      }
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
    if (this.config.ladderV14LifecycleEvEnabled &&
      (event.market.seriesTicker ?? event.slug.split("-")[0]).toUpperCase() === "KXBTC15M") {
      for (const [key, placement] of Object.entries(plan.placementContexts)) {
        if (placement.lifecycle && !this.lifecycle.state.openings[key]) {
          this.lifecycle.state.openings[key] = placement.lifecycle;

        }
      }
      this.observeLifecycle(snapshot, nowMs, event.windowEnd);
      changed = true;
    }
    for (const [tradeKey, placement] of Object.entries(plan.placementContexts)) {
      this.planned.set(tradeKey, structuredClone(placement));
      changed = true;
    }
    changed = this.observeOrders(snapshot, nowMs) || changed;

    // Bound stale planned contexts after a market is gone without scanning history.
    if (event.windowEnd * 1_000 < nowMs) {
      for (const key of this.planned.keys()) {
        if (key.startsWith(`ladder-v14:${event.slug}:`)) {
          this.planned.delete(key);
          changed = true;
        }
      }
    }
    if (changed) this.schedulePersist();
  }

  /** Replay only newly confirmed fills. Prefix inventory gives exact FIFO residual lots,
   * including multiple fills delivered between planning passes and side flips. */
  private observeLifecycle(
    snapshot: MarketExecutionSnapshot,
    nowMs: number,
    endSeconds: number,
  ): void {
    const state = this.lifecycle.state,
      slug = snapshot.marketSlug;
    if (state.finalized.includes(slug)) return;
    const processed = new Set(state.processed[slug] ?? []);
    const orders = new Map(
      snapshot.orders
        .filter((o) => o.pairId?.startsWith("ladder-v14:"))
        .map((o) => [o.id, o]),
    );
    const fills = [
      ...new Map(
        snapshot.fills
          .filter((f) => orders.has(f.orderId))
          .map((f) => [f.id, f]),
      ).values(),
    ].sort((a, b) => fillTimeMs(a, nowMs) - fillTimeMs(b, nowMs));
    for (let i = 0; i < fills.length; i++) {
      const fill = fills[i]!;
      if (processed.has(fill.id)) continue;
      const at = fillTimeMs(fill, nowMs) / 1000;
      const before = { ...snapshot, fills: fills.slice(0, i) },
        after = { ...snapshot, fills: fills.slice(0, i + 1) };
      const oldInventory = ladderV14Inventory(before, at),
        inventory = ladderV14Inventory(after, at);
      let episode: LifecycleEpisode | undefined = state.active[slug];
      if (episode) {
        const priorReport = v14LifecycleReport(before, at * 1000),
          report = v14LifecycleReport(after, at * 1000);
        episode.ps +=
          report.positivePairShares - priorReport.positivePairShares;
        episode.pp += report.positivePairPnl - priorReport.positivePairPnl;
        if ((fill.side ?? "BUY") === "SELL") episode.sold = true;
        if (
          report.negativePairShares - priorReport.negativePairShares >
          EPSILON
        )
          episode.negative = true;
        const flipped =
          inventory.episode &&
          inventory.episode.surplusTokenId !== episode.token;
        if (inventory.unpairedShares <= EPSILON || flipped) {
          const outcome = flipped
            ? "c"
            : episode.negative
              ? "n"
              : episode.sold
                ? "s"
                : episode.ps > EPSILON
                  ? "p"
                  : "c";
          this.onLifecycleRecord?.(this.lifecycle.close(episode, at, outcome));
          episode = undefined;
        }
      }
      const order = orders.get(fill.orderId)!;
      if (
        !episode &&
        inventory.unpairedShares > EPSILON &&
        inventory.episode &&
        ((oldInventory.unpairedShares <= EPSILON &&
          order.pairId === "ladder-v14:opening" &&
          (fill.side ?? "BUY") === "BUY") ||
          (oldInventory.episode &&
            oldInventory.episode.surplusTokenId !==
              inventory.episode.surplusTokenId))
      ) {
        const book = snapshot.books.find(
          (b) => b.tokenId === inventory.episode!.surplusTokenId,
        )!;
        const basis = inventory.residualEntryBasis!;
        const admission =
          state.openings[order.tradeKey] ??
          this.lifecycle.evaluate(
            basis,
            order.originalSize,
            endSeconds - at,
            book.minOrderSize,
          );
        state.active[slug] = {
          m: slug,
          s: book.outcome.toLowerCase(),
          token: book.tokenId,
          t: at,
          p: basis,
          shares: inventory.unpairedShares,
          q: order.originalSize,
          originalQuantity: admission.baselineQuantity,
          h: Math.max(0, endSeconds - at),
          q0: admission.qOpen,
          entryBucket: entryBucketForActual(basis),
          sizeBucket: sizeBucketForSubmitted(order.originalSize),
          g: null,
          ps: 0,
          pp: 0,
          negative: false,
          sold: false,
        };
      } else if (
        episode &&
        (fill.side ?? "BUY") === "BUY" &&
        fill.tokenId === episode.token
      ) {
        episode.shares += fill.size;
      }
      processed.add(fill.id);
    }
    state.processed[slug] = [...processed];
    const episode = state.active[slug];
    if (episode && episode.g === null && snapshot.marketDataValid !== false) {
      const held = snapshot.books.find((b) => b.tokenId === episode.token),
        opposite = snapshot.books.find((b) => b.tokenId !== episode.token);
      const hold = held && opposite ? residualHoldValue(held, opposite) : null;
      const basis = ladderV14Inventory(
        snapshot,
        nowMs / 1000,
      ).residualEntryBasis;
      if (hold !== null && basis !== null) episode.g = basis - hold;
    }
  }

  private observeOrders(snapshot: MarketExecutionSnapshot, nowMs: number): boolean {
    let changed = false;
    for (const order of snapshot.orders) {
      if (!order.pairId?.startsWith("ladder-v14:")) continue;
      if (this.observedOrderIds.has(order.id)) {
        // A partially filled order's first-fill hazard was already learned;
        // amendments must not leave another orphaned planned context behind.
        if (this.planned.delete(order.tradeKey)) changed = true;
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
          targetFilledSize: order.originalSize,
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
          targetFilledSize: order.originalSize,
        });
        this.planned.delete(order.tradeKey);
        changed = true;
      }
      const exposure = this.active.get(order.id)!;
      const fills = snapshot.fills.filter((fill) => fill.orderId === order.id);
      // Duplicate delivery must not make a partial repair look fully filled.
      const relevant = [...new Map(fills.filter((fill) =>
        exposure.placement.kind === "failed_exit"
          ? (fill.side ?? "BUY") === "SELL"
          : (fill.side ?? "BUY") === "BUY",
      ).map((fill) => [fill.id, fill])).values()];
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
      let eventAtMs = firstFillMs;
      if (exposure.placement.kind === "completion") {
        // Repair completion means the entire requested quantity, not first fill.
        // originalSize is cumulative across amendments, so old partial fills
        // cannot by themselves satisfy a replacement's remaining quantity.
        const target = exposure.targetFilledSize ?? order.originalSize;
        eventAtMs = Number.POSITIVE_INFINITY;
        let filledSize = 0;
        for (const fill of [...relevant].sort((left, right) =>
          fillTimeMs(left, nowMs) - fillTimeMs(right, nowMs))) {
          if (!Number.isFinite(fill.size) || fill.size <= 0) continue;
          filledSize += fill.size;
          if (target > EPSILON && filledSize + EPSILON >= target) {
            eventAtMs = fillTimeMs(fill, nowMs);
            break;
          }
        }
      }
      const occurred = Number.isFinite(eventAtMs);
      // A filled status is not a confirmed fill ledger. Wait for reconciliation;
      // only a reconciled cancellation (or settlement below) censors a repair.
      const terminal = !snapshot.executionPending && (
        order.status === "cancelled" ||
        (order.status === "filled" && exposure.placement.kind !== "completion")
      );
      if (!occurred && !terminal) continue;
      const elapsed = Math.max(
        0.01,
        ((occurred ? eventAtMs : nowMs) - exposure.startedAtMs) / 1_000,
      );
      if (exposure.placement.kind === "fill") {
        this.model.observeHazard(
          "fill",
          exposure.placement.context,
          elapsed,
          occurred,
        );
      } else if (exposure.placement.kind === "completion") {
        this.model.observeHazard(
          "completion",
          exposure.placement.context,
          elapsed,
          occurred,
        );
      }
      this.observedOrderIds.add(order.id);
      this.active.delete(order.id);
      changed = true;
    }

    return changed;
  }

  finalize(snapshot: MarketExecutionSnapshot, nowMs = Date.now()): void {
    const btc = this.config.exchange === "kalshi" &&
      (snapshot.marketSlug.toLowerCase().startsWith("btc-") || snapshot.marketSlug.toUpperCase().startsWith("KXBTC15M"));
    if (this.config.ladderV14LifecycleEvEnabled && btc && !this.lifecycle.state.finalized.includes(snapshot.marketSlug)) {
      const match = /-updown-(\d+)m-(\d+)$/.exec(snapshot.marketSlug);
      const end = match ? Number(match[2])+Number(match[1])*60 : nowMs/1000;
      this.observeLifecycle(snapshot,nowMs,end);
      const report=v14LifecycleReport(snapshot,Math.min(nowMs,end*1000));
      const episode=this.lifecycle.state.active[snapshot.marketSlug];
      if (episode) this.onLifecycleRecord?.(this.lifecycle.close(episode,Math.min(nowMs/1000,end),snapshot.settledPnl === null ? "c" : "r",
        report.endingUnpairedShares,report.settlementResidualPnl ?? 0));
      if (snapshot.settledPnl !== null) this.lifecycle.settle(snapshot.marketSlug,{
        positivePairPnl:report.positivePairPnl,positivePairShares:report.positivePairShares,
        residualNetPnl:report.settlementResidualPnl ?? 0,residualShares:report.endingUnpairedShares});
      for(const order of snapshot.orders) delete this.lifecycle.state.openings[order.tradeKey];
      this.onLifecycleRecord?.({e:"v14_summary",btcLifecycle:this.lifecycle.summary()});
    }
    if (!this.lifecycleReports.has(snapshot.marketSlug)) {
      const match = /-updown-(\d+)m-(\d+)$/.exec(snapshot.marketSlug);
      const endMs = match ? (Number(match[2]) + Number(match[1]) * 60) * 1000 : nowMs;
      this.lifecycleReports.set(snapshot.marketSlug, v14LifecycleReport(snapshot, Math.min(nowMs, endMs)));
    }
    // Include final fills before censoring exposures at settlement.
    this.observeOrders(snapshot, nowMs);
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
    for (const key of this.planned.keys()) {
      if (key.startsWith(`ladder-v14:${snapshot.marketSlug}:`)) this.planned.delete(key);
    }
    for (const order of snapshot.orders) {
      this.active.delete(order.id);
      this.observedOrderIds.delete(order.id);
    }
    for (const fill of snapshot.fills) this.observedFillIds.delete(fill.id);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    do {
      if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
      this.persistenceTimer = null;
      if (this.dirty || this.writing) await this.persist();
    } while (this.dirty || this.writing);
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = null;
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
    if (this.writing) return this.persistence;
    this.writing = true;
    this.dirty = false;
    const state: HistoryState = {
      version: 1,
      lifecycle: this.lifecycle.toJSON(),
      model: this.model.toJSON(),
      planned: [...this.planned],
      active: [...this.active],
      observedOrderIds: [...this.observedOrderIds],
      observedFillIds: [...this.observedFillIds],
      lifecycleReports: [...this.lifecycleReports.values()],
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
    try {
      await this.persistence;
    } catch (error) {
      this.dirty = true;
      throw error;
    } finally {
      this.writing = false;
      if (this.dirty) this.schedulePersist();
    }
  }
}
