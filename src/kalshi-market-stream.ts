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
  no: Map<number, number>;
}

interface KalshiMessage {
  id?: number;
  type?: string;
  msg?: Record<string, unknown>;
}

export class KalshiMarketStream {
  private socket: WebSocket | null = null;
  private readonly tickers = new Set<string>();
  private readonly books = new Map<string, KalshiBookState>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1_000;
  private stopped = false;
  private connecting = false;
  private commandId = 1;
  private readonly subscriptionIds = new Map<string, number>();
  private readonly subscriptionRequests = new Map<number, string>();
  private readonly pendingAdditions = new Set<string>();

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
      socket.on("open", () => {
        this.reconnectDelayMs = 1_000;
        this.sendSubscriptions([...this.tickers]);
        this.startHeartbeat(socket);
        log("Kalshi market stream connected", { markets: this.tickers.size });
      });
      socket.on("message", (data: unknown) => {
        void this.handleMessage(data);
      });
      socket.on("error", (error: Error) => {
        log("Kalshi market stream error", { error: error.message });
      });
      socket.on("close", () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.socket === socket) this.socket = null;
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

  private sendSubscriptions(tickers: string[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    for (const channel of ["orderbook_delta", "trade"]) {
      const id = this.commandId++;
      this.subscriptionRequests.set(id, channel);
      this.socket.send(
        JSON.stringify({
          id,
          cmd: "subscribe",
          params: { channels: [channel], market_tickers: tickers },
        }),
      );
    }
  }

  private updateSubscriptions(tickers: string[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const unique = [...new Set(tickers)];
    for (const ticker of unique) this.pendingAdditions.add(ticker);
    if (this.subscriptionIds.size < 2) return;
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
        const channel = this.subscriptionRequests.get(id);
        const sid = Number(event.msg?.sid);
        if (channel && Number.isFinite(sid)) {
          this.subscriptionIds.set(channel, sid);
          this.subscriptionRequests.delete(id);
        }
        if (this.pendingAdditions.size > 0) {
          this.updateSubscriptions([...this.pendingAdditions]);
        }
      } else if (event.type === "orderbook_snapshot") {
        await this.handleSnapshot(event.msg ?? {});
      } else if (event.type === "orderbook_delta") {
        await this.handleDelta(event.msg ?? {});
      } else if (event.type === "trade") {
        await this.handleTrade(event.msg ?? {});
      } else if (event.type === "error") {
        log("Kalshi stream subscription error", { details: event.msg });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Kalshi market event error", { error: message });
    }
  }

  private async handleSnapshot(message: Record<string, unknown>): Promise<void> {
    const ticker = String(message.market_ticker ?? "");
    if (!ticker) return;
    const state: KalshiBookState = {
      yes: levelsToMap(message.yes_dollars_fp),
      no: levelsToMap(message.no_dollars_fp),
    };
    this.books.set(ticker, state);
    await this.emitBooks(ticker, state);
  }

  private async handleDelta(message: Record<string, unknown>): Promise<void> {
    const ticker = String(message.market_ticker ?? "");
    const side = String(message.side ?? "") as "yes" | "no";
    const price = Number(message.price_dollars);
    const delta = Number(message.delta_fp);
    const state = this.books.get(ticker);
    if (!state || (side !== "yes" && side !== "no")) return;
    if (!Number.isFinite(price) || !Number.isFinite(delta)) return;
    const levels = state[side];
    const next = (levels.get(price) ?? 0) + delta;
    if (next <= 1e-8) levels.delete(price);
    else levels.set(price, next);
    await this.emitBooks(ticker, state);
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
    const yesBids = mapToLevels(state.yes, false);
    const noBids = mapToLevels(state.no, false);
    const yesAsks = complement(noBids);
    const noAsks = complement(yesBids);
    await this.onEvent(bookEvent(kalshiTokenId(ticker, "yes"), yesBids, yesAsks));
    await this.onEvent(bookEvent(kalshiTokenId(ticker, "no"), noBids, noAsks));
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

function complement(levels: OrderBookLevel[]): OrderBookLevel[] {
  return levels
    .map((level) => ({
      price: Number((1 - level.price).toFixed(4)),
      size: level.size,
    }))
    .sort((a, b) => a.price - b.price);
}

function bookEvent(
  tokenId: string,
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
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
    timestamp: String(Date.now()),
  };
}
