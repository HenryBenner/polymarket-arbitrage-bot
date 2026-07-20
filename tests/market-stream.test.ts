import assert from "node:assert/strict";
import test from "node:test";
import { MarketStream } from "../src/market-stream.js";

class FakeSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  disconnect(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

test("market stream reconnects and resubscribes all tokens", async () => {
  const sockets: FakeSocket[] = [];
  const stream = new MarketStream(
    () => undefined,
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    1,
  );
  stream.subscribe(["a", "b"]);
  assert.equal(sockets.length, 1);
  sockets[0]!.open();
  assert.match(sockets[0]!.sent[0]!, /"a"/);
  assert.match(sockets[0]!.sent[0]!, /"b"/);

  sockets[0]!.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  assert.match(sockets[1]!.sent[0]!, /"a"/);
  assert.match(sockets[1]!.sent[0]!, /"b"/);
  stream.close();
});
