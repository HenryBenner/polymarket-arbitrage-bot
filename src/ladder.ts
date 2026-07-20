import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig } from "./config.js";
import type {
  LadderPhase,
  LadderPhaseLock,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";

const SHARE_STEP_HUNDREDTHS = 1;
const MINIMUM_ORDER_CENTS = 100;

export const ODAHOA_V1_PHASES: readonly LadderPhase[] = [
  {
    id: "15-10",
    minutesLeftMin: 10,
    minutesLeftMax: 15,
    rungs: [
      { lowPrice: 0.45, highPrice: 0.55 },
      { lowPrice: 0.4, highPrice: 0.6 },
    ],
  },
  {
    id: "10-5",
    minutesLeftMin: 5,
    minutesLeftMax: 10,
    rungs: [
      { lowPrice: 0.35, highPrice: 0.65 },
      { lowPrice: 0.3, highPrice: 0.7 },
      { lowPrice: 0.25, highPrice: 0.75 },
    ],
  },
  {
    id: "5-2",
    minutesLeftMin: 2,
    minutesLeftMax: 5,
    rungs: [
      { lowPrice: 0.2, highPrice: 0.8 },
      { lowPrice: 0.15, highPrice: 0.85 },
      { lowPrice: 0.1, highPrice: 0.9 },
    ],
  },
  {
    id: "2-0",
    minutesLeftMin: 0,
    minutesLeftMax: 2,
    rungs: [{ lowPrice: 0.05, highPrice: 0.95 }],
  },
] as const;

interface LadderTrackerState {
  version: 1;
  locks: Record<string, LadderPhaseLock>;
  submittedKeys: string[];
  exposureBlockedMarkets: string[];
}

function emptyState(): LadderTrackerState {
  return {
    version: 1,
    locks: {},
    submittedKeys: [],
    exposureBlockedMarkets: [],
  };
}

function phaseLockKey(marketSlug: string, phaseId: string): string {
  return `${marketSlug}:${phaseId}`;
}

function cents(price: number): number {
  return Math.round(price * 100);
}

function hundredths(shares: number): number {
  return Math.ceil((shares * 100 - Number.EPSILON) / SHARE_STEP_HUNDREDTHS);
}

export function minimumShares(
  price: number,
  clobMinimumShares = 0,
): number {
  const priceCents = cents(price);
  if (priceCents <= 0) {
    throw new Error(`Ladder price must be positive: ${price}`);
  }

  const minimumForDollar = Math.ceil(
    (MINIMUM_ORDER_CENTS * 100) / priceCents,
  );
  const minimumForClob = hundredths(clobMinimumShares);
  return (
    Math.max(minimumForDollar, minimumForClob) *
    SHARE_STEP_HUNDREDTHS /
    100
  );
}

export function pairedShares(
  lowPrice: number,
  highPrice: number,
  lowMinimumShares: number,
  highMinimumShares: number,
  scale: number,
): number {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error("Ladder scale must be an integer of at least 1");
  }
  const baseHundredths = Math.max(
    hundredths(minimumShares(lowPrice, lowMinimumShares)),
    hundredths(minimumShares(highPrice, highMinimumShares)),
  );
  return (baseHundredths * scale) / 100;
}

export function projectedLadderCapital(
  scale: number,
  minimumSharesByPrice: ReadonlyMap<number, number> = new Map(),
): number {
  const totalCents = ODAHOA_V1_PHASES.flatMap((phase) => phase.rungs).reduce(
    (sum, rung) => {
      const shares = pairedShares(
        rung.lowPrice,
        rung.highPrice,
        minimumSharesByPrice.get(rung.lowPrice) ?? 0,
        minimumSharesByPrice.get(rung.highPrice) ?? 0,
        scale,
      );
      return sum + Math.round(shares * (cents(rung.lowPrice) + cents(rung.highPrice)));
    },
    0,
  );
  return totalCents / 100;
}

export function ladderPhaseAt(
  event: UpDownEvent,
  nowSeconds = Date.now() / 1000,
): LadderPhase | null {
  const minutesLeft = (event.windowEnd - nowSeconds) / 60;
  return (
    ODAHOA_V1_PHASES.find((phase) => {
      const isFinalPhase = phase.id === "2-0";
      const belowUpperBoundary = minutesLeft <= phase.minutesLeftMax;
      const aboveLowerBoundary = isFinalPhase
        ? minutesLeft >= phase.minutesLeftMin
        : minutesLeft > phase.minutesLeftMin;
      return aboveLowerBoundary && belowUpperBoundary;
    }) ?? null
  );
}

export class LadderTracker {
  private state = emptyState();
  private readonly submittedKeys = new Set<string>();
  private readonly blockedMarkets = new Set<string>();
  private readonly statePath: string;

