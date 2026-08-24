import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRotatingJsonLine } from "../src/utils/rotating-jsonl.js";

test("JSONL logs rotate with bounded archives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rotating-jsonl-"));
  const path = join(directory, "events.jsonl");
  try {
    for (let index = 0; index < 20; index += 1) {
      await appendRotatingJsonLine(
        path,
        { index, payload: "x".repeat(30) },
        { maxBytes: 160, archives: 2 },
      );
    }
    const names = (await readdir(directory)).sort();
    assert.deepEqual(names, ["events.jsonl", "events.jsonl.1", "events.jsonl.2"]);
    for (const name of names) {
      const lines = (await readFile(join(directory, name), "utf8"))
        .trim()
        .split("\n");
      assert.ok(lines.length > 0);
      for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
