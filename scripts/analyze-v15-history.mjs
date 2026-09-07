import { readFile, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const read = async path => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const round = value => Math.round(value * 1e8) / 1e8;
function replay(fills, settlement) {
  const lots = [];
  let pairedPnl = 0, salePnl = 0, pairedShares = 0;
  for (const fill of [...fills].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
    let remaining = fill.size;
    const sale = fill.side === "SELL";
    const price = fill.price + (sale ? -1 : 1) * fill.fee / fill.size;
    for (const lot of lots) {
      if (sale ? lot.tokenId !== fill.tokenId : lot.tokenId === fill.tokenId) continue;
      const size = Math.min(remaining, lot.size);
      if (sale) salePnl += size * (price - lot.cost);
      else { pairedPnl += size * (1 - price - lot.cost); pairedShares += size; }
      lot.size -= size; remaining -= size;
    }
    if (sale && remaining > 1e-8) return null;
    if (!sale && remaining > 1e-8) lots.push({ size: remaining, tokenId: fill.tokenId, cost: price });
  }
  const directionalPnl = lots.reduce((sum, lot) => sum + lot.size * ((lot.tokenId === settlement.winningTokenId ? 1 : 0) - lot.cost), 0);
  return { pairedPnl: round(pairedPnl), salePnl: round(salePnl), directionalPnl: round(directionalPnl),
    pairedShares, netPnl: round(pairedPnl + salePnl + directionalPnl) };
}
async function ledger(directory) {
  const state = await read(join(directory, "paper-state.json"));
  const names = await readdir(directory);
  const retainedFills = new Map();
  const logIssues = [];
  const logFiles = names.filter(name => /^paper-events\.jsonl(?:\.\d+(?:\.gz)?)?$/.test(name))
    .filter(name => name.endsWith(".gz") || !names.includes(`${name}.gz`));
  for (const name of logFiles) {
    try {
      const bytes = await readFile(join(directory, name));
      const text = (name.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === "fill" && record.payload?.id) retainedFills.set(record.payload.id, record.payload);
        } catch { logIssues.push(`${name}: malformed/truncated record skipped`); }
      }
    } catch { logIssues.push(`${name}: unreadable/invalid archive skipped`); }
  }
  // Canonical checkpoint fills win over rotated-log copies.
  for (const fill of state.fills) retainedFills.set(fill.id, fill);
  const fills = [...retainedFills.values()];
  const settlements = [...new Map(state.settlements.map(s => [s.marketSlug, s])).values()];
  const details = settlements.map(settlement => {
    const marketFills = fills.filter(fill => fill.marketSlug === settlement.marketSlug);
    const result = marketFills.length ? replay(marketFills, settlement) : null;
    const reconciled = result !== null && Math.abs(result.netPnl - settlement.realizedPnl) <= 0.02;
    return { market: settlement.marketSlug, ledgerPnl: settlement.realizedPnl, reconciled,
      attribution: reconciled ? result : null };
  });
  return { directory, logFiles, logIssues: [...new Set(logIssues)], markets: settlements.length,
    netPnl: round(settlements.reduce((sum, s) => sum + s.realizedPnl, 0)),
    fees: round(settlements.reduce((sum, s) => sum + s.totalFees, 0)),
    reconciledMarkets: details.filter(row => row.reconciled).length,
    missingOrUnreconciledMarkets: details.filter(row => !row.reconciled).length,
    fillCounts: Object.fromEntries(["BUY", "SELL"].map(side => [side, fills.filter(fill => (fill.side ?? "BUY") === side).length])),
    reconciledAttribution: Object.fromEntries(["pairedPnl", "salePnl", "directionalPnl"].map(key =>
      [key, round(details.reduce((sum, row) => sum + (row.attribution?.[key] ?? 0), 0))])),
    largestWins: [...details].sort((a, b) => b.ledgerPnl - a.ledgerPnl).slice(0, 5),
    largestLosses: [...details].sort((a, b) => a.ledgerPnl - b.ledgerPnl).slice(0, 5) };
}
async function wallet(path) {
  const items = [];
  const flatten = value => {
    if (Array.isArray(value)) value.forEach(flatten);
    else if (value?.value) flatten(value.value);
    else if (value?.type && value?.timestamp) items.push(value);
  };
  flatten(await read(path));
  const unique = [...new Map(items.map(item => [JSON.stringify([item.transactionHash, item.type,
    item.asset, item.conditionId, item.side, item.timestamp, item.size, item.usdcSize]), item])).values()];
  const trades = unique.filter(item => item.type === "TRADE");
  const groups = new Map();
  for (const trade of trades) groups.set(trade.conditionId, [...(groups.get(trade.conditionId) ?? []), trade]);
  return { path, rawRecords: items.length, deduplicatedRecords: unique.length,
    observedMarkets: groups.size, marketsBuyingBothSides: [...groups.values()].filter(rows =>
      new Set(rows.filter(row => row.side === "BUY").map(row => row.asset)).size === 2).length,
    flowsByTypeAndSide: [...new Set(unique.map(item => `${item.type}/${item.side ?? ""}`))].map(group => {
      const rows = unique.filter(item => `${item.type}/${item.side ?? ""}` === group);
      return { group, count: rows.length, notional: round(rows.reduce((sum, row) => sum + (row.usdcSize ?? 0), 0)) };
    }), profitability: "Not established: observed flow can omit starting inventory, fees and other activity. Rebates/redemptions are not inferred trade profits." };
}
const args = process.argv.slice(2);
if (args.length < 3 || args.includes("--help")) {
  console.log("Usage: npm run analyze:ladder-v15-history -- <v9-paper-directory> <v14-paper-directory> <wallet-activity.json>");
} else {
  console.log(JSON.stringify({ v9: await ledger(args[0]), v14: await ledger(args[1]), wallet: await wallet(args[2]),
    limitations: "Only reconciled fill histories receive attribution. This is historical diagnosis, not a counterfactual backtest. Volume scaling is not assumed to preserve fills or profitability." }, null, 2));
}
