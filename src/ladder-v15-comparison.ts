import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, validateTradingConfig, type BotConfig } from "./config.js";
import { ReverseBot, type MarketSource } from "./bot.js";
import { MarketScanner } from "./market-scanner.js";
import { KalshiMarketStream } from "./kalshi-market-stream.js";
import { KalshiClient, kalshiTokenId } from "./kalshi-api.js";
import { PaperTrader } from "./paper-trader.js";
import { AppendOnlyJsonl } from "./utils/append-only-jsonl.js";
import { readV15Report, summarizeV15, type V15ReportState } from "./ladder-v15-report.js";
import type { PaperSettlement, TokenBook, UpDownEvent } from "./types.js";

export function v15ComparisonConfigs(base: BotConfig, root: string): Array<{ name: string; config: BotConfig }> {
  return ["v9", "v14", "v15-40", "v15-160", "v15-640"].map(name => {
    const size = Number(name.split("-")[1] ?? 40);
    return { name, config: { ...base, exchange: "kalshi", executionMode: "paper", dryRun: true,
      strategyMode: name === "v9" ? "ladder_v9" : name === "v14" ? "ladder_v14" : "ladder_v15",
      minutesBeforeCloseMin: 0, minutesBeforeCloseMax: 15,
      paperStatePath: join(root, name), ladderV15EntryMinutesMax: 15, ladderV15EntryMinutesMin: 2,
      ladderV15CycleShares: size, ladderV15MaxUnmatchedPerMarket: size, ladderV15MaxUnmatchedPortfolio: size * 3 } };
  });
}

