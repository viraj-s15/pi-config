import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readSpend, readSpendReport } from "../spend.ts";
import { readWeeklyCost, sumProviderSpend, weeklySpendRange, WEEK_SECONDS } from "../weekly-spend.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

function sessions(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-spend-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let seq = 0;
function msg(cost: unknown, opts: { ago?: number; provider?: string; model?: string; responseId?: string | null; id?: string; role?: string } = {}) {
  const ts = NOW - (opts.ago ?? 0);
  const responseId = opts.responseId === null ? undefined : (opts.responseId ?? `resp-${++seq}`);
  return JSON.stringify({
    type: "message", id: opts.id ?? `e${++seq}`, timestamp: new Date(ts).toISOString(),
    message: { role: opts.role ?? "assistant", provider: opts.provider ?? "openai", model: opts.model ?? "gpt-6.1-sol", responseId, timestamp: ts,
      usage: cost === undefined ? undefined : { cost: { total: cost } } },
  });
}
const write = (dir: string, project: string, name: string, lines: string[]) => {
  mkdirSync(join(dir, project), { recursive: true });
  writeFileSync(join(dir, project, name), lines.join("\n") + "\n");
};
const read = (dir: string) => readSpend({ dir, now: () => NOW });
function usageMsg(usage: Record<string, unknown>, opts: { ago?: number; provider?: string; model?: string; responseId?: string } = {}) {
  const ts = NOW - (opts.ago ?? 0);
  return JSON.stringify({ id: `usage-${++seq}`, timestamp: new Date(ts).toISOString(), message: {
    role: "assistant", provider: opts.provider ?? "openai", model: opts.model ?? "gpt-6.1-sol",
    responseId: opts.responseId ?? `usage-resp-${seq}`, timestamp: ts, usage,
  }});
}

test("sums assistant cost across all sessions and projects", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(1.5), msg(0.25)]);
  write(dir, "b", "2.jsonl", [msg(2)]);
  const spend = await read(dir);
  assert.equal(spend.total, 3.75);
  assert.equal(spend.messages, 3);
});

test("only the last 30 days count, judged per message, not per file", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(1, { ago: 29 * DAY + 23 * 3_600_000 }), msg(100, { ago: 30 * DAY + 1000 }), msg(50, { ago: 90 * DAY }), msg(2, { ago: 1000 })]);
  assert.equal((await read(dir)).total, 3);
});

test("a message exactly 30 days old has rolled off", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(5, { ago: 30 * DAY })]);
  assert.equal((await read(dir)).total, 0);
});

test("breaks spend down by provider and model, biggest first", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    msg(1, { provider: "anthropic", model: "claude-x" }),
    msg(4, { provider: "openai", model: "gpt-6.1-sol" }),
    msg(2, { provider: "openai", model: "gpt-6-luna" }),
    msg(0.5, { provider: "anthropic", model: "claude-x" }),
  ]);
  const spend = await read(dir);
  assert.deepEqual(spend.byProvider.map(p => [p.provider, p.total]), [["openai", 6], ["anthropic", 1.5]]);
  assert.deepEqual(spend.byProvider[0]!.models.map(m => [m.model, m.total]), [["gpt-6.1-sol", 4], ["gpt-6-luna", 2]]);
});

test("a forked session's copied history is not counted twice", async t => {
  const dir = sessions(t);
  const shared = [msg(3, { responseId: "r1", id: "x1" }), msg(1, { responseId: "r2", id: "x2" })];
  write(dir, "a", "original.jsonl", [...shared, msg(0.5)]);
  write(dir, "a", "fork.jsonl", [...shared, msg(0.25)]);
  assert.equal((await read(dir)).total, 4.75);
});

test("copies without a response id are matched on entry id and time", async t => {
  const dir = sessions(t);
  const copied = msg(2, { responseId: null, id: "same" });
  write(dir, "a", "1.jsonl", [copied]);
  write(dir, "a", "2.jsonl", [copied, msg(1, { responseId: null, id: "other" })]);
  assert.equal((await read(dir)).total, 3);
});

test("the same response id from different providers is not a duplicate", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(1, { provider: "openai", responseId: "same" }), msg(1, { provider: "anthropic", responseId: "same" })]);
  assert.equal((await read(dir)).total, 2);
});

test("ignores user messages, malformed lines, and missing or invalid costs", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    "not json {", "", JSON.stringify({ type: "session" }),
    msg(9, { role: "user" }), msg(undefined), msg("1.5"), msg(-3), msg(Number.NaN), msg(null),
    msg(0.75),
  ]);
  const spend = await read(dir);
  assert.equal(spend.total, 0.75);
  assert.equal(spend.messages, 1);
});