  constructor(stateDirectory: string) {
    this.statePath = join(stateDirectory, "ladder-state.json");
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as LadderTrackerState;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported ladder state version: ${parsed.version}`);
      }
      this.state = parsed;
      for (const key of parsed.submittedKeys) this.submittedKeys.add(key);
      for (const slug of parsed.exposureBlockedMarkets) {
        this.blockedMarkets.add(slug);
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  getLock(marketSlug: string, phaseId: string): LadderPhaseLock | undefined {
    return this.state.locks[phaseLockKey(marketSlug, phaseId)];
  }

  async lockPhase(
    event: UpDownEvent,
    phase: LadderPhase,
    books: TokenBook[],
  ): Promise<LadderPhaseLock | null> {
    const existing = this.getLock(event.slug, phase.id);
    if (existing) return existing;

    const complete = books.filter((book) => book.bestAsk !== null);
    if (complete.length !== 2) return null;

    const ranked = [...complete].sort((left, right) => {
      const difference = (left.bestAsk ?? 1) - (right.bestAsk ?? 1);
      return difference !== 0
        ? difference
        : left.outcomeIndex - right.outcomeIndex;
    });
    const cheap = ranked[0];
    const favorite = ranked[1];
    if (!cheap || !favorite) return null;

    const lock: LadderPhaseLock = {
      marketSlug: event.slug,
      phaseId: phase.id,
      cheapTokenId: cheap.tokenId,
      cheapOutcome: cheap.outcome,
      favoriteTokenId: favorite.tokenId,
      favoriteOutcome: favorite.outcome,
      createdAt: new Date().toISOString(),
    };
    this.state.locks[phaseLockKey(event.slug, phase.id)] = lock;
    await this.persist();
    return lock;
  }

  makeKey(
    marketSlug: string,
    phaseId: string,
    outcome: string,
    price: number,
  ): string {
    return `${marketSlug}:${phaseId}:${outcome}:${price.toFixed(2)}`;
  }

  has(key: string): boolean {
    return this.submittedKeys.has(key);
  }

  async mark(key: string): Promise<void> {
    if (this.submittedKeys.has(key)) return;
    this.submittedKeys.add(key);
    this.state.submittedKeys = [...this.submittedKeys];
    await this.persist();
  }

  isExposureBlocked(marketSlug: string): boolean {
    return this.blockedMarkets.has(marketSlug);
  }

  async blockExposure(marketSlug: string): Promise<void> {
    if (this.blockedMarkets.has(marketSlug)) return;
    this.blockedMarkets.add(marketSlug);
    this.state.exposureBlockedMarkets = [...this.blockedMarkets];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    const serialized = JSON.stringify(this.state, null, 2);
    await writeFile(temporaryPath, serialized, "utf8");
    try {
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await writeFile(this.statePath, serialized, "utf8");
      await rm(temporaryPath, { force: true });
    }
  }
}

export async function findLadderOpportunities(
  config: BotConfig,
  tracker: LadderTracker,
  event: UpDownEvent,
  books: TokenBook[],
  nowSeconds = Date.now() / 1000,
): Promise<TradeOpportunity[]> {
  const phase = ladderPhaseAt(event, nowSeconds);
  if (!phase) return [];

  const lock = await tracker.lockPhase(event, phase, books);
  if (!lock) return [];

  const cheap = books.find((book) => book.tokenId === lock.cheapTokenId);
  const favorite = books.find((book) => book.tokenId === lock.favoriteTokenId);
  if (!cheap || !favorite) return [];

  const opportunities: TradeOpportunity[] = [];
  for (const rung of phase.rungs) {
    const size = pairedShares(
      rung.lowPrice,
      rung.highPrice,
      cheap.minOrderSize,
      favorite.minOrderSize,
      config.ladderSizeScale,
    );
    if (
      size * rung.lowPrice + 1e-9 < 1 ||
      size * rung.highPrice + 1e-9 < 1 ||
      size + 1e-9 < cheap.minOrderSize ||
      size + 1e-9 < favorite.minOrderSize
    ) {
      continue;
    }

    const pairId = `${rung.lowPrice.toFixed(2)}-${rung.highPrice.toFixed(2)}`;
    const definitions = [
      { token: cheap, price: rung.lowPrice, kind: "cheap" as const },
      { token: favorite, price: rung.highPrice, kind: "expensive" as const },
    ];

    for (const { token, price, kind } of definitions) {
      const tradeKey = tracker.makeKey(
        event.slug,
        phase.id,
        token.outcome,
        price,
      );
      if (tracker.has(tradeKey)) continue;
      opportunities.push({
        kind,
        event,
        token,
        price,
        size,
        tickSize: tickSizeFromMarket(event.market),
        negRisk: event.market.negRisk,
        tradeKey,
        strategyMode: "odahoa_ladder",
        phaseId: phase.id,
        pairId,
      });
    }
  }

  return opportunities;
}