/** One normalized websocket feed, one REST snapshot per round, five isolated execution ledgers. */
export async function runV15Comparison(base: BotConfig, root: string): Promise<void> {
  base = { ...base, exchange: "kalshi", executionMode: "paper", dryRun: true,
    minutesBeforeCloseMin: 0, minutesBeforeCloseMax: 15 };
  const variants = v15ComparisonConfigs(base, root);
  variants.forEach(({ config }) => validateTradingConfig(config));
  await mkdir(root, { recursive: true });
  // New directory required: silently mixing a previous tape/config would invalidate the experiment.
  await writeFile(join(root, "comparison.json"), JSON.stringify({ startedAt: new Date().toISOString(),
    series: base.kalshiSeriesTickers, variants: variants.map(({ name, config }) => ({ name,
      strategy: config.strategyMode, cycleShares: config.ladderV15CycleShares,
      entryMinutes: name.startsWith("v15") ? [15, 2] : undefined,
      settings: Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith("ladder") ||
        ["paperStartingUsdc", "pollIntervalMs", "kalshiTakerFeeRate", "kalshiMakerFeeRate", "kalshiFeeOverrides"].includes(key)).filter(([key]) => !key.endsWith("Ack")))
    })), requiredDays: 7, requiredMarketsPerSeries: 200 }, null, 2), { flag: "wx" });
  let failure: unknown;
  const tape = await AppendOnlyJsonl.open(join(root, "market-tape.jsonl"), error => { failure = error; });
  let stopped = false;
  const traders: PaperTrader[] = [];
  let sequence = 0;
  const stream = new KalshiMarketStream(base, async event => {
    if (["fill", "user_orders"].includes(String(event.event_type))) return;
    tape.write({ sequence: ++sequence, receivedAt: new Date().toISOString(), kind: "market-event", event });
    await Promise.all(traders.map(trader => trader.ingestMarketEvent(structuredClone(event))));
  });
  const scanner = new MarketScanner(base);
  let events: UpDownEvent[] = [];
  let roundBooks = new Map<string, TokenBook[]>();
  const source: MarketSource = { scan: async () => structuredClone(events),
    getTokenBooks: async event => structuredClone(roundBooks.get(event.slug) ?? []) };
  const client = new KalshiClient(base);
  const settlements = new Map<string, { at: number; promise: Promise<{ winningTokenId: string } | null> }>();
  const settlementLoader = (event: UpDownEvent) => {
    const cached = settlements.get(event.slug);
    if (cached && Date.now() - cached.at < 10_000) return cached.promise;
    const promise = (async () => {
      const ticker = event.market.externalMarketId ?? event.market.id;
      if (!ticker) return null;
      const market = await client.getMarket(ticker);
      if (!market || !["finalized", "settled"].includes(market.status) || !["yes", "no"].includes(market.result ?? "")) return null;
      const result = { winningTokenId: kalshiTokenId(ticker, market.result as "yes" | "no") };
      tape.write({ sequence: ++sequence, receivedAt: new Date().toISOString(), kind: "settlement", marketSlug: event.slug, ...result });
      return result;
    })();
    settlements.set(event.slug, { at: Date.now(), promise });
    return promise;
  };
  const subscriptions = variants.map(() => new Set<string>());
  const bots = variants.map(({ config }, index) => {
    const trader = new PaperTrader(config, { stream: {
      subscribe: ids => { ids.forEach(id => subscriptions[index]!.add(id)); stream.subscribe(ids); },
      unsubscribe: ids => {
        ids.forEach(id => subscriptions[index]!.delete(id));
        stream.unsubscribe(ids.filter(id => subscriptions.every(tokens => !tokens.has(id))));
      },
      close: () => {},
    }, settlementLoader });
    traders.push(trader); return new ReverseBot(config, trader, source);
  });
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const startedAt = Date.now();
  try {
    for (const bot of bots) await bot.init();
    while (!stopped) {
      if (failure) throw failure;
      const roundStarted = Date.now();
      events = await scanner.scan();
      roundBooks = new Map(await Promise.all(events.map(async event => [event.slug, await scanner.getTokenBooks(event)] as const)));
      tape.write({ sequence: ++sequence, receivedAt: new Date().toISOString(), kind: "discovery",
        markets: events.map(event => ({ event, books: roundBooks.get(event.slug) })) });
      await Promise.all(bots.map(bot => bot.runOnce()));
      if (Date.now() - startedAt >= 7 * 86400_000) {
        const ledgers = await Promise.all(variants.map(async ({ config }) => JSON.parse(
          await readFile(join(config.paperStatePath, ".runtime", "paper-state.json"), "utf8")) as { settlements: PaperSettlement[] }));
        const common = ledgers[0]!.settlements.filter(s => ledgers.every(ledger => ledger.settlements.some(other => other.marketSlug === s.marketSlug)));
        const assetBySeries = new Map(events.map(event => [event.market.seriesTicker!, event.slug.split("-")[0]!]));
        if (base.kalshiSeriesTickers.every(series => common.filter(s => s.marketSlug.startsWith(`${assetBySeries.get(series) ?? series.slice(2, -3).toLowerCase()}-`)).length >= 200)) stopped = true;
      }
      if (!stopped) await new Promise(resolve => setTimeout(resolve, Math.max(1, base.pollIntervalMs - (Date.now() - roundStarted))));
    }
  } finally {
    stream.close();
    const results = await Promise.allSettled(bots.map(bot => bot.stop()));
    await tape.close();
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    const rejected = results.find(result => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    const states = await Promise.all(variants.map(async ({ config }) => JSON.parse(await readFile(join(config.paperStatePath, ".runtime", "paper-state.json"), "utf8")) as V15ReportState));
    const common = new Set(states[0]!.settlements.filter(s => states.every(state => state.settlements.some(other => other.marketSlug === s.marketSlug))).map(s => s.marketSlug));
    const reports = await Promise.all(variants.map(async ({ name, config }, index) => ({ name,
      ...await readV15Report(config.paperStatePath), commonMarkets: summarizeV15({ ...states[index]!,
        settlements: states[index]!.settlements.filter(s => common.has(s.marketSlug)),
        orders: [], fills: [], v15Cycles: states[index]!.v15Cycles?.filter(c => common.has(c.marketSlug)) }) })));
    await writeFile(join(root, "results.json"), JSON.stringify({ elapsedDays: (Date.now() - startedAt) / 86400_000,
      commonSettledMarkets: common.size,
      ranking: reports.sort((a, b) => b.commonMarkets.settledNetPnl - a.commonMarkets.settledNetPnl) }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help")) console.log("Usage: npm run compare:ladder-v15 -- <new-output-directory>\nRuns V9, V14 and V15 at 40/160/640 on one recorded feed until seven days and 200 common settlements per series. Ctrl+C saves partial results.");
  else {
    const config = loadConfig();
    await runV15Comparison(config, resolve(process.argv[2] ?? "./data/v15-comparison"));
  }
}