test("a missing sessions folder is just zero", async t => {
  const spend = await read(join(sessions(t), "nope"));
  assert.equal(spend.total, 0);
  assert.deepEqual(spend.byProvider, []);
});

test("new messages appear on the next read, unchanged files are not re-parsed", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(1)]);
  assert.equal((await read(dir)).total, 1);
  appendFileSync(join(dir, "a", "1.jsonl"), msg(2) + "\n");
  assert.equal((await read(dir)).total, 3);
  assert.equal((await read(dir)).total, 3);
});

test("only .jsonl files are read", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(1)]);
  write(dir, "a", "notes.txt", [msg(100)]);
  assert.equal((await read(dir)).total, 1);
});

test("daily totals: one bucket per day, oldest first, today last", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    msg(1, { ago: 1000 }), msg(2, { ago: 2000 }),
    msg(4, { ago: 1 * DAY + 1000 }),
    msg(8, { ago: 29 * DAY + 3_600_000 }),
    msg(99, { ago: 31 * DAY }),
  ]);
  const { daily, total } = await read(dir);
  assert.equal(daily.length, 30);
  assert.equal(daily[29], 3);
  assert.equal(daily[28], 4);
  assert.equal(daily[0], 8);
  assert.equal(daily.filter(d => d === 0).length, 27);
  assert.equal(daily.reduce((a, b) => a + b, 0), total);
});

test("a message stamped slightly in the future is excluded", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(1, { ago: -60_000 })]);
  const { daily } = await read(dir);
  assert.equal(daily[29], 0);
});

test("explicit spend bounds include from, exclude to and future records, and capture now once", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    msg(1, { ago: DAY }), msg(2, { ago: DAY - 1 }), msg(4), msg(8, { ago: -1000 }),
  ]);
  let clockCalls = 0;
  const spend = await readSpend({ dir, from: NOW - DAY, to: NOW, now: () => { clockCalls++; return NOW; } });
  assert.equal(spend.total, 3);
  assert.equal(spend.messages, 2);
  assert.equal(clockCalls, 1);
});

test("explicit from scans old-mtime files and supports inclusive exact timestamps", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(2, { ago: 1000 }), msg(3, { ago: 2 * DAY })]);
  const path = join(dir, "a", "1.jsonl");
  utimesSync(path, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
  const spend = await readSpend({ dir, from: NOW - 2 * DAY, to: NOW, now: () => NOW });
  assert.equal(spend.total, 5);
  assert.equal(spend.messages, 2);
});

test("counts token usage without cost and reports cache tokens and category costs", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    usageMsg({ input: 10, output: 4, cacheRead: 3, cacheWrite: 2 }),
    usageMsg({ input: 20, output: 5, cacheRead: 7, cacheWrite: 1, cost: { input: 0, output: 0.5, cacheRead: 0.25, cacheWrite: 0, total: 0.75 } }, { provider: "anthropic", model: "claude", ago: DAY }),
  ]);
  const result = await read(dir);
  assert.equal(result.messages, 2);
  assert.equal(result.total, 0.75);
  assert.deepEqual(result.metrics, {
    tokens: { input: 30, output: 9, cacheRead: 10, cacheWrite: 3, total: 52 },
    cost: { input: 0, output: 0.5, cacheRead: 0.25, cacheWrite: 0, total: 0.75 },
    unpricedMessages: 1, missingBreakdownMessages: 0,
    cacheSavings: { estimated: 0, coveredTokens: 7, unratedTokens: 3 },
  });
  const provider = result.byProvider[0]!;
  assert.equal(provider.provider, "anthropic");
  assert.equal(provider.metrics?.tokens.total, 33);
  assert.deepEqual(provider.models[0]?.metrics, provider.metrics);
});

test("daily token buckets aggregate globally and per provider", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    usageMsg({ input: 2, output: 1, cacheRead: 3, cacheWrite: 4 }, { provider: "openai" }),
    usageMsg({ input: 5, output: 1 }, { provider: "anthropic", ago: DAY + 1000 }),
  ]);
  const spend = await read(dir);
  assert.equal(spend.dailyTokens?.[29], 10);
  assert.equal(spend.dailyTokens?.[28], 6);
  assert.equal(spend.byProvider.find(p => p.provider === "openai")?.dailyTokens?.[29], 10);
  assert.equal(spend.byProvider.find(p => p.provider === "anthropic")?.dailyTokens?.[28], 6);
});

