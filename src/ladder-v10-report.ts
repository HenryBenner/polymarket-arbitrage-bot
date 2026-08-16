import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LadderV10Decision } from "./ladder-v10-regime.js";

type ExposureCohort = "neither" | "favorite_only" | "cheap_only" | "paired";

interface ReportRow {
  markets: number;
  tradedMarkets: number;
  noTradeMarkets: number;
  actualPnl: number;
  v7CounterfactualPnl: number;
  pnlSavedOrLost: number;
  actualWins: number;
  actualLosses: number;
  actualWinRate: number;
}

export interface LadderV10Report {
  scoreVersion: string;
  settledMarkets: number;
  settledAdaptiveMarkets: number;
  evaluationMinimum: 300;
  evaluationReady: boolean;
  overall: ReportRow;
  trailing100: ReportRow;
  cohorts: {
    scoreBand: Record<string, ReportRow>;
    source: Record<string, ReportRow>;
    fallbackStatus: Record<string, ReportRow>;
    pairFormation: Record<string, ReportRow>;
    exposure: Record<string, ReportRow>;
  };
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function fillsByToken(decision: LadderV10Decision, tokenId: string): number {
  return decision.observedFills
    .filter((fill) => fill.tokenId === tokenId)
    .reduce((sum, fill) => sum + fill.size, 0);
}

function exposure(decision: LadderV10Decision): ExposureCohort {
  const cheap = fillsByToken(decision, decision.cheapTokenId);
  const favorite = fillsByToken(decision, decision.favoriteTokenId);
  if (cheap > 0 && favorite > 0) return "paired";
  if (cheap > 0) return "cheap_only";
  if (favorite > 0) return "favorite_only";
  return "neither";
}

function pairFormation(decision: LadderV10Decision): string {
  const cheap = fillsByToken(decision, decision.cheapTokenId);
  const favorite = fillsByToken(decision, decision.favoriteTokenId);
  if (cheap <= 0 || favorite <= 0) return "unpaired";
  return Math.abs(cheap - favorite) < 1e-8 ? "balanced_pair" : "partial_pair";
}

function summarize(decisions: readonly LadderV10Decision[]): ReportRow {
  const actualPnl = decisions.reduce(
    (sum, decision) => sum + (decision.actualPnl ?? 0),
    0,
  );
  const v7CounterfactualPnl = decisions.reduce(
    (sum, decision) => sum + (decision.counterfactualV7Pnl ?? 0),
    0,
  );
  // A V10 decision may deliberately place no position. Treating those $0
  // outcomes as losses makes the displayed win rate incomparable with V7's
  // executed-position rate, so only realized gains and losses form the rate.
  const wins = decisions.filter((decision) => (decision.actualPnl ?? 0) > 0).length;
  const losses = decisions.filter((decision) => (decision.actualPnl ?? 0) < 0).length;
  const tradedMarkets = wins + losses;
  return {
    markets: decisions.length,
    tradedMarkets,
    noTradeMarkets: decisions.length - tradedMarkets,
    actualPnl: round(actualPnl),
    v7CounterfactualPnl: round(v7CounterfactualPnl),
    pnlSavedOrLost: round(actualPnl - v7CounterfactualPnl),
    actualWins: wins,
    actualLosses: losses,
    actualWinRate: tradedMarkets === 0 ? 0 : round(wins / tradedMarkets),
  };
}

function grouped(
  decisions: readonly LadderV10Decision[],
  keyFor: (decision: LadderV10Decision) => string,
): Record<string, ReportRow> {
  const groups = new Map<string, LadderV10Decision[]>();
  for (const decision of decisions) {
    const key = keyFor(decision);
    const values = groups.get(key) ?? [];
    values.push(decision);
    groups.set(key, values);
  }
  return Object.fromEntries(
    [...groups].sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, values]) => [key, summarize(values)],
    ),
  );
}

export function buildLadderV10Report(
  decisions: readonly LadderV10Decision[],
  scoreLow = 40,
  scoreHigh = 70,
): LadderV10Report {
  const settled = decisions
    .filter(
      (decision) =>
        decision.settledAt !== undefined &&
        decision.actualPnl !== undefined &&
        decision.counterfactualV7Pnl !== undefined,
    )
    .sort(
      (left, right) =>
        Date.parse(left.settledAt!) - Date.parse(right.settledAt!),
    );
  const scoreBand = (decision: LadderV10Decision): string => {
    if (!decision.scoreValid || decision.score === null) return "invalid";
    if (decision.score < scoreLow) return `below_${scoreLow}`;
    if (decision.score < scoreHigh) return `${scoreLow}_to_${scoreHigh - 1}`;
    return `${scoreHigh}_plus`;
  };
  const settledAdaptiveMarkets = settled.filter(
    (decision) => decision.decisionReason === "adaptive",
  ).length;
  return {
    scoreVersion: settled.at(-1)?.scoreVersion ?? "v10-heuristic-1",
    settledMarkets: settled.length,
    settledAdaptiveMarkets,
    evaluationMinimum: 300,
    evaluationReady: settledAdaptiveMarkets >= 300,
    overall: summarize(settled),
    trailing100: summarize(settled.slice(-100)),
    cohorts: {
      scoreBand: grouped(settled, scoreBand),
      source: grouped(settled, (decision) => decision.source),
      fallbackStatus: grouped(settled, (decision) => decision.decisionReason),
      pairFormation: grouped(settled, pairFormation),
      exposure: grouped(settled, exposure),
    },
  };
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? process.env.PAPER_STATE_PATH ?? "./data/paper-ladder-v10-btc";
  const statePath = requested.endsWith(".json")
    ? resolve(requested)
    : resolve(requested, "ladder-v10-regime-state.json");
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
    decisions?: Record<string, LadderV10Decision>;
  };
  const low = Number(process.env.LADDER_V10_SCORE_LOW ?? 40);
  const high = Number(process.env.LADDER_V10_SCORE_HIGH ?? 70);
  console.log(
    JSON.stringify(
      buildLadderV10Report(Object.values(parsed.decisions ?? {}), low, high),
      null,
      2,
    ),
  );
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) await main();
