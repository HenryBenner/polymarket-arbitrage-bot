/** BTC-only 297-market calibration. Seeds are totals, never reapplied on load. */
export const LIFECYCLE_SEED = "btc-20260910-lifecycle-v1";
export const ENTRY_PRIOR_SECONDS = 300;
export const SIZE_SEED_EXPOSURE_SECONDS = 300;
export const ADVERSE_SEED_EXPOSURE_SECONDS = 300;
const ENTRY = [
  [170, 115, 10021.731],
  [33, 7, 2831.525],
  [134, 69, 11526.64],
  [28, 19, 1321.061],
  [88, 79, 3365.231],
];
const SIZE = [
  0.00804184652, 0.02433978321, 0.01115349593, 0.008533757821, 0.009203984379,
];
const ADVERSE = [
  0.02579419825, 0.008197618647, 0.006291319165, 0.004992683355, 0.004328584513,
  0.001757810455,
];
type Stats = { events: number; seconds: number };
export type MarketEconomics = {
  positivePairPnl: number;
  positivePairShares: number;
  residualNetPnl: number;
  residualShares: number;
};
export type Admission = {
  classification: "reject" | "probe" | "normal";
  qEntry: number;
  qSize: number;
  qOpen: number;
  ev: number;
  quantity: number;
  baselineQuantity: number;
  entryBucket: number;
  sizeBucket: number;
};
export interface LifecycleEpisode {
  m: string;
  s: string;
  token: string;
  t: number;
  p: number;
  shares: number;
  q: number;
  originalQuantity: number;
  h: number;
  q0: number;
  entryBucket: number;
  sizeBucket: number;
  g: number | null;
  ps: number;
  pp: number;
  negative: boolean;
  sold: boolean;
}
export interface LifecycleState extends MarketEconomics {
  seedVersion: string;
  global: Stats;
  entry: Stats[];
  size: Stats[];
  adverse: Stats[];
  qSafe: number;
  postUpdateSettledBtcMarkets: number;
  markets: MarketEconomics[];
  finalized: string[];
  active: Record<string, LifecycleEpisode>;
  processed: Record<string, string[]>;
  openings: Record<string, Admission>;
  verdicts: Record<string, string>;
  counts: {
    rejectCandidates: number;
    probeCandidates: number;
    normalCandidates: number;
    episodes: number;
    profitableCompletions: number;
    executionAnomalies: number;
  };
}
export const entryBucket = (p: number) =>
  [0.1, 0.3, 0.7, 0.9].filter((b) => p >= b).length;
export const sizeBucket = (q: number) =>
  [10, 25, 50, 100].filter((b) => q >= b).length;
export const adverseBucket = (g: number) =>
  [0, 0.01, 0.03, 0.05, 0.1].filter((b) => g >= b).length;
const probability = (lambda: number, h: number) =>
  Math.max(0, Math.min(1, -Math.expm1(-lambda * Math.max(0, h))));
const stats = (n: number): Stats[] =>
  Array.from({ length: n }, () => ({ events: 0, seconds: 0 }));
