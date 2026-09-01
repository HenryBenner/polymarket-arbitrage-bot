import type { ExecutionMode } from "./types.js";

const EPSILON = 1e-10;
const GLOBAL_COMPLETION_PROBABILITY = 0.5;
const GLOBAL_RECOVERY_RATIO = 0.522;

export interface LadderV14Parameters {
  priorStrength: number;
  flowWindowSeconds: number;
  volatilityWindowSeconds: number;
  finalCleanupSeconds: number;
}

export interface LadderV14ConditionalContext {
  series: string;
  executionMode: ExecutionMode;
  side: string;
  entryPrice: number;
  currentBid: number | null;
  currentMid: number | null;
  priceMoveSinceFill: number;
  volatility: number;
  queueAhead: number;
  flowPerSecond: number;
  distanceTicks: number;
  quantity: number;
  depth: number;
  residualAgeSeconds: number;
  secondsRemaining: number;
}

export interface LadderV14HazardEstimate {
  hazard: number;
  probability: number;
  observations: number;
  source: "analytical" | "posterior" | "paper_bootstrap";
}

interface HazardStats {
  events: number;
  exposureSeconds: number;
  observations: number;
}

interface MomentStats {
  count: number;
  sum: number;
  sumSquares: number;
}

export interface LadderV14ModelState {
  version: 1;
  hazards: Array<[string, HazardStats]>;
  completionCosts: Array<[string, MomentStats]>;
  failedExitRecoveries: Array<[string, MomentStats]>;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function logBucket(value: number, floor: number): number {
  return Math.floor(Math.log2(Math.max(floor, value) / floor));
}

function priceBucket(value: number): number {
  return Math.floor(clamp(value, 0, 0.999999) / 0.05);
}

function contextBucket(
  context: LadderV14ConditionalContext,
  modeOverride?: ExecutionMode,
): string {
  const midpoint = context.currentMid ?? context.entryPrice;
  const bid = context.currentBid ?? 0;
  return [
    context.series.toUpperCase(),
    modeOverride ?? context.executionMode,
    context.side.toUpperCase(),
    priceBucket(context.entryPrice),
    priceBucket(midpoint),
    priceBucket(bid),
    Math.floor(context.priceMoveSinceFill / 0.05),
    logBucket(context.volatility, 0.0025),
    logBucket(context.queueAhead / Math.max(context.quantity, 0.01), 0.25),
    logBucket(context.flowPerSecond / Math.max(context.quantity, 0.01), 0.001),
    Math.min(4, Math.max(0, context.distanceTicks)),
    logBucket(context.quantity, 1),
    logBucket(context.depth / Math.max(context.quantity, 0.01), 0.25),
    Math.floor(Math.max(0, context.residualAgeSeconds) / 60),
    Math.floor(Math.max(0, context.secondsRemaining) / 60),
  ].join("|");
}

function emptyHazard(): HazardStats {
  return { events: 0, exposureSeconds: 0, observations: 0 };
}

function emptyMoment(): MomentStats {
  return { count: 0, sum: 0, sumSquares: 0 };
}

/** Indexed conditional sufficient statistics; estimate calls never scan observations. */
export class LadderV14ConditionalModel {
  private readonly hazards: Map<string, HazardStats>;
  private readonly completionCosts: Map<string, MomentStats>;
  private readonly failedExitRecoveries: Map<string, MomentStats>;

  constructor(
    private readonly parameters: LadderV14Parameters,
    state?: Partial<LadderV14ModelState>,
  ) {
    this.hazards = new Map(state?.hazards ?? []);
    this.completionCosts = new Map(state?.completionCosts ?? []);
    this.failedExitRecoveries = new Map(state?.failedExitRecoveries ?? []);
  }

  estimateFill(
    context: LadderV14ConditionalContext,
    horizonSeconds: number,
  ): LadderV14HazardEstimate {
    return this.estimateHazard("fill", context, horizonSeconds);
  }

  estimateCompletion(
    context: LadderV14ConditionalContext,
    horizonSeconds: number,
  ): LadderV14HazardEstimate {
    return this.estimateHazard("completion", context, horizonSeconds);
  }

