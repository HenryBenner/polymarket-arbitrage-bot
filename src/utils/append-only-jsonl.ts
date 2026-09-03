import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";

/** One buffered append stream; callers never wait for individual records. */
export class AppendOnlyJsonl {
  private pending = 0;
  private failure: Error | undefined;

  private constructor(
    private readonly stream: WriteStream,
    onError: (error: Error) => void,
  ) {
    stream.on("error", (error: Error) => {
      this.failure = error;
      onError(error);
    });
  }

  static async open(path: string, onError: (error: Error) => void): Promise<AppendOnlyJsonl> {
    await mkdir(dirname(path), { recursive: true });
    const stream = createWriteStream(path, { flags: "a" });
    const log = new AppendOnlyJsonl(stream, onError);
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.once("open", () => {
        stream.off("error", reject);
        resolve();
      });
    });
    return log;
  }

  get queueSize(): number { return this.pending; }

  write(value: unknown): void {
    if (this.failure || this.stream.destroyed || this.stream.writableEnded) return;
    // Serialize now so later RAM mutations cannot change an earlier log entry.
    const line = `${JSON.stringify(value)}\n`;
    this.pending += 1;
    this.stream.write(line, () => { this.pending -= 1; });
  }

  async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      this.stream.write("", (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    const completion = finished(this.stream, { cleanup: true });
    this.stream.end();
    await completion;
    if (this.failure) throw this.failure;
  }
}
