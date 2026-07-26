import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PaperFill, PaperSettlement } from "./types.js";

export interface PaperLedger {
  fills: PaperFill[];
  settlements: PaperSettlement[];
}

interface MarketResult {
  marketSlug: string;
  spent: number;
  preFeePnl: number;
  takerFees: number;
  estimatedMakerRebate: number;
  tradingPnl: number;
  adjustedPnl: number;
  makerFills: number;
  takerFills: number;
  makerNotional: number;
  takerNotional: number;
  twoSided: boolean;
}

export interface StrategyMetrics {
  markets: number;
  totalSpent: number;
  averageSpent: number;
  preFeePnl: number;
  takerFees: number;
  estimatedMakerRebate: number;
  tradingPnl: number;
  adjustedPnl: number;
  adjustedRoi: number;
  wins: number;
  losses: number;
  averageWinner: number;
  averageLoss: number;
  winLossRatio: number | null;
  profitFactor: number | null;
  makerFillShare: number;
  makerNotionalShare: number;
  twoSidedMarketShare: number;
  maxDrawdown: number;
  worstMarket: { marketSlug: string; adjustedPnl: number } | null;
}

export interface StrategyComparison {
  commonMarkets: number;
  requiredMarkets: number;
  baseline: StrategyMetrics;
  candidate: StrategyMetrics;
  adjustedPnlDifference: number;
  pairedMeanDifference: number;
  pairedBootstrap95: { low: number; high: number };
  winner: "baseline" | "candidate" | "tie";
}

const CRYPTO_FEE_RATE = 0.07;
const CRYPTO_REBATE_RATE = 0.2;

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function makerRebate(fill: PaperFill): number {
  if (fill.liquidity !== "maker") return 0;
  if (fill.estimatedMakerRebate !== undefined) {
    return fill.estimatedMakerRebate;
  }
  const feeEquivalent =
    fill.makerFeeEquivalent ??
    fill.size * CRYPTO_FEE_RATE * fill.price * (1 - fill.price);
  return feeEquivalent * CRYPTO_REBATE_RATE;
}

function marketResult(
  settlement: PaperSettlement,
  fills: readonly PaperFill[],
): MarketResult {
  const marketFills = fills.filter(
    (fill) => fill.marketSlug === settlement.marketSlug,
  );
  const maker = marketFills.filter((fill) => fill.liquidity === "maker");
  const taker = marketFills.filter((fill) => fill.liquidity === "taker");
  const estimatedMakerRebate = maker.reduce(
    (sum, fill) => sum + makerRebate(fill),
    0,
  );
  const takerFees = taker.reduce((sum, fill) => sum + fill.fee, 0);
  const makerNotional = maker.reduce(
    (sum, fill) => sum + fill.price * fill.size,
    0,
  );
  const takerNotional = taker.reduce(
    (sum, fill) => sum + fill.price * fill.size,
    0,
  );
  const tradingPnl = settlement.payout - settlement.totalCost - settlement.totalFees;
  return {
    marketSlug: settlement.marketSlug,
    spent: settlement.totalCost + settlement.totalFees,
    preFeePnl: settlement.payout - settlement.totalCost,
    takerFees,
    estimatedMakerRebate,
    tradingPnl,
    adjustedPnl: tradingPnl + estimatedMakerRebate,
    makerFills: maker.length,
    takerFills: taker.length,
    makerNotional,
    takerNotional,
    twoSided: new Set(marketFills.map((fill) => fill.outcome)).size >= 2,
  };
}

function summarize(results: readonly MarketResult[]): StrategyMetrics {
  const totalSpent = results.reduce((sum, result) => sum + result.spent, 0);
  const adjustedPnl = results.reduce(
    (sum, result) => sum + result.adjustedPnl,
    0,
  );
  const winners = results.filter((result) => result.adjustedPnl > 0);
  const losers = results.filter((result) => result.adjustedPnl < 0);
  const grossProfit = winners.reduce(
    (sum, result) => sum + result.adjustedPnl,
    0,
  );
  const grossLoss = Math.abs(
    losers.reduce((sum, result) => sum + result.adjustedPnl, 0),
  );
  const makerFills = results.reduce(
    (sum, result) => sum + result.makerFills,
    0,
  );
  const takerFills = results.reduce(
    (sum, result) => sum + result.takerFills,
    0,
  );
  const makerNotional = results.reduce(
    (sum, result) => sum + result.makerNotional,
    0,
  );
  const takerNotional = results.reduce(
    (sum, result) => sum + result.takerNotional,
    0,
  );
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const result of results) {
    running += result.adjustedPnl;
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);
  }
  const worst = results.reduce<MarketResult | null>(
    (current, result) =>
      current === null || result.adjustedPnl < current.adjustedPnl
        ? result
        : current,
    null,
  );
  const averageWinner =
    winners.length > 0 ? grossProfit / winners.length : 0;
  const averageLoss = losers.length > 0 ? grossLoss / losers.length : 0;
  const fillTotal = makerFills + takerFills;
  const notionalTotal = makerNotional + takerNotional;
  return {
    markets: results.length,
    totalSpent: round(totalSpent),
    averageSpent: round(results.length > 0 ? totalSpent / results.length : 0),
    preFeePnl: round(
      results.reduce((sum, result) => sum + result.preFeePnl, 0),
    ),
    takerFees: round(
      results.reduce((sum, result) => sum + result.takerFees, 0),
    ),
    estimatedMakerRebate: round(
      results.reduce(
        (sum, result) => sum + result.estimatedMakerRebate,
        0,
      ),
    ),
    tradingPnl: round(
      results.reduce((sum, result) => sum + result.tradingPnl, 0),
    ),
    adjustedPnl: round(adjustedPnl),
    adjustedRoi: round(totalSpent > 0 ? adjustedPnl / totalSpent : 0, 6),
    wins: winners.length,
    losses: losers.length,
    averageWinner: round(averageWinner),
    averageLoss: round(averageLoss),
    winLossRatio:
      averageLoss > 0 ? round(averageWinner / averageLoss, 4) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    makerFillShare: round(fillTotal > 0 ? makerFills / fillTotal : 0, 6),
    makerNotionalShare: round(
      notionalTotal > 0 ? makerNotional / notionalTotal : 0,
      6,
    ),
    twoSidedMarketShare: round(
      results.length > 0
        ? results.filter((result) => result.twoSided).length / results.length
        : 0,
      6,
    ),
    maxDrawdown: round(maxDrawdown),
    worstMarket: worst
      ? {
          marketSlug: worst.marketSlug,
          adjustedPnl: round(worst.adjustedPnl),
        }
      : null,
  };
}

