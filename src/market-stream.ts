import { log } from "./logger.js";

export interface MarketStreamEvent {
  event_type?: string;
  asset_id?: string;
  market?: string;
  timestamp?: string;
  [key: string]: unknown;
}

type EventHandler = (event: MarketStreamEvent) => void | Promise<void>;
type SocketFactory = (url: string) => WebSocket;

export class MarketStream {
  private socket: WebSocket | null = null;
  private readonly tokenIds = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;
  private stopped = false;

  constructor(
    private readonly onEvent: EventHandler,
    private readonly socketFactory: SocketFactory = (url) => new WebSocket(url),
    private readonly minimumReconnectDelayMs = 1_000,
  ) {
    this.reconnectDelayMs = minimumReconnectDelayMs;
  }

  subscribe(tokenIds: string[]): void {
    const additions = tokenIds.filter((tokenId) => {
      if (this.tokenIds.has(tokenId)) return false;
      this.tokenIds.add(tokenId);
      return true;
    });
    if (additions.length === 0) return;

    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      this.connect();
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({ assets_ids: additions, operation: "subscribe" }),
      );
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

  private connect(): void {
    if (
      this.stopped ||
      this.tokenIds.size === 0 ||
      (this.socket &&
        (this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }

    const socket = this.socketFactory(
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelayMs = this.minimumReconnectDelayMs;
      socket.send(
        JSON.stringify({
          type: "market",
          assets_ids: [...this.tokenIds],
          custom_feature_enabled: true,
        }),
      );
      this.startHeartbeat(socket);
      log("Paper market stream connected", { tokens: this.tokenIds.size });
    });

    socket.addEventListener("message", (message) => {
      void this.handleMessage(message.data);
    });

    socket.addEventListener("error", () => {
      log("Paper market stream error");
    });

    socket.addEventListener("close", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("PING");
    }, 10_000);
  }

  private async handleMessage(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof Blob) {
      text = await data.text();
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else {
      return;
    }
    if (text === "PONG" || text === "PING" || text === "") return;

    let parsed: MarketStreamEvent | MarketStreamEvent[];
    try {
      parsed = JSON.parse(text) as MarketStreamEvent | MarketStreamEvent[];
    } catch {
      return;
    }
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      try {
        await this.onEvent(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("Paper market event error", { error: message });
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.tokenIds.size === 0) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    log("Paper market stream reconnect scheduled", { delayMs: delay });
  }
}