export class LadderV14LifecycleModel {
  readonly state: LifecycleState;
  constructor(state?: LifecycleState) {
    if (state && state.seedVersion !== LIFECYCLE_SEED)
      throw new Error("Unsupported V14 lifecycle seed");
    this.state = state
      ? structuredClone(state)
      : {
          seedVersion: LIFECYCLE_SEED,
          global: { events: 0, seconds: 0 },
          entry: stats(5),
          size: stats(5),
          adverse: stats(6),
          positivePairPnl: 708.0138494,
          positivePairShares: 19054.55,
          residualNetPnl: -621.054,
          residualShares: 3336.54,
          qSafe: 0.883052345,
          postUpdateSettledBtcMarkets: 0,
          markets: [],
          finalized: [],
          active: {},
          processed: {},
          openings: {},
          verdicts: {},
          counts: {
            rejectCandidates: 0,
            probeCandidates: 0,
            normalCandidates: 0,
            episodes: 0,
            profitableCompletions: 0,
            executionAnomalies: 0,
          },
        };
  }
  get G() {
    return this.state.positivePairPnl / this.state.positivePairShares;
  }
  get L() {
    return Math.max(0, -this.state.residualNetPnl / this.state.residualShares);
  }
  get qBreakEven() {
    return this.G <= 0 ? 1 : this.L / (this.L + this.G);
  }
  get qSafe() {
    return Math.max(this.state.qSafe, this.qBreakEven);
  }
  get lambdaGlobal() {
    return (
      (310 + this.state.global.events) / (29066.484 + this.state.global.seconds)
    );
  }
  entryHazard(bucket: number) {
    const seed = ENTRY[bucket]!,
      online = this.state.entry[bucket]!;
    return (
      (seed[1]! + online.events + this.lambdaGlobal * ENTRY_PRIOR_SECONDS) /
      (seed[2]! + online.seconds + ENTRY_PRIOR_SECONDS)
    );
  }
  // Raw historical size/adverse counts are unavailable: these are Poisson
  // priors with exactly 300 seconds of exposure, not invented observations.
  sizeHazard(bucket: number) {
    const online = this.state.size[bucket]!;
    return (
      (SIZE[bucket]! * SIZE_SEED_EXPOSURE_SECONDS + online.events) /
      (SIZE_SEED_EXPOSURE_SECONDS + online.seconds)
    );
  }
  adverseHazard(bucket: number) {
    const online = this.state.adverse[bucket]!;
    return (
      (ADVERSE[bucket]! * ADVERSE_SEED_EXPOSURE_SECONDS + online.events) /
      (ADVERSE_SEED_EXPOSURE_SECONDS + online.seconds)
    );
  }
  repair(gap: number | null, h: number) {
    return gap === null
      ? null
      : probability(this.adverseHazard(adverseBucket(gap)), h);
  }
  recordCandidate(
    key: string,
    price: number,
    baseline: number,
    admission: Admission,
  ) {
    const signature = JSON.stringify([
      price,
      baseline,
      admission.classification,
    ]);
    if (this.state.verdicts[key] === signature) return;
    this.state.verdicts[key] = signature;
    this.state.counts[`${admission.classification}Candidates`]++;
  }
  risk(q: number | null) {
    return q === null
      ? null
      : q < this.qBreakEven
        ? "poor"
        : q < this.qSafe
          ? "borderline"
          : "healthy";
  }
  evaluate(
    price: number,
    baseline: number,
    h: number,
    minimum: number,
    probe = 10,
  ): Admission {
    const eb = entryBucket(price),
      sb = sizeBucket(baseline);
    const qEntry = probability(this.entryHazard(eb), h),
      qSize = probability(this.sizeHazard(sb), h),
      qOpen = Math.min(qEntry, qSize);
    let classification: Admission["classification"] =
      this.G <= 0 || qOpen < this.qBreakEven
        ? "reject"
        : qOpen < this.qSafe
          ? "probe"
          : "normal";
    const quantity =
      classification === "probe" ? Math.min(baseline, probe) : baseline;
    if (
      !Number.isFinite(price) ||
      price < 0 ||
      price > 1 ||
      !Number.isFinite(baseline) ||
      quantity < minimum
    )
      classification = "reject";
    return {
      classification,
      qEntry,
      qSize,
      qOpen,
      ev: qOpen * this.G - (1 - qOpen) * this.L,
      quantity: classification === "reject" ? 0 : quantity,
      baselineQuantity: baseline,
      entryBucket: eb,
      sizeBucket: sb,
    };
  }
  close(
    episode: LifecycleEpisode,
    end: number,
    outcome: "p" | "r" | "s" | "n" | "c",
    residualShares = 0,
    residualPnl = 0,
  ) {
    const seconds = Math.max(0, end - episode.t),
      event = outcome === "p" ? 1 : 0;
    for (const row of [
      this.state.global,
      this.state.entry[episode.entryBucket]!,
      this.state.size[episode.sizeBucket]!,
      ...(episode.g === null
        ? []
        : [this.state.adverse[adverseBucket(episode.g)]!]),
    ]) {
      row.seconds += seconds;
      row.events += event;
    }
    this.state.counts.episodes++;
    this.state.counts.profitableCompletions += event;
    if (outcome === "n") this.state.counts.executionAnomalies++;
    delete this.state.active[episode.m];
    return {
      e: "v14_ep",
      m: episode.m,
      s: episode.s,
      t: episode.t,
      p: episode.p,
      q: episode.q,
      h: episode.h,
      q0: episode.q0,
      ...(episode.g === null ? {} : { g: episode.g }),
      d: seconds,
      o: outcome,
      ps: episode.ps,
      pp: episode.pp,
      rs: residualShares,
      rp: residualPnl,
    };
  }
  settle(slug: string, economics: MarketEconomics) {
    if (this.state.finalized.includes(slug)) return;
    this.state.finalized.push(slug);
    for (const key of [
      "positivePairPnl",
      "positivePairShares",
      "residualNetPnl",
      "residualShares",
    ] as const)
      this.state[key] += economics[key];
    this.state.markets.push(economics);
    if (this.state.markets.length > 1000) this.state.markets.shift();
    const count = ++this.state.postUpdateSettledBtcMarkets;
    if (count >= 300 && (count - 300) % 50 === 0) this.bootstrap();
    delete this.state.processed[slug];
    for (const key of Object.keys(this.state.verdicts))
      if (key.startsWith(`${slug}|`)) delete this.state.verdicts[key];
  }
  private bootstrap() {
    const markets = this.state.markets;
    // No valid resample exists if the entire window has no terminal residuals.
    if (!markets.some((m) => m.residualShares > 0)) return;
    let seed = 140297 + this.state.postUpdateSettledBtcMarkets;
    const random = () => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const qs: number[] = [];
    while (qs.length < 50000) {
      let pp = 0,
        ps = 0,
        rp = 0,
        rs = 0;
      for (let i = 0; i < markets.length; i++) {
        const m = markets[Math.floor(random() * markets.length)]!;
        pp += m.positivePairPnl;
        ps += m.positivePairShares;
        rp += m.residualNetPnl;
        rs += m.residualShares;
      }
      if (rs <= 0) continue;
      const g = ps > 0 ? pp / ps : 0,
        l = Math.max(0, -rp / rs);
      qs.push(g <= 0 ? 1 : l / (l + g));
    }
    qs.sort((a, b) => a - b);
    this.state.qSafe = Math.min(1, Math.max(this.qBreakEven, qs[48749]!));
  }
  summary() {
    return {
      ...this.state.counts,
      qBreakEven: this.qBreakEven,
      qSafe: this.qSafe,
      G: this.G,
      L: this.L,
      lambdaGlobal: this.lambdaGlobal,
    };
  }
  toJSON() {
    return structuredClone(this.state);
  }
}
