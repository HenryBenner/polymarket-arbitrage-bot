const DEFAULT_STATUS_LOG_INTERVAL_MS = 30_000;
const MAX_THROTTLE_KEYS = 2_048;
const lastLogByKey = new Map<string, number>();

export function log(message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}] ${message}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] ${message}`);
  }
}

/** Rate-limit observational status messages without delaying trading work. */
export function logThrottled(
  message: string,
  key: string,
  data?: Record<string, unknown>,
  intervalMs = DEFAULT_STATUS_LOG_INTERVAL_MS,
): boolean {
  const now = Date.now();
  const throttleKey = `${message}:${key}`;
  const previous = lastLogByKey.get(throttleKey);
  if (previous !== undefined && now - previous < intervalMs) return false;
  if (previous === undefined && lastLogByKey.size >= MAX_THROTTLE_KEYS) {
    const oldest = lastLogByKey.keys().next().value as string | undefined;
    if (oldest) lastLogByKey.delete(oldest);
  }
  lastLogByKey.set(throttleKey, now);
  log(message, data);
  return true;
}

export function logError(error: unknown): void {
  console.error(error);
}