test("cache savings estimate priced tokens and leave incomplete pricing unrated", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    usageMsg({ input: 100, cacheRead: 50, cost: { input: 1, cacheRead: 0.2, total: 1.2 } }, { provider: "openai", model: "priced" }),
    usageMsg({ input: 0, cacheRead: 7, cost: { input: 0, cacheRead: 0, total: 0 } }, { provider: "openai", model: "zero-input" }),
    usageMsg({ input: 20, cacheRead: 3, cost: { input: 0.4, total: 0.4 } }, { provider: "anthropic", model: "missing-cache-rate" }),
  ]);
  const spend = await read(dir);
  assert.deepEqual(spend.metrics?.cacheSavings, { estimated: 0.3, coveredTokens: 50, unratedTokens: 10 });
  assert.deepEqual(spend.byProvider.find(p => p.provider === "openai")?.metrics?.cacheSavings,
    { estimated: 0.3, coveredTokens: 50, unratedTokens: 7 });
  assert.deepEqual(spend.byProvider.find(p => p.provider === "openai")?.models.find(m => m.model === "priced")?.metrics?.cacheSavings,
    { estimated: 0.3, coveredTokens: 50, unratedTokens: 0 });
  assert.deepEqual(spend.byProvider.find(p => p.provider === "anthropic")?.metrics?.cacheSavings,
    { estimated: 0, coveredTokens: 0, unratedTokens: 3 });
});

test("distinguishes missing category costs from actual zero costs", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    usageMsg({ input: 1, cost: { total: 2 } }),
    usageMsg({ output: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
  ]);
  const result = await read(dir);
  assert.equal(result.metrics?.missingBreakdownMessages, 1);
  assert.equal(result.metrics?.cost.total, 2);
  assert.equal(result.metrics?.cost.input, 0);
  assert.equal(result.metrics?.unpricedMessages, 0);
});

test("report summarizes all time and exact rolling 7/30/60-day boundaries in one API", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    msg(1, { ago: 7 * DAY }), msg(2, { ago: 7 * DAY - 1 }),
    msg(4, { ago: 30 * DAY }), msg(8, { ago: 30 * DAY - 1 }),
    msg(16, { ago: 60 * DAY }), msg(32, { ago: 60 * DAY - 1 }),
  ]);
  const report = await readSpendReport({ dir, now: () => NOW });
  assert.deepEqual([report.allTime.total, report.week.total, report.month.total, report.twoMonths.total], [63, 2, 11, 47]);
  assert.deepEqual([report.week.days, report.month.days, report.twoMonths.days], [7, 30, 60]);
});

test("all-time report includes records in files with old mtimes", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [msg(5, { ago: 90 * DAY })]);
  utimesSync(join(dir, "a", "1.jsonl"), new Date(NOW - 100 * DAY), new Date(NOW - 100 * DAY));
  const report = await readSpendReport({ dir, now: () => NOW });
  assert.equal(report.allTime.total, 5);
  assert.equal(report.twoMonths.total, 0);
});

test("weekly range requires exact, live seven-day metadata and prefers the general bucket", () => {
  const now = NOW;
  const reset = now + 3 * DAY;
  const range = weeklySpendRange({
    anthropic: [
      { label: "7d Opus", used: 50, resetsAt: reset, durationSeconds: WEEK_SECONDS },
      { label: "7d", used: 20, resetsAt: reset, durationSeconds: WEEK_SECONDS },
      { label: "5h", used: 10, resetsAt: reset, durationSeconds: 5 * 3600 },
    ],
  }, ["anthropic"], now);
  assert.deepEqual(range, { from: reset - WEEK_SECONDS * 1000, to: reset });
});

test("weekly range rejects absent, expired, too-distant and non-seven-day windows", () => {
  const now = NOW;
  assert.equal(weeklySpendRange({ x: [{ label: "7d", used: 1, durationSeconds: WEEK_SECONDS }] }, ["x"], now), undefined);
  assert.equal(weeklySpendRange({ x: [{ label: "7d", used: 1, resetsAt: now - 1, durationSeconds: WEEK_SECONDS }] }, ["x"], now), undefined);
  assert.equal(weeklySpendRange({ x: [{ label: "7d", used: 1, resetsAt: now + 8 * DAY, durationSeconds: WEEK_SECONDS }] }, ["x"], now), undefined);
  assert.equal(weeklySpendRange({ x: [{ label: "7d", used: 1, resetsAt: now + DAY }] }, ["x"], now), undefined);
});

