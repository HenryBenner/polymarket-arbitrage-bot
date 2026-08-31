export interface LadderV13CompletionContext {
  queueRatio: number;
  flowRatio: number;
  distanceTicks: number;
  residualShares: number;
  residualAgeSeconds: number;
  secondsRemaining: number;
  maximumCompletionPrice: number;
  completionMakerPrice: number;
}

export interface LadderV13CompletionObservation {
  context: LadderV13CompletionContext;
  filled: boolean;
  fillSeconds?: number;
  exposureSeconds: number;
}

export interface LadderV13CompletionEstimate {
  probability: number;
  upperProbability: number;
  hazard: number;
  comparableOrders: number;
  completedOrders: number;
  exposureSeconds: number;
  mature: boolean;
  strongEvidence: boolean;
}

export interface LadderV13CompletionModel {
  estimate(context: LadderV13CompletionContext): LadderV13CompletionEstimate;
}

// User-supplied clean 89-market cohort, not a promise about future outcomes.
const TIME_PRIORS = [
  { seconds: 30, probability: 0, upperProbability: 0.051 },
  { seconds: 60, probability: 0.014, upperProbability: 0.074 },
  { seconds: 120, probability: 0.028, upperProbability: 0.096 },
  { seconds: 180, probability: 0.029, upperProbability: 0.10 },
  { seconds: 240, probability: 0.083, upperProbability: 0.17 },
  { seconds: 300, probability: 0.113, upperProbability: 0.207 },
  { seconds: 360, probability: 0.153, upperProbability: 0.253 },
  { seconds: 480, probability: 0.23, upperProbability: 0.337 },
  { seconds: 600, probability: 0.274, upperProbability: 0.386 },
] as const;

export const LADDER_V13_COMPLETION_PRIOR_SECONDS = 120;
export const LADDER_V13_TERMINAL_ONE_SIDED = 4 / 23;
export const LADDER_V13_TERMINAL_TWO_SIDED = 12 / 36;

export function ladderV13TimePrior(secondsLeft: number): { probability: number; upperProbability: number } {
  if (secondsLeft <= 30) return { ...TIME_PRIORS[0] };
  for (let index = 1; index < TIME_PRIORS.length; index += 1) {
    const high = TIME_PRIORS[index]!;
    const low = TIME_PRIORS[index - 1]!;
    if (secondsLeft <= high.seconds) {
      const weight = (secondsLeft - low.seconds) / (high.seconds - low.seconds);
      return {
        probability: low.probability + weight * (high.probability - low.probability),
        upperProbability: low.upperProbability + weight * (high.upperProbability - low.upperProbability),
      };
    }
  }
  return { ...TIME_PRIORS[TIME_PRIORS.length - 1]! };
}

function comparable(a: LadderV13CompletionContext, b: LadderV13CompletionContext): boolean {
  const relative = (left: number, right: number, floor: number, factor: number): boolean =>
    Math.max(left, right, floor) / Math.max(floor, Math.min(left, right)) <= factor;
  return relative(a.queueRatio, b.queueRatio, 0.25, 4) &&
    relative(a.flowRatio, b.flowRatio, 0.001, 4) &&
    relative(a.residualShares, b.residualShares, 0.01, 4) &&
    Math.abs(a.distanceTicks - b.distanceTicks) <= 2 &&
    Math.abs(a.residualAgeSeconds - b.residualAgeSeconds) <= 180 &&
    Math.abs(a.secondsRemaining - b.secondsRemaining) <= 120 &&
    Math.abs((a.maximumCompletionPrice - a.completionMakerPrice) -
      (b.maximumCompletionPrice - b.completionMakerPrice)) <= 0.05;
}

/** Completion-only survival learning shared across successive KXBTC15M contracts. */
export class LadderV13CompletionHazardModel implements LadderV13CompletionModel {
  private readonly observations: LadderV13CompletionObservation[];

  constructor(observations: readonly LadderV13CompletionObservation[] = []) {
    this.observations = structuredClone([...observations]);
  }

  observe(observation: LadderV13CompletionObservation): void {
    if (!Number.isFinite(observation.exposureSeconds) || observation.exposureSeconds <= 0) return;
    this.observations.push(structuredClone(observation));
    if (this.observations.length > 10_000) this.observations.splice(0, 1_000);
  }

  estimate(context: LadderV13CompletionContext): LadderV13CompletionEstimate {
    const prior = ladderV13TimePrior(context.secondsRemaining);
    const horizon = Math.max(0.01, context.secondsRemaining);
    const baseline = -Math.log(1 - Math.max(0.0001, prior.probability)) / horizon;
    const tau = LADDER_V13_COMPLETION_PRIOR_SECONDS;
    const globalD = this.observations.filter((observation) => observation.filled).length;
    const globalT = this.observations.reduce((sum, observation) => sum + observation.exposureSeconds, 0);
    const lambda0 = (globalD + baseline * tau) / (globalT + tau);
    const local = this.observations.filter((observation) => comparable(observation.context, context));
    const d = local.filter((observation) => observation.filled).length;
    const t = local.reduce((sum, observation) => sum + observation.exposureSeconds, 0);
    const shape = d + lambda0 * tau;
    const rate = t + tau;
    const hazard = shape / rate;
    // Gamma posterior mean/variance + one-sided Cantelli bound: at least 95%
    // posterior coverage, deliberately more conservative than a normal CI.
    const upperHazard = (shape + Math.sqrt(19 * shape)) / rate;
    let probability = 1 - Math.exp(-hazard * horizon);
    let upperProbability = 1 - Math.exp(-upperHazard * horizon);
    const mature = local.length >= 100 && d >= 20 && t >= 3_600;
    if (this.observations.length === 0) {
      probability = prior.probability;
      upperProbability = prior.upperProbability;
    } else if (!mature) {
      probability = Math.min(probability, prior.probability);
      upperProbability = Math.min(upperProbability, prior.upperProbability);
    }
    upperProbability = Math.max(probability, upperProbability);
    return {
      probability, upperProbability, hazard, comparableOrders: local.length,
      completedOrders: d, exposureSeconds: t, mature,
      strongEvidence: mature && probability > prior.upperProbability,
    };
  }

  getObservationCount(): number { return this.observations.length; }

  toJSON(): LadderV13CompletionObservation[] { return structuredClone(this.observations); }
}

export function ladderV13SellFraction(sellValue: number, waitValue: number, upperWaitValue: number): number {
  if (sellValue <= waitValue) return 0;
  if (sellValue >= upperWaitValue) return 1;
  return Math.max(0, Math.min(1, (sellValue - waitValue) / Math.max(1e-10, upperWaitValue - waitValue)));
}
