import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/analyze-v14-run.mjs <paper-directory>');
const orders = new Map(), fills = new Map(), settlements = new Map();
const types = {}, samples = {}, files = [], stales = [], amendments = new Map();
const remember = (map, values, key) => { for (const value of values ?? []) map.set(value[key], value); };
const state = JSON.parse(readFileSync(join(directory, 'paper-state.json'), 'utf8'));
const names = readdirSync(directory);
for (const name of names.filter(name => /^paper-events\.jsonl(?:\.\d+(?:\.gz)?)?$/.test(name) && !names.includes(`${name}.gz`))) {
  let data = readFileSync(join(directory, name));
  if (name.endsWith('.gz')) data = gunzipSync(data);
  let first, last, count = 0, errors = 0;
  for (const line of data.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { errors++; continue; }
    count++; first ??= record.timestamp; last = record.timestamp;
    const {type, payload: p, timestamp} = record;
    types[type] = (types[type] ?? 0) + 1;
    samples[type] ??= p;
    if (type === 'order_amended') {
      const rows = amendments.get(p.id) ?? [];
      rows.push({time:timestamp, price:p.limitPrice, size:p.remainingSize});
      amendments.set(p.id, rows);
    }
    if (p?.id && p?.tradeKey) {
      const previous = orders.get(p.id);
      if (!previous || (previous.recordedAt ?? '') < timestamp) orders.set(p.id, { ...p, recordedAt: timestamp });
    }
    if (p?.id && p?.orderId && p?.size) fills.set(p.id, { ...p, recordedAt: timestamp });
    if (p?.winningTokenId && p?.marketSlug) settlements.set(p.marketSlug, p);
    if (type === 'stale_event_skipped') stales.push(p.eventAgeMs);
  }
  files.push({name, first, last, count, errors});
}
// Current state contains archived settlement totals, not the complete fill ledger.
remember(orders, state.orders, 'id');
for (const f of state.fills ?? []) if (!fills.has(f.id)) fills.set(f.id, f);
remember(settlements, state.settlements, 'marketSlug');
const sum = (values, f) => values.reduce((a, x) => a + f(x), 0);
const rounded = (n) => Math.round(n * 1000) / 1000;
const percentile = (values, fraction) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.floor(values.length*fraction))];
const role = (o) => o?.pairId?.startsWith('ladder-v14:repair-maker:') ? 'repair-maker' : o?.pairId?.replace('ladder-v14:', '') ?? 'unknown';
const byMarket = new Map();
for (const f of fills.values()) {
  const m = byMarket.get(f.marketSlug) ?? {slug: f.marketSlug, fills: [], orders: []};
  m.fills.push(f); byMarket.set(f.marketSlug, m);
}
for (const o of orders.values()) byMarket.get(o.marketSlug)?.orders.push(o);
const marketRows = [];
const byRole = {};
const delays = [];
for (const m of byMarket.values()) {
  const holdings = {}, costs = {}, fees = {}, episodes = [];
  let buys = 0, sells = 0, cash = 0, maxResidual = 0, episode = null;
  for (const f of m.fills.sort((a,b) => a.timestamp.localeCompare(b.timestamp))) {
    const r = role(orders.get(f.orderId));
    const group = byRole[r] ??= {fills: 0, shares: 0, cost: 0, fees: 0, lagMs: []};
    group.fills++; group.shares += f.size; group.cost += f.size*f.price; group.fees += f.fee;
    if (f.recordedAt) { const delay = Date.parse(f.recordedAt)-Date.parse(f.timestamp); group.lagMs.push(delay); delays.push(delay); }
    const buying = (f.side ?? 'BUY') === 'BUY';
    holdings[f.outcome] = (holdings[f.outcome] ?? 0) + f.size*(buying ? 1 : -1);
    costs[f.outcome] = (costs[f.outcome] ?? 0) + f.size*f.price*(buying ? 1 : -1);
    fees[f.outcome] = (fees[f.outcome] ?? 0) + f.fee;
    cash += f.size*f.price*(buying ? -1 : 1)-f.fee;
    if (buying) buys += f.size; else sells += f.size;
    const residual = Math.abs((holdings.Up ?? 0)-(holdings.Down ?? 0));
    maxResidual = Math.max(maxResidual, residual);
    if (!episode && residual > 1e-6) episode = {start: Date.parse(f.timestamp), firstPrice:f.price, firstRole:r};
    if (episode && residual < 1e-6) { episodes.push({...episode, seconds:(Date.parse(f.timestamp)-episode.start)/1000}); episode=null; }
  }
  const settlement = settlements.get(m.slug);
  const pairQty = Math.min(holdings.Up ?? 0, holdings.Down ?? 0);
  const pnl = settlement?.realizedPnl;
  marketRows.push({slug:m.slug, fills:m.fills.length, orders:m.orders.length, buys:rounded(buys), sells:rounded(sells),
    pairQty:rounded(pairQty), maxResidual:rounded(maxResidual), residual:rounded(Math.abs((holdings.Up??0)-(holdings.Down??0))),
    replayPnl:settlement ? rounded(cash+(holdings[settlement.winningOutcome]??0)) : null,
    pnl, fees:rounded(sum(m.fills,f=>f.fee)), episodes:episodes.length,
    medianRepairSec:percentile(episodes.map(e=>e.seconds), .5), maxRepairSec:percentile(episodes.map(e=>e.seconds), 1)});
}
console.log(JSON.stringify({ files, types,
  samples: Object.fromEntries(Object.entries(samples).filter(([key])=> !['order_submitted','order_amended','order_cancelled','fill'].includes(key))),
  account:{startingBalance:state.startingBalance,theoreticalCash:state.theoreticalCash,grossCapitalDeployed:state.grossCapitalDeployed},
  settlementSummary: ['btc','eth'].map(asset => {const selected=[...settlements.values()].filter(s=>s.marketSlug.startsWith(asset));return {asset,markets:selected.length,
    pnl:rounded(sum(selected,s=>s.realizedPnl)),fees:rounded(sum(selected,s=>s.totalFees)),winners:selected.filter(s=>s.realizedPnl>0).length};}),
  stale:{count:stales.length,medianMs:percentile(stales,.5),p95Ms:percentile(stales,.95),maxMs:percentile(stales,1)},
  fillLag:{medianMs:percentile(delays,.5),p95Ms:percentile(delays,.95),maxMs:percentile(delays,1)},
  amendmentChurn:[...amendments].sort((a,b)=>b[1].length-a[1].length).slice(0,3)
    .map(([id,rows])=>({id,count:rows.length,market:orders.get(id)?.marketSlug,
      examples:rows.sort((a,b)=>a.time.localeCompare(b.time)).slice(0,10)})),
  byRole:Object.fromEntries(Object.entries(byRole).map(([r,g])=>[r,{...g, shares:rounded(g.shares),cost:rounded(g.cost),fees:rounded(g.fees),lagMs:{median:percentile(g.lagMs,.5),p95:percentile(g.lagMs,.95),max:percentile(g.lagMs,1)}}])),
  marketSummary:{withFills:marketRows.length, reconciled:marketRows.filter(m=>Math.abs(m.replayPnl-m.pnl)<0.02).length,
    completePairs:rounded(sum(marketRows,m=>m.pairQty)), endingResiduals:rounded(sum(marketRows,m=>m.residual)),
    worst:marketRows.filter(m=>m.pnl!==undefined).sort((a,b)=>a.pnl-b.pnl).slice(0,8)},
  markets:process.argv.includes('--all') ? marketRows.sort((a,b)=>a.slug.localeCompare(b.slug)) : undefined,
  detail:process.argv[3] && !process.argv[3].startsWith('--') ? byMarket.get(process.argv[3]) : undefined,
}, null, 2));
