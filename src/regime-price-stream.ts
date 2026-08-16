import WebSocket from "ws";
import type { BotConfig } from "./config.js";
import {
  kalshiWebSocketHeaders,
  loadKalshiPrivateKey,
} from "./kalshi-api.js";
import { log } from "./logger.js";

export type RegimePriceSource = "brti" | "coinbase" | "kalshi_proxy";

export interface RegimePricePoint {
  source: RegimePriceSource;
  timestampMs: number;
  price: number;
  sequence?: number;
  subscriptionId?: number;
  sequenceValid?: boolean;
  receivedAtMs?: number;
  trailing60SecondAverage?: number;
  finalMinuteAverage15m?: number;
  finalMinuteWindowSize?: number;
}

export interface RegimePriceProvider {
  readonly source: RegimePriceSource;
  start(onPoint: (point: RegimePricePoint) => void): Promise<void> | void;
  close(): void;
}

export interface BrtiProtocolMessage {
  point: RegimePricePoint | null;
  sid: number | null;
  sequence: number | null;
  error: { code: number | null; message: string } | null;
}

type SocketFactory = (
  url: string,
  options?: ConstructorParameters<typeof WebSocket>[1],
) => WebSocket;

export function parseBrtiMessage(value: unknown): RegimePricePoint | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "cfbenchmarks_value") return null;
  const message = event.msg as Record<string, unknown> | undefined;
  if (!message || message.index_id !== "BRTI") return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(String(message.data ?? "")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const price = Number(payload.value);
  const timestampMs = Number(payload.time ?? message.received_at);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestampMs)) {
    return null;
  }
  const sequence = Number(event.seq);
  const subscriptionId = Number(event.sid);
  const receivedAtMs = Number(message.received_at);
  const average = message.avg_60s_data as Record<string, unknown> | undefined;
  const finalAverage = message.last_60s_windowed_average_15min as
    | Record<string, unknown>
    | undefined;
  const trailing60SecondAverage = Number(average?.value);
  const finalMinuteAverage15m = Number(finalAverage?.value);
  const finalMinuteWindowSize = Number(finalAverage?.window_size);
  return {
    source: "brti",
    timestampMs,
    price,
    ...(Number.isFinite(sequence)
      ? { sequence, sequenceValid: true }
      : {}),
    ...(Number.isFinite(subscriptionId) ? { subscriptionId } : {}),
    ...(Number.isFinite(receivedAtMs) ? { receivedAtMs } : {}),
    ...(Number.isFinite(trailing60SecondAverage)
      ? { trailing60SecondAverage }
      : {}),
    ...(Number.isFinite(finalMinuteAverage15m)
      ? { finalMinuteAverage15m }
      : {}),
    ...(Number.isFinite(finalMinuteWindowSize)
      ? { finalMinuteWindowSize }
      : {}),
  };
}

export function parseBrtiProtocolMessage(value: unknown): BrtiProtocolMessage {
  if (!value || typeof value !== "object") {
    return { point: null, sid: null, sequence: null, error: null };
  }
  const event = value as Record<string, unknown>;
  const message = event.msg as Record<string, unknown> | undefined;
  const sid = Number(event.sid);
  const sequence = Number(event.seq);
  return {
    point: parseBrtiMessage(value),
    sid: Number.isFinite(sid) ? sid : null,
    sequence: Number.isFinite(sequence) ? sequence : null,
    error:
      event.type === "error"
        ? {
            code: Number.isFinite(Number(message?.code))
              ? Number(message?.code)
              : null,
            message: String(message?.msg ?? message?.message ?? "subscription error"),
          }
        : null,
  };
}

export function parseCoinbaseMessage(value: unknown): RegimePricePoint[] {
  if (!value || typeof value !== "object") return [];
  const event = value as Record<string, unknown>;
  // Coinbase Exchange public ticker compatibility.
  if (event.type === "ticker") {
    const timestampMs = Date.parse(String(event.time ?? ""));
    const price = Number(event.price);
    return Number.isFinite(timestampMs) && Number.isFinite(price) && price > 0
      ? [{ source: "coinbase", timestampMs, price }]
      : [];
  }
  if (event.channel !== "ticker" || !Array.isArray(event.events)) return [];
  const timestampMs = Date.parse(String(event.timestamp ?? ""));
  const points: RegimePricePoint[] = [];
  for (const item of event.events as Array<Record<string, unknown>>) {
    if (!Array.isArray(item.tickers)) continue;
    for (const ticker of item.tickers as Array<Record<string, unknown>>) {
      const price = Number(ticker.price);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestampMs)) {
        continue;
      }
      points.push({ source: "coinbase", timestampMs, price });
    }
  }
  return points;
}

