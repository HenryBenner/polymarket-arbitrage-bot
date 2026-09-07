import { createHash } from "node:crypto";
import type { BotConfig } from "./config.js";
import { exactKalshiDepthCost, exactKalshiDepthProceeds, exactKalshiOrderFee } from "./kalshi-fees.js";
import { v15Inventory, v15OrderRole, v15Round } from "./ladder-v15-inventory.js";
import type { MarketExecutionSnapshot, TokenBook, TradeOpportunity, UpDownEvent } from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";
import { validateOrderMinimum } from "./utils/order-validation.js";

export interface LadderV15Plan {
  cancelOrderIds: string[];
  opportunities: TradeOpportunity[];
  flattenOpportunities: TradeOpportunity[];
  managementStage: string;
  nextWakeAtMs?: number;
}

export function planLadderV15(config: BotConfig, event: UpDownEvent,
  snapshot: MarketExecutionSnapshot, portfolioExposure: number, now = Date.now() / 1000): LadderV15Plan {
  const remaining = event.windowEnd - now;
  const active = remaining > config.ladderV15EntryMinutesMin * 60 &&
    remaining <= config.ladderV15EntryMinutesMax * 60;
  const cleanup = remaining <= config.ladderV15CleanupSeconds;
  const plan: LadderV15Plan = { cancelOrderIds: [], opportunities: [], flattenOpportunities: [], managementStage: "idle" };
  const deadlines = [event.windowEnd - config.ladderV15EntryMinutesMax * 60,
    event.windowEnd - config.ladderV15EntryMinutesMin * 60,
    event.windowEnd - config.ladderV15CleanupSeconds, event.windowEnd].filter(at => at > now);
  if (deadlines.length) plan.nextWakeAtMs = Math.min(...deadlines) * 1000;
  const wake = (at: number) => { if (at > now * 1000) plan.nextWakeAtMs = Math.min(plan.nextWakeAtMs ?? Infinity, at); };
  const cycles = v15Inventory(snapshot);
  const cycle = cycles.at(-1);
  const open = snapshot.openOrders.filter(order => order.pairId?.startsWith("ladder-v15:"));
  const cancel = (ids: string[], stage: string) => {
    plan.cancelOrderIds = ids; plan.managementStage = stage; return plan;
  };
  if (remaining <= 0 || snapshot.settledPnl !== null) return cancel(open.map(o => o.id), "closed");
  // Deadlines cancel risk even when market data is unavailable; no new orders on invalid data.
  if ((!active && open.some(o => v15OrderRole(o) === "entry")) || cleanup && open.length) {
    return cancel(open.filter(o => cleanup || v15OrderRole(o) === "entry").map(o => o.id), "cancel-before-management");
  }
  if (snapshot.marketDataValid === false || snapshot.executionPending) return plan;
  const books = snapshot.books;
  if (books.length !== 2) return plan;
  const tick = Number(tickSizeFromMarket(event.market));
  const quantity = cycle?.lots.reduce((sum, lot) => sum + lot.size, 0) ?? 0;
  const cycleId = quantity > 1e-8 || open.length ? cycle!.id : (cycle?.id ?? 0) + 1;
  const make = (book: TokenBook, price: number, size: number, role: string,
    policy: TradeOpportunity["orderPolicy"], signature = ""): TradeOpportunity => ({
    event, token: book, kind: role === "entry" ? "cheap" : "expensive",
    price: v15Round(price), size: v15Round(size), tickSize: String(tick), negRisk: event.market.negRisk,
    strategyMode: "ladder_v15", phaseId: "15-2", pairId: `ladder-v15:${cycleId}:${role}:${signature}`,
    tradeKey: `ladder-v15:${event.slug}:${cycleId}:${role}:${snapshot.orders.length}:${signature}`,
    orderPolicy: policy, capitalEffect: role === "entry" ? "increase" : "reduce",
  });
  const submit = (order: TradeOpportunity, sale = false) => {
    if (!validateOrderMinimum(order)) {
      (sale ? plan.flattenOpportunities : plan.opportunities).push(order);
      plan.managementStage = order.pairId!.split(":")[2]!;
    }
    return plan;
  };
  if (quantity <= 1e-8) {
    if (open.length) return cycle?.entryShares
      ? cancel(open.map(o => o.id), "cancel-finished-cycle") : plan;
    if (!active) return plan;
    // Failed/unfilled entries and completed cycles cannot spin on an unchanged snapshot.
    const lastAt = cycle ? Math.max(...cycle.orders.map(o => Date.parse(o.createdAt)), Date.parse(cycle.lastFillAt ?? "") || 0) : 0;
    if (now * 1000 < lastAt + config.ladderV15RetryCooldownMs) {
      wake(lastAt + config.ladderV15RetryCooldownMs); return plan;
    }
    const cheap = [...books].sort((a, b) => (a.bestAsk ?? 1) - (b.bestAsk ?? 1) || a.outcomeIndex - b.outcomeIndex)[0]!;
    const size = Math.floor(Math.min(config.ladderV15CycleShares, config.ladderV15MaxUnmatchedPerMarket,
      config.ladderV15MaxUnmatchedPortfolio - portfolioExposure) * 100) / 100;
    if (size <= 0 || cheap.bestAsk === null) return plan;
    let price = Math.floor((config.ladderV15CheapPrice + 1e-9) / tick) * tick;
    while (price >= tick && validateOrderMinimum(make(cheap, price, size, "entry", "post_only"))?.reason === "invalid_price_tick") price = v15Round(price - tick);
    const crossing = cheap.bestAsk <= price;
    const executableSize = crossing ? Math.floor(Math.min(size,
      cheap.asks.filter(level => level.price <= price + 1e-8).reduce((sum, level) => sum + level.size, 0)) * 100) / 100 : size;
    if (executableSize <= 0) return plan;
    return submit(make(cheap, price, executableSize, "entry", crossing ? "fak" : "post_only"));
  }
  // Stop the remainder of a partially filled entry before managing its confirmed exposure.
  const entries = open.filter(o => v15OrderRole(o) === "entry");
  if (entries.length) return cancel(entries.map(o => o.id), "cancel-partial-entry");
  const held = books.find(b => b.tokenId === cycle!.lots[0]!.tokenId)!;
  const other = books.find(b => b.tokenId !== held.tokenId)!;
  // Worst remaining lot, rather than historical average, protects every completed pair.
  const entryCost = Math.max(...cycle!.lots.map(lot => lot.allInPrice));
  const depth = (size: number) => exactKalshiDepthCost({ levels: other.asks, size,
    rate: snapshot.takerFeeRate, exponent: snapshot.takerFeeExponent });
  const signature = createHash("sha256").update(JSON.stringify([cleanup, quantity, other.asks, held.bids])).digest("hex").slice(0, 16);
  const attempts = cycle!.orders.filter(o => ["completion-taker", "cleanup-hedge", "cleanup-sale"].includes(v15OrderRole(o)));
  const latest = Math.max(0, ...attempts.map(o => Date.parse(o.createdAt)));
  const ready = now * 1000 >= latest + config.ladderV15RetryCooldownMs;
  if (!ready) wake(latest + config.ladderV15RetryCooldownMs);
  const sameAttempts = attempts.filter(o => o.pairId?.endsWith(`:${signature}`)).length;
  let selected = depth(quantity);
  if (cleanup) {
    // Choose on a common executable quantity; FOK never assumes unavailable depth.
    const buyAvailable = other.asks.reduce((sum, level) => sum + level.size, 0);
    const sellAvailable = held.bids.reduce((sum, level) => sum + level.size, 0);
    const size = Math.floor(Math.min(quantity, buyAvailable > 0 && sellAvailable > 0
      ? Math.min(buyAvailable, sellAvailable) : Math.max(buyAvailable, sellAvailable)) * 100) / 100;
    if (size <= 0 || !ready || sameAttempts >= config.ladderV15RetryLimit) return plan;
    selected = depth(size);
    const sale = exactKalshiDepthProceeds({ levels: held.bids, size, rate: snapshot.takerFeeRate,
      exponent: snapshot.takerFeeExponent });
    const hedgeValue = selected && entryCost + selected.total / size <= config.ladderV15EmergencyPairCost + 1e-8
      ? size - selected.total : -Infinity;
    if (sale && sale.size >= size - 1e-8 && sale.total > hedgeValue + 1e-8) {
      return submit(make(held, sale.limitPrice, size, "cleanup-sale", "fak", signature), true);
    }
    if (Number.isFinite(hedgeValue)) return submit(make(other, selected!.limitPrice, size, "cleanup-hedge", "fok", signature));
    return plan;
  }
  if (selected && entryCost + selected.total / quantity <= 1 - config.ladderV15MinNetEdge + 1e-8 &&
    ready && sameAttempts < config.ladderV15RetryLimit) {
    if (open.length) return cancel(open.map(o => o.id), "cancel-before-fok");
    return submit(make(other, selected.limitPrice, quantity, "completion-taker", "fok", signature));
  }
  let price = Math.floor((Math.min(config.ladderV15FavoritePrice, (other.bestAsk ?? 1) - tick) + 1e-9) / tick) * tick;
  while (price >= tick - 1e-9 && (validateOrderMinimum(make(other, price, quantity, "completion-maker", "post_only"))?.reason === "invalid_price_tick" ||
    entryCost + price + exactKalshiOrderFee({ price, size: quantity,
    rate: snapshot.makerFeeRate ?? 0, exponent: snapshot.takerFeeExponent }) / quantity > 1 - config.ladderV15MinNetEdge + 1e-8)) {
    price = v15Round(price - tick);
  }
  if (open.length) {
    const order = open[0]!;
    if (open.length === 1 && order.tokenId === other.tokenId && Math.abs(order.remainingSize - quantity) < 1e-8 &&
      Math.abs(order.limitPrice - price) < 1e-8) return plan;
    return cancel(open.map(o => o.id), "replace-completion-maker");
  }
  if (price < tick - 1e-9) return plan;
  return submit(make(other, price, quantity, "completion-maker", "post_only"));
}