function marketTime(slug: string): number {
  const value = Number(slug.match(/(\d+)$/)?.[1] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bootstrap95(
  differences: readonly number[],
  iterations = 10_000,
): { low: number; high: number } {
  if (differences.length === 0) return { low: 0, high: 0 };
  const random = mulberry32(0x0da40a);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(random() * differences.length)] ?? 0;
    }
    means.push(total / differences.length);
  }
  means.sort((left, right) => left - right);
  return {
    low: round(means[Math.floor(iterations * 0.025)] ?? 0),
    high: round(means[Math.floor(iterations * 0.975)] ?? 0),
  };
}

export function comparePaperStrategies(
  baseline: PaperLedger,
  candidate: PaperLedger,
  requiredMarkets = 100,
): StrategyComparison {
  const baselineSettlements = new Map(
    baseline.settlements.map((settlement) => [
      settlement.marketSlug,
      settlement,
    ]),
  );
  const candidateSettlements = new Map(
    candidate.settlements.map((settlement) => [
      settlement.marketSlug,
      settlement,
    ]),
  );
  const common = [...baselineSettlements.keys()]
    .filter((slug) => candidateSettlements.has(slug))
    .sort((left, right) => marketTime(left) - marketTime(right))
    .slice(0, requiredMarkets);
  const baselineResults = common.map((slug) =>
    marketResult(baselineSettlements.get(slug)!, baseline.fills),
  );
  const candidateResults = common.map((slug) =>
    marketResult(candidateSettlements.get(slug)!, candidate.fills),
  );
  const differences = candidateResults.map(
    (result, index) =>
      result.adjustedPnl - (baselineResults[index]?.adjustedPnl ?? 0),
  );
  const baselineMetrics = summarize(baselineResults);
  const candidateMetrics = summarize(candidateResults);
  const adjustedPnlDifference =
    candidateMetrics.adjustedPnl - baselineMetrics.adjustedPnl;
  return {
    commonMarkets: common.length,
    requiredMarkets,
    baseline: baselineMetrics,
    candidate: candidateMetrics,
    adjustedPnlDifference: round(adjustedPnlDifference),
    pairedMeanDifference: round(
      differences.length > 0
        ? differences.reduce((sum, difference) => sum + difference, 0) /
            differences.length
        : 0,
    ),
    pairedBootstrap95: bootstrap95(differences),
    winner:
      Math.abs(adjustedPnlDifference) < 0.005
        ? "tie"
        : adjustedPnlDifference > 0
          ? "candidate"
          : "baseline",
  };
}

async function loadLedger(path: string): Promise<PaperLedger> {
  const statePath = path.endsWith(".json")
    ? resolve(path)
    : resolve(path, "paper-state.json");
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<PaperLedger>;
  return {
    fills: parsed.fills ?? [],
    settlements: parsed.settlements ?? [],
  };
}

async function main(): Promise<void> {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) {
    throw new Error(
      "Usage: npm run compare:strategies -- <baseline-state-dir> <candidate-state-dir>",
    );
  }
  const comparison = comparePaperStrategies(
    await loadLedger(baselinePath),
    await loadLedger(candidatePath),
  );
  console.table({
    baseline: comparison.baseline,
    candidate: comparison.candidate,
  });
  console.log(JSON.stringify(comparison, null, 2));
  if (comparison.commonMarkets < comparison.requiredMarkets) {
    process.exitCode = 2;
    console.error(
      `Need ${comparison.requiredMarkets} common settlements; found ${comparison.commonMarkets}.`,
    );
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  await main();
}