  private estimateHazard(
    kind: "fill" | "completion",
    context: LadderV14ConditionalContext,
    horizonSeconds: number,
  ): LadderV14HazardEstimate {
    const horizon = Math.max(0, horizonSeconds);
    const queueWork = Math.max(0.01, context.queueAhead + 0.5 * context.quantity);
    const globalHazard = -Math.log(1 - GLOBAL_COMPLETION_PROBABILITY) / 900;
    const baseAnalytical = context.flowPerSecond > EPSILON
      ? context.flowPerSecond / queueWork
      : globalHazard;
    // Resting orders several ticks behind the touch should not inherit the
    // same cold-start hazard as the current best bid.
    const analytical = baseAnalytical * Math.exp(
      -0.65 * Math.max(0, context.distanceTicks),
    );
    const key = `${kind}|${contextBucket(context)}`;
    const direct = this.hazards.get(key);
    let source: LadderV14HazardEstimate["source"] = "analytical";
    let boot = emptyHazard();
    if (context.executionMode === "live") {
      const paper = this.hazards.get(
        `${kind}|${contextBucket(context, "paper")}`,
      );
      if (paper && paper.exposureSeconds > EPSILON) {
        const paperHazard = paper.events / paper.exposureSeconds;
        const cap = this.parameters.priorStrength * 60;
        boot = {
          events: paperHazard * cap,
          exposureSeconds: cap,
          observations: Math.min(paper.observations, this.parameters.priorStrength),
        };
        source = "paper_bootstrap";
      }
    }
    const priorExposure = this.parameters.priorStrength * 60;
    const events = analytical * priorExposure + boot.events + (direct?.events ?? 0);
    const exposure = priorExposure + boot.exposureSeconds +
      (direct?.exposureSeconds ?? 0);
    const hazard = Math.max(EPSILON, events / Math.max(EPSILON, exposure));
    if (direct && direct.observations > 0) source = "posterior";
    return {
      hazard,
      probability: clamp(1 - Math.exp(-hazard * horizon), 0, 1),
      observations: (direct?.observations ?? 0) + boot.observations,
      source,
    };
  }

  expectedCompletionCost(
    context: LadderV14ConditionalContext,
    fallbackAllInCost: number,
  ): number {
    return this.shrunkMoment(
      this.completionCosts,
      `completion-cost|${contextBucket(context)}`,
      context,
      fallbackAllInCost,
    );
  }

  expectedFailedExit(
    context: LadderV14ConditionalContext,
  ): number {
    const historical = context.entryPrice * GLOBAL_RECOVERY_RATIO;
    const midpoint = context.currentMid ?? context.entryPrice;
    const stateShift = midpoint - context.entryPrice;
    const stateRecovery = clamp(
      historical + 0.8 * stateShift - 0.5 * Math.max(0, context.volatility),
      0,
      1,
    );
    const executable = context.currentBid === null
      ? stateRecovery
      : Math.min(context.currentBid, stateRecovery);
    const recoveryRatio = this.shrunkMoment(
      this.failedExitRecoveries,
      `failed-exit|${contextBucket(context)}`,
      context,
      context.entryPrice <= EPSILON ? 0 : executable / context.entryPrice,
    );
    return clamp(context.entryPrice * recoveryRatio, 0, 1);
  }

  private shrunkMoment(
    map: Map<string, MomentStats>,
    key: string,
    context: LadderV14ConditionalContext,
    fallback: number,
  ): number {
    const direct = map.get(key);
    let paperMean: number | null = null;
    if (context.executionMode === "live") {
      const prefix = key.slice(0, key.indexOf("|") + 1);
      const paperKey = `${prefix}${contextBucket(context, "paper")}`;
      const paper = map.get(paperKey);
      if (paper && paper.count > 0) paperMean = paper.sum / paper.count;
    }
    const priorWeight = this.parameters.priorStrength;
    const transferWeight = paperMean === null ? 0 : priorWeight;
    const numerator = fallback * priorWeight +
      (paperMean ?? 0) * transferWeight + (direct?.sum ?? 0);
    const denominator = priorWeight + transferWeight + (direct?.count ?? 0);
    return denominator <= EPSILON ? fallback : numerator / denominator;
  }

  observeHazard(
    kind: "fill" | "completion",
    context: LadderV14ConditionalContext,
    exposureSeconds: number,
    occurred: boolean,
  ): void {
    if (!Number.isFinite(exposureSeconds) || exposureSeconds <= 0) return;
    const key = `${kind}|${contextBucket(context)}`;
    const stats = this.hazards.get(key) ?? emptyHazard();
    stats.exposureSeconds += exposureSeconds;
    stats.events += occurred ? 1 : 0;
    stats.observations += 1;
    this.hazards.set(key, stats);
  }

  observeCompletionCost(
    context: LadderV14ConditionalContext,
    allInCost: number,
  ): void {
    this.observeMoment(
      this.completionCosts,
      `completion-cost|${contextBucket(context)}`,
      allInCost,
    );
  }

  observeFailedExit(
    context: LadderV14ConditionalContext,
    netExitPrice: number,
  ): void {
    if (context.entryPrice <= EPSILON) return;
    this.observeMoment(
      this.failedExitRecoveries,
      `failed-exit|${contextBucket(context)}`,
      netExitPrice / context.entryPrice,
    );
  }

  private observeMoment(
    map: Map<string, MomentStats>,
    key: string,
    value: number,
  ): void {
    if (!Number.isFinite(value)) return;
    const stats = map.get(key) ?? emptyMoment();
    stats.count += 1;
    stats.sum += value;
    stats.sumSquares += value * value;
    map.set(key, stats);
  }

  toJSON(): LadderV14ModelState {
    return {
      version: 1,
      hazards: [...this.hazards],
      completionCosts: [...this.completionCosts],
      failedExitRecoveries: [...this.failedExitRecoveries],
    };
  }
}

export function ladderV14Parameters(input: {
  priorStrength: number;
  flowWindowSeconds: number;
  volatilityWindowSeconds: number;
  finalCleanupSeconds: number;
}): LadderV14Parameters {
  return { ...input };
}