test("weekly spend provider IDs accept Codex aliases without double counting", () => {
  const spend = {
    total: 9, messages: 2, days: 30, daily: [],
    byProvider: [
      { provider: "openai", total: 4, daily: [], models: [] },
      { provider: "anthropic", total: 5, daily: [], models: [] },
      { provider: "google", total: 7, daily: [], models: [] },
    ],
  };
  assert.equal(sumProviderSpend(spend, ["openai", "openai-codex", "openai"]), 4);
  assert.equal(sumProviderSpend(spend, ["anthropic"]), 5);
  // Unattributed providers (for example Antigravity's separate groups) stay out.
  assert.equal(sumProviderSpend(spend, []), 0);
});

test("each provider carries its own daily series, summing to the overall daily", async t => {
  const dir = sessions(t);
  write(dir, "a", "1.jsonl", [
    msg(3, { provider: "openai", ago: 1000 }), msg(1, { provider: "anthropic", ago: 1000 }),
    msg(2, { provider: "openai", ago: 2 * DAY }), msg(5, { provider: "anthropic", ago: 2 * DAY + 5000 }),
  ]);
  const spend = await read(dir);
  const openai = spend.byProvider.find(p => p.provider === "openai")!;
  const anthropic = spend.byProvider.find(p => p.provider === "anthropic")!;
  assert.equal(openai.daily.length, 30);
  assert.deepEqual([openai.daily[29], openai.daily[27]], [3, 2]);
  assert.deepEqual([anthropic.daily[29], anthropic.daily[27]], [1, 5]);
  const summed = spend.daily.map((_, i) => spend.byProvider.reduce((a, p) => a + p.daily[i]!, 0));
  assert.deepEqual(summed, spend.daily);
});

test("weekly cost reads each subscription's own reset-aligned interval, including the exact start", async t => {
  const dir = sessions(t);
  const from = NOW - 4 * DAY;
  const duplicate = msg(2, { ago: 4 * DAY, provider: "openai", responseId: "boundary" });
  write(dir, "a", "1.jsonl", [duplicate, msg(100, { ago: 4 * DAY + 1 }), msg(3, { ago: DAY }), msg(9, { provider: "anthropic", ago: DAY })]);
  write(dir, "b", "fork.jsonl", [duplicate]);
  const result = await readWeeklyCost([{ label: "7d", used: 30, resetsAt: from + 7 * DAY, durationSeconds: WEEK_SECONDS }], ["openai", "openai-codex"], dir, NOW);
  assert.deepEqual(result, { status: "ready", total: 5, from, to: from + 7 * DAY, asOf: NOW });
  const other = await readWeeklyCost([{ label: "7d", used: 30, resetsAt: NOW + 6 * DAY, durationSeconds: WEEK_SECONDS }], ["anthropic"], dir, NOW);
  assert.equal(other.status, "ready");
  if (other.status === "ready") assert.equal(other.total, 9);
});

test("weekly windows reject expired general windows, boundary resets and ambiguous model group resets", () => {
  const window = (label: string, resetsAt: number) => ({ label, resetsAt, used: 10, durationSeconds: WEEK_SECONDS });
  for (const wins of [
    [window("7d", NOW)],
    [window("7d Opus", NOW + DAY)],
    [window("7d", NOW + DAY), window("7d", NOW + 2 * DAY)],
    [window("7d", NOW - 1), window("7d Opus", NOW + DAY)],
    [window("Claude weekly", NOW + DAY), window("Gemini weekly", NOW + 2 * DAY)],
  ]) assert.equal(weeklySpendRange({ x: wins }, ["x"], NOW), undefined);
  assert.deepEqual(weeklySpendRange({ x: [window("Claude weekly", NOW + DAY), window("Gemini weekly", NOW + DAY)] }, ["x"], NOW), { from: NOW - 6 * DAY, to: NOW + DAY });
});

test("missing weekly metadata never reads history and unavailable history never becomes a zero-dollar week", async t => {
  let calls = 0;
  const missing = await readWeeklyCost([], ["openai"], "unused", NOW, async () => { calls++; throw Error("must not run"); });
  assert.equal(missing.status, "unavailable"); assert.equal(calls, 0);
  const noHistory = await readWeeklyCost([{ label: "7d", used: 0, resetsAt: NOW + DAY, durationSeconds: WEEK_SECONDS }], ["openai"], join(sessions(t), "missing"), NOW);
  assert.equal(noHistory.status, "unavailable");
});
