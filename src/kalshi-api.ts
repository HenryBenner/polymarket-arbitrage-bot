import {
  constants,
  createPrivateKey,
  sign,
  type KeyObject,
} from "node:crypto";
import type { BotConfig } from "./config.js";

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  open_time: string;
  close_time: string;
  expected_expiration_time?: string;
  status: string;
  result?: "yes" | "no" | "";
  price_level_structure?: string;
  price_ranges?: Array<{ start: string; end: string; step: string }>;
}

export interface KalshiOrderbook {
  orderbook_fp?: {
    yes_dollars?: Array<[string, string]>;
    no_dollars?: Array<[string, string]>;
  };
}

export interface KalshiOrderResponse {
  order_id: string;
  client_order_id?: string;
  fill_count: string;
  remaining_count: string;
  average_fill_price?: string;
  average_fee_paid?: string;
  ts_ms: number;
}

export interface KalshiOrder {
  order_id: string;
  client_order_id?: string;
  ticker: string;
  status: string;
  outcome_side?: "yes" | "no";
  book_side?: "bid" | "ask";
  fill_count_fp?: string;
  remaining_count_fp?: string;
  initial_count_fp?: string;
}

export interface KalshiFill {
  fill_id: string;
  trade_id: string;
  order_id: string;
  ticker?: string;
  market_ticker?: string;
  outcome_side?: "yes" | "no";
  book_side?: "bid" | "ask";
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  is_taker: boolean;
  fee_cost?: string;
  created_time?: string;
  ts?: number;
}

export interface KalshiBalance {
  balance: number;
  portfolio_value: number;
  updated_ts: number;
}

function signingPath(apiHost: string, path: string): string {
  const base = new URL(apiHost);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base.pathname.replace(/\/$/, "")}${suffix.split("?")[0]}`;
}

export function kalshiAuthHeaders(
  apiKeyId: string,
  privateKey: KeyObject,
  method: string,
  path: string,
  apiHost: string,
): Record<string, string> {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method.toUpperCase()}${signingPath(apiHost, path)}`;
  const signature = sign("sha256", Buffer.from(message), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

export function kalshiWebSocketHeaders(
  apiKeyId: string,
  privateKey: KeyObject,
): Record<string, string> {
  const timestamp = Date.now().toString();
  const signature = sign(
    "sha256",
    Buffer.from(`${timestamp}GET/trade-api/ws/v2`),
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
  ).toString("base64");
  return {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

export async function loadKalshiPrivateKey(
  config: BotConfig,
): Promise<KeyObject> {
  const pem = config.kalshiPrivateKeyPem?.replace(/\\n/g, "\n");
  if (!pem) {
    throw new Error("Kalshi private key is missing; set KALSHI_PRIVATE_KEY");
  }
  return createPrivateKey(pem);
}

export class KalshiClient {
  private privateKey: KeyObject | null = null;

  constructor(private readonly config: BotConfig) {}

  async init(): Promise<void> {
    if (
      this.config.kalshiApiKeyId &&
      this.config.kalshiPrivateKeyPem
    ) {
      this.privateKey = await loadKalshiPrivateKey(this.config);
    }
  }

  async getMarkets(seriesTicker: string): Promise<KalshiMarket[]> {
    const result = await this.request<{ markets: KalshiMarket[] }>(
      `/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=100`,
      { authenticated: false },
    );
    return result.markets ?? [];
  }

  async getMarket(ticker: string): Promise<KalshiMarket | null> {
    try {
      const result = await this.request<{ market: KalshiMarket }>(
        `/markets/${encodeURIComponent(ticker)}`,
        { authenticated: false },
      );
      return result.market ?? null;
    } catch {
      return null;
    }
  }

  async getOrderbook(ticker: string): Promise<KalshiOrderbook> {
    return this.request<KalshiOrderbook>(
      `/markets/${encodeURIComponent(ticker)}/orderbook`,
      { authenticated: false },
    );
  }

  async createOrder(input: {
    ticker: string;
    clientOrderId: string;
    outcome: "yes" | "no";
    count: number;
    price: number;
    timeInForce: "fill_or_kill" | "immediate_or_cancel" | "good_till_canceled";
    postOnly: boolean;
  }): Promise<KalshiOrderResponse> {
    const yesPrice = input.outcome === "yes" ? input.price : 1 - input.price;
    return this.request<KalshiOrderResponse>("/portfolio/events/orders", {
      method: "POST",
      body: {
        ticker: input.ticker,
        client_order_id: input.clientOrderId,
        side: input.outcome === "yes" ? "bid" : "ask",
        count: input.count.toFixed(2),
        price: yesPrice.toFixed(4),
        time_in_force: input.timeInForce,
        self_trade_prevention_type: "taker_at_cross",
        post_only: input.postOnly,
        cancel_order_on_pause: true,
        reduce_only: false,
        subaccount: this.config.kalshiSubaccount,
        exchange_index: 0,
      },
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request(`/portfolio/orders/${encodeURIComponent(orderId)}`, {
      method: "DELETE",
    });
  }

  async getOrders(ticker: string): Promise<KalshiOrder[]> {
    const query = new URLSearchParams({
      ticker,
      subaccount: String(this.config.kalshiSubaccount),
    });
    const result = await this.request<{ orders: KalshiOrder[] }>(
      `/portfolio/orders?${query}`,
    );
    return result.orders ?? [];
  }

  async getFills(ticker: string): Promise<KalshiFill[]> {
    const query = new URLSearchParams({
      ticker,
      subaccount: String(this.config.kalshiSubaccount),
      limit: "1000",
    });
    const result = await this.request<{ fills: KalshiFill[] }>(
      `/portfolio/fills?${query}`,
    );
    return result.fills ?? [];
  }

  async getBalance(): Promise<number> {
    const query = new URLSearchParams({
      subaccount: String(this.config.kalshiSubaccount),
    });
    const result = await this.request<KalshiBalance>(
      `/portfolio/balance?${query}`,
    );
    const cents = Number(result.balance);
    if (!Number.isFinite(cents) || cents < 0) {
      throw new Error(`Kalshi returned an invalid balance: ${result.balance}`);
    }
    return cents / 100;
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const authenticated = options.authenticated ?? true;
    const headers: Record<string, string> = {};
    if (authenticated) {
      if (!this.config.kalshiApiKeyId || !this.privateKey) {
        throw new Error("Kalshi authenticated request attempted without API credentials");
      }
      Object.assign(
        headers,
        kalshiAuthHeaders(
          this.config.kalshiApiKeyId,
          this.privateKey,
          method,
          path,
          this.config.kalshiApiHost,
        ),
      );
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(
      `${this.config.kalshiApiHost.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
      {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      },
    );
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const details =
        payload && typeof payload === "object"
          ? JSON.stringify(payload)
          : text;
      throw new Error(`Kalshi API ${method} ${path} failed (${response.status}): ${details}`);
    }
    return payload as T;
  }
}

export function kalshiTokenId(
  ticker: string,
  outcome: "yes" | "no",
): string {
  return `${ticker}::${outcome}`;
}

export function parseKalshiTokenId(
  tokenId: string,
): { ticker: string; outcome: "yes" | "no" } | null {
  const match = tokenId.match(/^(.+)::(yes|no)$/);
  if (!match) return null;
  return {
    ticker: match[1]!,
    outcome: match[2] as "yes" | "no",
  };
}