abstract class ReconnectingProvider implements RegimePriceProvider {
  abstract readonly source: RegimePriceSource;
  protected socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1_000;
  private stopped = false;
  protected onPoint: ((point: RegimePricePoint) => void) | null = null;

  constructor(protected readonly socketFactory: SocketFactory) {}

  start(onPoint: (point: RegimePricePoint) => void): void {
    this.onPoint = onPoint;
    this.stopped = false;
    void this.connect();
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

  protected abstract openSocket(): Promise<WebSocket> | WebSocket;
  protected abstract subscribe(socket: WebSocket): void;
  protected abstract handleMessage(data: unknown): void;

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    try {
      const socket = await this.openSocket();
      this.socket = socket;
      socket.on("open", () => {
        this.reconnectDelayMs = 1_000;
        this.subscribe(socket);
        this.heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.ping();
        }, 10_000);
        log("Regime price stream connected", { source: this.source });
      });
      socket.on("message", (data: unknown) => this.handleMessage(data));
      socket.on("error", (error: Error) => {
        log("Regime price stream error", {
          source: this.source,
          error: error.message,
        });
      });
      socket.on("close", () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.socket === socket) this.socket = null;
        this.scheduleReconnect();
      });
    } catch (error) {
      log("Regime price stream connection failed", {
        source: this.source,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }
}

export class KalshiBrtiProvider extends ReconnectingProvider {
  readonly source = "brti" as const;
  private readonly lastSequenceBySid = new Map<number, number>();

  constructor(
    private readonly config: BotConfig,
    socketFactory: SocketFactory = (url, options) => new WebSocket(url, options),
  ) {
    super(socketFactory);
  }

  protected async openSocket(): Promise<WebSocket> {
    if (!this.config.kalshiApiKeyId) {
      throw new Error("KALSHI_API_KEY_ID is required for BRTI");
    }
    const privateKey = await loadKalshiPrivateKey(this.config);
    return this.socketFactory(this.config.kalshiWsHost, {
      headers: kalshiWebSocketHeaders(this.config.kalshiApiKeyId, privateKey),
    });
  }

  protected subscribe(socket: WebSocket): void {
    this.lastSequenceBySid.clear();
    socket.send(
      JSON.stringify({
        id: 1,
        cmd: "subscribe",
        params: {
          channels: ["cfbenchmarks_value"],
          index_ids: ["BRTI"],
        },
      }),
    );
  }

  protected handleMessage(data: unknown): void {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    try {
      const protocol = parseBrtiProtocolMessage(JSON.parse(text));
      if (protocol.error) {
        log("BRTI subscription rejected", protocol.error);
        this.socket?.close();
        return;
      }
      if (!protocol.point) return;
      if (protocol.sid !== null && protocol.sequence !== null) {
        const previous = this.lastSequenceBySid.get(protocol.sid);
        if (previous !== undefined && protocol.sequence !== previous + 1) {
          log("BRTI sequence gap; reconnecting", {
            sid: protocol.sid,
            previous,
            received: protocol.sequence,
          });
          this.socket?.close();
          return;
        }
        this.lastSequenceBySid.set(protocol.sid, protocol.sequence);
      }
      this.onPoint?.(protocol.point);
    } catch {
      // Ignore non-JSON protocol frames.
    }
  }
}

export class CoinbasePriceProvider extends ReconnectingProvider {
  readonly source = "coinbase" as const;

  constructor(
    private readonly config: BotConfig,
    socketFactory: SocketFactory = (url) => new WebSocket(url),
  ) {
    super(socketFactory);
  }

  protected openSocket(): WebSocket {
    return this.socketFactory(this.config.ladderV10CoinbaseWsHost);
  }

  protected subscribe(socket: WebSocket): void {
    socket.send(
      JSON.stringify({
        type: "subscribe",
        product_ids: [this.config.ladderV10CoinbaseProduct],
        channel: "ticker",
      }),
    );
    socket.send(JSON.stringify({ type: "subscribe", channel: "heartbeats" }));
  }

  protected handleMessage(data: unknown): void {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    try {
      for (const point of parseCoinbaseMessage(JSON.parse(text))) {
        this.onPoint?.(point);
      }
    } catch {
      // Ignore non-JSON protocol frames.
    }
  }
}
