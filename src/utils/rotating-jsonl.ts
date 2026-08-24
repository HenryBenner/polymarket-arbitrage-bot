import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface RotatingJsonlOptions {
  maxBytes?: number;
  archives?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ARCHIVES = 4;
const queues = new Map<string, Promise<void>>();

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function rotate(
  path: string,
  incomingBytes: number,
  maxBytes: number,
  archives: number,
): Promise<void> {
  let currentBytes = 0;
  try {
    currentBytes = (await stat(path)).size;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code !== "ENOENT") throw error;
  }
  if (currentBytes === 0 || currentBytes + incomingBytes <= maxBytes) return;

  if (archives > 0) {
    await rm(`${path}.${archives}`, { force: true });
    for (let index = archives - 1; index >= 1; index -= 1) {
      const source = `${path}.${index}`;
      if (await exists(source)) await rename(source, `${path}.${index + 1}`);
    }
    await rename(path, `${path}.1`);
  } else {
    await rm(path, { force: true });
  }
}

/**
 * Append one JSONL record with a per-path write queue and bounded archives.
 * Defaults retain the active 5 MiB file plus four 5 MiB archives.
 */
export async function appendRotatingJsonLine(
  path: string,
  value: unknown,
  options: RotatingJsonlOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const archives = options.archives ?? DEFAULT_ARCHIVES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("rotating JSONL maxBytes must be a positive integer");
  }
  if (!Number.isInteger(archives) || archives < 0) {
    throw new Error("rotating JSONL archives must be a non-negative integer");
  }
  const line = `${JSON.stringify(value)}\n`;
  const incomingBytes = Buffer.byteLength(line, "utf8");
  const previous = queues.get(path) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    await rotate(path, incomingBytes, maxBytes, archives);
    await appendFile(path, line, "utf8");
  });
  queues.set(path, queued);
  try {
    await queued;
  } finally {
    if (queues.get(path) === queued) queues.delete(path);
  }
}
