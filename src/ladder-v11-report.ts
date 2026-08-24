import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  LadderV11DecisionRecord,
  LadderV11State,
} from "./ladder-v11-regime.js";

const EPSILON = 1e-9;

interface CohortMetrics {
  count: number;
  pnl: number;
  averagePnl: number | null;
}

export interface LadderV11Report {
  totalV11Pnl: number;
  pnlPerQualifyingMarket: number | null;
  qualifyingMarkets: number;
  allBtcMarkets: number;
  percentMarketsTraded: number;
  pair: CohortMetrics & { rateConditionalOnFavoriteFill: number };
  favoriteOnly: CohortMetrics & { winRate: number | null };
  cheapOnly: CohortMetrics;
  maxDrawdown: number;
  shadowControls: {
    v7Pnl: number;
    v10LegacyScorePnl: number;
  };
  diagnostics: {
    decisionsOverOneSecondBeforeRecalculation: number;
    staleExecutions: number;
    favoriteFillsBelow50: number;
    nonBrtiTrades: number;
  };
}

function round(value: number, places = 8): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function fillsFor(record: LadderV11DecisionRecord, tokenId: string): number {
  return record.observedFills
    .filter((fill) => fill.tokenId === tokenId)
    .reduce((sum, fill) => sum + fill.size, 0);
}

function cohort(records: LadderV11DecisionRecord[]): CohortMetrics {
  const pnl = round(
    records.reduce((sum, record) => sum + (record.actualPnl ?? 0), 0),
  );
  return {
    count: records.length,
    pnl,
    averagePnl: records.length === 0 ? null : round(pnl / records.length),
  };
}

function maximumDrawdown(records: LadderV11DecisionRecord[]): number {
  const ordered = [...records].sort((left, right) =>
    (left.settledAt ?? "").localeCompare(right.settledAt ?? ""),
  );
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const record of ordered) {
    equity += record.actualPnl ?? 0;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return round(drawdown);
}

export function buildLadderV11Report(
  input: LadderV11State | LadderV11DecisionRecord[],
): LadderV11Report {
  const all = Array.isArray(input) ? input : Object.values(input.decisions);
  const settled = all.filter((record) => record.settledAt !== undefined);
  const qualifying = settled.filter((record) => record.qualified);
  const withExposure = qualifying.map((record) => {
    const favorite = fillsFor(record, record.finalDecision.favoriteTokenId);
    const cheap = fillsFor(record, record.initialDecision.cheapTokenId);
    return { record, favorite, cheap };
  });
  const pairs = withExposure
    .filter(({ favorite, cheap }) => favorite > EPSILON && cheap > EPSILON)
    .map(({ record }) => record);
  const favoriteOnly = withExposure
    .filter(({ favorite, cheap }) => favorite > EPSILON && cheap <= EPSILON)
    .map(({ record }) => record);
  const cheapOnly = withExposure
    .filter(({ favorite, cheap }) => favorite <= EPSILON && cheap > EPSILON)
    .map(({ record }) => record);
  const favoriteFillMarkets = withExposure.filter(
    ({ favorite }) => favorite > EPSILON,
  ).length;
  const totalV11Pnl = round(
    qualifying.reduce((sum, record) => sum + (record.actualPnl ?? 0), 0),
  );
  const favoriteOnlyWins = favoriteOnly.filter(
    (record) => record.winningTokenId === record.finalDecision.favoriteTokenId,
  ).length;
  return {
    totalV11Pnl,
    pnlPerQualifyingMarket:
      qualifying.length === 0 ? null : round(totalV11Pnl / qualifying.length),
    qualifyingMarkets: qualifying.length,
    allBtcMarkets: settled.length,
    percentMarketsTraded:
      settled.length === 0 ? 0 : round((100 * qualifying.length) / settled.length),
    pair: {
      ...cohort(pairs),
      rateConditionalOnFavoriteFill:
        favoriteFillMarkets === 0 ? 0 : round(pairs.length / favoriteFillMarkets),
    },
    favoriteOnly: {
      ...cohort(favoriteOnly),
      winRate:
        favoriteOnly.length === 0
          ? null
          : round(favoriteOnlyWins / favoriteOnly.length),
    },
    cheapOnly: cohort(cheapOnly),
    maxDrawdown: maximumDrawdown(qualifying),
    shadowControls: {
      v7Pnl: round(
        settled.reduce(
          (sum, record) => sum + (record.counterfactualV7Pnl ?? 0),
          0,
        ),
      ),
      v10LegacyScorePnl: round(
        settled.reduce(
          (sum, record) => sum + (record.counterfactualV10Pnl ?? 0),
          0,
        ),
      ),
    },
    diagnostics: {
      decisionsOverOneSecondBeforeRecalculation: all.filter(
        (record) => record.staleDecisionRecalculated,
      ).length,
      staleExecutions: all.filter(
        (record) =>
          record.orderSubmittedAt !== undefined &&
          (record.decisionAgeMs ?? Number.POSITIVE_INFINITY) > 1_000,
      ).length,
      favoriteFillsBelow50: all.reduce(
        (sum, record) => sum + record.favoriteFillBelow50Count,
        0,
      ),
      nonBrtiTrades: all.reduce(
        (sum, record) => sum + record.nonBrtiExecutionCount,
        0,
      ),
    },
  };
}

async function main(): Promise<void> {
  const requested =
    process.argv[2] ?? process.env.PAPER_STATE_PATH ?? "./data/paper-ladder-v11-btc";
  const path = requested.endsWith(".json")
    ? resolve(requested)
    : resolve(requested, "ladder-v11-regime-state.json");
  const state = JSON.parse(await readFile(path, "utf8")) as LadderV11State;
  console.log(JSON.stringify(buildLadderV11Report(state), null, 2));
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) await main();
