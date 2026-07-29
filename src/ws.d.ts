declare module "ws" {
  import { EventEmitter } from "node:events";

  export interface ClientOptions {
    headers?: Record<string, string>;
  }

  export default class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: number;
    constructor(url: string, options?: ClientOptions);
    send(data: string): void;
    close(): void;
    ping(): void;
  }
}
