import WebSocket from "ws";
import type { BotConfig } from "./config.js";
import {
  kalshiTokenId,
  kalshiWebSocketHeaders,
  loadKalshiPrivateKey,
  parseKalshiTokenId,
} from "./kalshi-api.js";
import { log } from "./logger.js";
import type { MarketStreamEvent } from "./market-stream.js";
import type { OrderBookLevel } from "./types.js";

type EventHandler = (event: MarketStreamEvent) => void | Promise<void>;

interface KalshiBookState {
  yes: Map<number, number>;
  // With use_yes_price enabled, NO-side levels are keyed by YES price.
  noOnYesScale: Map<number, number>;
}

interface KalshiMessage {
  id?: number;
  sid?: number;
  seq?: number;
  type?: string;
  msg?: Record<string, unknown>;
}

const CHANNELS = ["orderbook_delta", "trade", "fill", "user_orders"] as const;

export class KalshiMarketStream {
  private socket: WebSocket | null = null;
  private readonly tickers = new Set<string>();
  private readonly books = new Map<string, KalshiBookState>();
  private readonly invalidTickers = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1_000;
  private stopped = false;
  private connecting = false;
  private commandId = 1;
  private readonly subscriptionIds = new Map<string, number>();
  private readonly subscriptionRequests = new Map<number, string>();
  private readonly pendingAdditions = new Set<string>();
  private readonly lastSequenceBySid = new Map<number, number>();
  private recoveringOrderbook = false;
  private processingQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: BotConfig,
    private readonly onEvent: EventHandler,
  ) {}

  subscribe(tokenIds: string[]): void {
    const additions = new Set<string>();
    for (const tokenId of tokenIds) {
      const parsed = parseKalshiTokenId(tokenId);
      if (!parsed || this.tickers.has(parsed.ticker)) continue;
      this.tickers.add(parsed.ticker);
      additions.add(parsed.ticker);
    }
    if (additions.size === 0) return;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      void this.connect();
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.updateSubscriptions([...additions]);
    }
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (
      this.stopped ||
      this.connecting ||
      this.tickers.size === 0 ||
      (this.socket &&
        (this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }
    this.connecting = true;
    try {
      if (!this.config.kalshiApiKeyId) {
        throw new Error("KALSHI_API_KEY_ID is required for the Kalshi stream");
      }
      const privateKey = await loadKalshiPrivateKey(this.config);
      const socket = new WebSocket(this.config.kalshiWsHost, {
        headers: kalshiWebSocketHeaders(
          this.config.kalshiApiKeyId,
          privateKey,
        ),
      });
      this.socket = socket;
      this.subscriptionIds.clear();
      this.subscriptionRequests.clear();
      this.pendingAdditions.clear();
      this.lastSequenceBySid.clear();
      this.books.clear();
      this.invalidTickers.clear();
      for (const ticker of this.tickers) this.invalidTickers.add(ticker);
      this.recoveringOrderbook = true;
      socket.on("open", () => {
        this.reconnectDelayMs = 1_000;
        this.sendSubscriptions([...this.tickers]);
        this.startHeartbeat(socket);
        this.enqueueEvent({
          event_type: "kalshi_stream_connected",
          market_tickers: [...this.tickers],
        });
        log("Kalshi market stream connected", { markets: this.tickers.size });
      });
      socket.on("message", (data: unknown) => {
        this.enqueueMessage(data);
      });
      socket.on("error", (error: Error) => {
        log("Kalshi market stream error", { error: error.message });
      });
      socket.on("close", () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.socket === socket) this.socket = null;
        this.books.clear();
        this.invalidTickers.clear();
        for (const ticker of this.tickers) this.invalidTickers.add(ticker);
        this.recoveringOrderbook = true;
        this.enqueueEvent({
          event_type: "market_books_invalid",
          market_tickers: [...this.tickers],
          reason: "disconnected",
        });
        this.scheduleReconnect();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Kalshi market stream connection failed", { error: message });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private enqueueMessage(data: unknown): void {
    const operation = () => this.handleMessage(data);
    this.processingQueue = this.processingQueue.then(operation, operation);
  }

  private enqueueEvent(event: MarketStreamEvent): void {
    const operation = async () => {
      try {
        await this.onEvent(event);
      } catch (error) {
        log("Kalshi market event error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    this.processingQueue = this.processingQueue.then(operation, operation);
  }

  private sendSubscriptions(tickers: string[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    for (const channel of CHANNELS) {
      const id = this.commandId++;
      this.subscriptionRequests.set(id, channel);
      this.socket.send(
        JSON.stringify({
          id,
          cmd: "subscribe",
          params: {
            channels: [channel],
            market_tickers: tickers,
            ...(channel === "orderbook_delta" ? { use_yes_price: true } : {}),
          },
        }),
      );
    }
  }

  private updateSubscriptions(tickers: string[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const unique = [...new Set(tickers)];
    for (const ticker of unique) {
      this.pendingAdditions.add(ticker);
      this.invalidTickers.add(ticker);
    }
    if (this.subscriptionIds.size < CHANNELS.length) return;
    for (const sid of this.subscriptionIds.values()) {
      this.socket.send(
        JSON.stringify({
          id: this.commandId++,
          cmd: "update_subscription",
          params: {
            sids: [sid],
            market_tickers: unique,
            action: "add_markets",
          },
        }),
      );
    }
    for (const ticker of unique) this.pendingAdditions.delete(ticker);
  }

  private requestOrderbookSnapshot(tickers: string[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const sid = this.subscriptionIds.get("orderbook_delta");
    if (sid === undefined) return;
    this.socket.send(
      JSON.stringify({
        id: this.commandId++,
        cmd: "update_subscription",
        params: {
          sids: [sid],
          market_tickers: tickers,
          action: "get_snapshot",
        },
      }),
    );
  }

  private startHeartbeat(socket: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 10_000);
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : "";
    if (!text) return;
    let event: KalshiMessage;
    try {
      event = JSON.parse(text) as KalshiMessage;
    } catch {
      return;
    }
    try {
      if (event.type === "subscribed") {
        const id = Number(event.id);
        const channel =
          this.subscriptionRequests.get(id) ?? String(event.msg?.channel ?? "");
        const sid = Number(event.msg?.sid);
        if (channel && Number.isFinite(sid)) {
          this.subscriptionIds.set(channel, sid);
          this.subscriptionRequests.delete(id);
        }
        if (this.pendingAdditions.size > 0) {
          this.updateSubscriptions([...this.pendingAdditions]);
        }
      } else if (event.type === "orderbook_snapshot") {
        await this.handleSnapshot(event);
      } else if (event.type === "orderbook_delta") {
        await this.handleDelta(event);
      } else if (event.type === "trade") {
        await this.handleTrade(event.msg ?? {});
      } else if (event.type === "fill" || event.type === "user_order") {
        await this.onEvent({
          event_type: event.type,
          ...(event.msg ?? {}),
        });
      } else if (event.type === "error") {
        log("Kalshi stream subscription error", { details: event.msg });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Kalshi market event error", { error: message });
    }
  }

  private async handleSnapshot(event: KalshiMessage): Promise<void> {
    const message = event.msg ?? {};
    const ticker = String(message.market_ticker ?? "");
    if (!ticker) return;
    this.recordSequence(event);
    const state: KalshiBookState = {
      yes: levelsToMap(message.yes_dollars_fp),
      noOnYesScale: levelsToMap(message.no_dollars_fp),
    };
    this.books.set(ticker, state);
    this.invalidTickers.delete(ticker);
    if (this.invalidTickers.size === 0) this.recoveringOrderbook = false;
    await this.emitBooks(ticker, state);
  }

  private async handleDelta(event: KalshiMessage): Promise<void> {
    const message = event.msg ?? {};
    const ticker = String(message.market_ticker ?? "");
    if (!ticker || !this.hasConsecutiveSequence(event)) {
      if (ticker) await this.recoverFromSequenceGap(event);
      return;
    }
    this.recordSequence(event);
    if (this.invalidTickers.has(ticker)) return;
    const side = String(message.side ?? "") as "yes" | "no";
    const price = Number(message.price_dollars);
    const delta = Number(message.delta_fp);
    const state = this.books.get(ticker);
    if (!state || (side !== "yes" && side !== "no")) return;
    if (!Number.isFinite(price) || !Number.isFinite(delta)) return;
    const levels = side === "yes" ? state.yes : state.noOnYesScale;
    const next = (levels.get(price) ?? 0) + delta;
    if (next <= 1e-8) levels.delete(price);
    else levels.set(price, next);
    await this.emitBooks(ticker, state);
  }

  private hasConsecutiveSequence(event: KalshiMessage): boolean {
    const sid = Number(event.sid);
    const seq = Number(event.seq);
    if (!Number.isFinite(sid) || !Number.isFinite(seq)) return false;
    const previous = this.lastSequenceBySid.get(sid);
    return previous !== undefined && seq === previous + 1;
  }

  private recordSequence(event: KalshiMessage): void {
    const sid = Number(event.sid);
    const seq = Number(event.seq);
    if (Number.isFinite(sid) && Number.isFinite(seq)) {
      this.lastSequenceBySid.set(sid, seq);
    }
  }

  private async recoverFromSequenceGap(event: KalshiMessage): Promise<void> {
    const sid = Number(event.sid);
    const seq = Number(event.seq);
    const previous = Number.isFinite(sid)
      ? this.lastSequenceBySid.get(sid)
      : undefined;
    this.recordSequence(event);
    if (this.recoveringOrderbook) return;
    this.recoveringOrderbook = true;
    this.books.clear();
    this.invalidTickers.clear();
    for (const ticker of this.tickers) this.invalidTickers.add(ticker);
    log("Kalshi orderbook sequence gap; requesting fresh snapshots", {
      sid,
      expected: previous === undefined ? undefined : previous + 1,
      received: seq,
      markets: this.invalidTickers.size,
    });
    this.requestOrderbookSnapshot([...this.invalidTickers]);
    await this.onEvent({
      event_type: "market_books_invalid",
      market_tickers: [...this.invalidTickers],
      reason: "sequence_gap",
    });
  }

  private async handleTrade(message: Record<string, unknown>): Promise<void> {
    const ticker = String(message.market_ticker ?? "");
    const takerOutcome = String(
      message.taker_outcome_side ?? message.taker_side ?? "",
    );
    if (!ticker || (takerOutcome !== "yes" && takerOutcome !== "no")) return;
    const makerOutcome = takerOutcome === "yes" ? "no" : "yes";
    const price = Number(
      makerOutcome === "yes"
        ? message.yes_price_dollars
        : message.no_price_dollars,
    );
    const size = Number(message.count_fp);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return;
    await this.onEvent({
      event_type: "last_trade_price",
      asset_id: kalshiTokenId(ticker, makerOutcome),
      side: "SELL",
      price: String(price),
      size: String(size),
      timestamp: String(message.ts_ms ?? message.ts ?? Date.now()),
      transaction_hash: String(message.trade_id ?? ""),
    });
  }

  private async emitBooks(
    ticker: string,
    state: KalshiBookState,
  ): Promise<void> {
    if (this.invalidTickers.has(ticker)) return;
    const yesBids = mapToLevels(state.yes, false);
    const yesAsks = mapToLevels(state.noOnYesScale, true);
    const noBids = complement(state.noOnYesScale, false);
    const noAsks = complement(state.yes, true);
    const timestamp = String(Date.now());
    const books = [
      bookEvent(kalshiTokenId(ticker, "yes"), yesBids, yesAsks, timestamp),
      bookEvent(kalshiTokenId(ticker, "no"), noBids, noAsks, timestamp),
    ];
    await this.onEvent({
      event_type: "market_books",
      market_ticker: ticker,
      asset_ids: books.map((book) => book.asset_id),
      books,
      timestamp,
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.tickers.size === 0) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    log("Kalshi market stream reconnect scheduled", { delayMs: delay });
  }
}

function levelsToMap(value: unknown): Map<number, number> {
  const result = new Map<number, number>();
  if (!Array.isArray(value)) return result;
  for (const level of value) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const price = Number(level[0]);
    const size = Number(level[1]);
    if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
      result.set(price, size);
    }
  }
  return result;
}

function mapToLevels(
  value: Map<number, number>,
  ascending: boolean,
): OrderBookLevel[] {
  return [...value].map(([price, size]) => ({ price, size })).sort((a, b) =>
    ascending ? a.price - b.price : b.price - a.price,
  );
}

function complement(
  levels: Map<number, number>,
  ascending: boolean,
): OrderBookLevel[] {
  return [...levels]
    .map(([price, size]) => ({
      price: Number((1 - price).toFixed(4)),
      size,
    }))
    .sort((a, b) => (ascending ? a.price - b.price : b.price - a.price));
}

function bookEvent(
  tokenId: string,
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  timestamp: string,
): MarketStreamEvent {
  return {
    event_type: "book",
    asset_id: tokenId,
    bids: bids.map((level) => ({
      price: String(level.price),
      size: String(level.size),
    })),
    asks: asks.map((level) => ({
      price: String(level.price),
      size: String(level.size),
    })),
    timestamp,
  };
}
