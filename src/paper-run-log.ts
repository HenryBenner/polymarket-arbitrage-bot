import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppendOnlyJsonl } from "./utils/append-only-jsonl.js";

const n = (value: unknown, places = 4) => typeof value === "number" && Number.isFinite(value)
  ? Math.round(value * 10 ** places) / 10 ** places : value;
const clean = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row)
  .filter(([, value]) => value !== null && value !== undefined));

export class PaperRunLog {
  readonly runId: string;
  private trades!: AppendOnlyJsonl;
  private markets!: AppendOnlyJsonl;
  private startedAt = new Date().toISOString();
  private marketRows: Record<string, unknown>[] = [];
  private health = { eventsProcessed: 0, staleEventsSkipped: 0, processingLagTotal: 0,
    processingLagCount: 0, processingLagMax: 0, orderAmendments: 0, errors: 0 };
  private readonly decisions = new Map<string, string>();
  private readonly residualRows = new Map<string, Record<string, unknown>[]>();
  private readonly actionCounts: Record<string, number> = {};

  private constructor(private readonly directory: string, runId?: string) {
    this.runId = runId ?? `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  }

  static async open(directory: string) {
    let previous: { runId?: string; startedAt?: string; simulatorHealth?: Record<string, number> } = {};
    try { previous = JSON.parse(await readFile(join(directory, "run-summary.json"), "utf8")); } catch { /* new run */ }
    const log = new PaperRunLog(directory, previous.runId);
    if (previous.startedAt) log.startedAt = previous.startedAt;
    if (previous.simulatorHealth) {
      log.health.eventsProcessed = previous.simulatorHealth.eventsProcessed ?? 0;
      log.health.staleEventsSkipped = previous.simulatorHealth.staleEventsSkipped ?? 0;
      log.health.processingLagMax = previous.simulatorHealth.processingLagMax ?? 0;
      if (previous.simulatorHealth.processingLagAvg !== undefined) {
        log.health.processingLagTotal = previous.simulatorHealth.processingLagAvg;
        log.health.processingLagCount = 1;
      }
      log.health.orderAmendments = previous.simulatorHealth.orderAmendments ?? 0;
      log.health.errors = previous.simulatorHealth.errors ?? 0;
    }
    log.trades = await AppendOnlyJsonl.open(join(directory, "trades.jsonl"), () => undefined);
    log.markets = await AppendOnlyJsonl.open(join(directory, "markets.jsonl"), () => undefined);
    try {
      const lines = (await readFile(join(directory, "markets.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean);
      log.marketRows = lines.map(line => JSON.parse(line));
    } catch { /* no settled markets */ }
    try {
      const lines = (await readFile(join(directory, "trades.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const row = JSON.parse(line);
        if (row.e !== "residual_decision") continue;
        const records = log.residualRows.get(String(row.m)) ?? [];
        records.push(row); log.residualRows.set(String(row.m), records);
        log.decisions.set(String(row.m), log.decisionSignature(row));
        const action = String(row.action ?? "unknown");
        log.actionCounts[action] = (log.actionCounts[action] ?? 0) + 1;
      }
    } catch { /* no trades */ }
    await log.writeSummary();
    return log;
  }

  trade(row: Record<string, unknown>): void {
    this.trades.write(clean(Object.fromEntries(Object.entries({ run: this.runId, ...row }).map(([k, v]) =>
      [k, typeof v === "number" ? n(v, ["px", "hold", "sell", "hedge", "wait", "entry"].includes(k) ? 6 : 4) : v]))));
  }

  residual(row: Record<string, unknown>): void {
    const key = String(row.m);
    const signature = this.decisionSignature(row);
    if (this.decisions.get(key) === signature) return;
    this.decisions.set(key, signature);
    const records = this.residualRows.get(key) ?? [];
    records.push(row); this.residualRows.set(key, records);
    const action = String(row.action ?? "unknown");
    this.actionCounts[action] = (this.actionCounts[action] ?? 0) + 1;
    this.trade({ e: "residual_decision", ...row });
  }

  private decisionSignature(row: Record<string, unknown>): string {
    return JSON.stringify([row.side, n(row.qty), row.action, n(row.hold, 2), n(row.repairPx, 2),
      row.sell == null, row.hedge == null, Math.floor(Number(row.age ?? 0) / 60), Number(row.left) <= 30]);
  }

  market(row: Record<string, unknown>): void {
    const residuals = this.residualRows.get(String(row.m)) ?? [];
    const last = residuals.at(-1), held = last?.action === "hold";
    const heldWon = held && String(last?.side).toLowerCase() === String(row.winner).toLowerCase();
    const counterfactual = (key: string, realized = false) => !last ? undefined
      : Number(last.qty ?? 0) * (realized
        ? (String(last.side).toLowerCase() === String(row.winner).toLowerCase() ? 1 : 0) - Number(last.entry ?? 0)
        : Number(last[key] ?? 0) - Number(last.entry ?? 0));
    const enriched = { run: this.runId, ...row,
      residualDecisions: residuals.length, heldToSettlement: held ? 1 : 0,
      heldWon: held ? Number(heldWon) : undefined,
      avgHoldEstimate: residuals.length ? residuals.reduce((s, r) => s + Number(r.hold ?? 0), 0) / residuals.length : undefined,
      holdExpected: last?.hold !== undefined ? counterfactual("hold") : undefined,
      holdRealizedCf: last ? counterfactual("hold", true) : undefined,
      sellCf: last?.sell !== undefined ? counterfactual("sell") : undefined,
      hedgeCf: last?.hedge !== undefined ? counterfactual("hedge") : undefined };
    const value = clean(Object.fromEntries(Object.entries(enriched).map(([key, value]) =>
      [key, typeof value === "number" ? n(value) : value])));
    this.marketRows.push(value);
    this.markets.write(value);
  }

  countEvent(lagMs: number, skipped = false): void {
    this.health.eventsProcessed++;
    if (skipped) this.health.staleEventsSkipped++;
    this.health.processingLagTotal += lagMs;
    this.health.processingLagCount++;
    this.health.processingLagMax = Math.max(this.health.processingLagMax, lagMs);
  }
  skippedEvent(): void { this.health.staleEventsSkipped++; }
  amendment(): void { this.health.orderAmendments++; }
  error(): void { this.health.errors++; }

  async writeSummary(endedAt?: string): Promise<void> {
    const sum = (key: string) => this.marketRows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
    const pnls = this.marketRows.map(row => Number(row.pnl ?? 0)).sort((a, b) => a - b);
    const residual = sum("residualPnl"), paired = sum("pairedPnl"), opening = sum("openingShares");
    const assets: Record<string, Record<string, number>> = {};
    for (const row of this.marketRows) {
      const asset = String(row.asset ?? "unknown").toLowerCase();
      const a = assets[asset] ??= { markets: 0, pnl: 0, pairedPnl: 0, residualPnl: 0 };
      a.markets++; a.pnl += Number(row.pnl ?? 0); a.pairedPnl += Number(row.pairedPnl ?? 0);
      a.residualPnl += Number(row.residualPnl ?? 0);
    }
    const holdCalibration = Array.from({ length: 10 }, (_, index) => {
      const selected = this.marketRows.filter(row => Number(row.heldToSettlement ?? 0) > 0 &&
        Math.min(9, Math.floor(Number(row.avgHoldEstimate ?? -1) * 10)) === index);
      const wins = selected.reduce((sum, row) => sum + Number(row.heldWon ?? 0), 0);
      return { range: `${(index / 10).toFixed(1)}-${((index + 1) / 10).toFixed(1)}`,
        n: selected.length, avgEstimate: selected.length ? n(selected.reduce((s, r) => s + Number(r.avgHoldEstimate), 0) / selected.length) : null,
        wins, winRate: selected.length ? n(wins / selected.length) : null };
    });
    const summary = { runId: this.runId, version: "compact-paper-v1", startedAt: this.startedAt,
      ...(endedAt ? { endedAt } : {}), markets: this.marketRows.length,
      pnl: { totalPnl: n(sum("pnl")), pairedPnl: n(paired), residualPnl: n(residual), fees: n(sum("fees")),
        pairProfitToResidualLossRatio: residual < 0 ? n(Math.max(0, paired) / Math.abs(residual)) : null },
      volume: { openingShares: n(opening), pairedShares: n(sum("makerPairShares") + sum("takerPairShares")),
        heldShares: n(sum("heldShares")), grossCapital: n(sum("grossCapital")) },
      completion: { makerPairShares: n(sum("makerPairShares")), takerPairShares: n(sum("takerPairShares")),
        residualSettlementShares: n(sum("heldShares")), completionRate: opening ? n((sum("makerPairShares") + sum("takerPairShares")) / opening) : null },
      residualActions: this.actionCounts,
      residualResults: { holds: sum("heldToSettlement"), holdWins: sum("heldWon"),
        holdLosses: sum("heldToSettlement") - sum("heldWon"),
        holdWinRate: sum("heldToSettlement") ? n(sum("heldWon") / sum("heldToSettlement")) : null,
        holdPnl: n(sum("residualPnl")) },
      risk: { largestMarketLoss: n(pnls[0] ?? 0), largestMarketWin: n(pnls.at(-1) ?? 0),
        worst5Pnl: n(pnls.slice(0, 5).reduce((a, b) => a + b, 0)), worst10Pnl: n(pnls.slice(0, 10).reduce((a, b) => a + b, 0)),
        maxResidualShares: n(Math.max(0, ...this.marketRows.map(r => Number(r.maxResidual ?? 0)))),
        maxOpeningFill: n(Math.max(0, ...this.marketRows.map(r => Number(r.maxOpeningFill ?? 0)))),
        maxGrossMarketExposure: n(Math.max(0, ...this.marketRows.map(r => Number(r.maxGrossMarketExposure ?? 0)))) },
      assets: Object.fromEntries(Object.entries(assets).map(([asset, values]) => [asset,
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, n(value)]))])),
      holdCalibration, simulatorHealth: { eventsProcessed: this.health.eventsProcessed,
        staleEventsSkipped: this.health.staleEventsSkipped,
        staleRate: this.health.eventsProcessed ? n(this.health.staleEventsSkipped / this.health.eventsProcessed) : 0,
        processingLagAvg: this.health.processingLagCount ? n(this.health.processingLagTotal / this.health.processingLagCount, 3) : 0,
        processingLagMax: n(this.health.processingLagMax, 3), orderAmendments: this.health.orderAmendments,
        errors: this.health.errors } };
    const path = join(this.directory, "run-summary.json"), temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(summary, null, 2), "utf8");
    try { await rename(temporary, path); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await writeFile(path, JSON.stringify(summary, null, 2), "utf8"); await rm(temporary, { force: true });
    }
  }

  async flush(): Promise<void> { await Promise.all([this.trades.flush(), this.markets.flush(), this.writeSummary()]); }
  async close(): Promise<void> { const ended = new Date().toISOString(); await this.writeSummary(ended);
    await Promise.all([this.trades.close(), this.markets.close()]); }
}
