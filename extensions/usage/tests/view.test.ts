import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { UsageView, refreshUsageSections, type Section, type UsageSource } from "../index.ts";
import type { Spend, SpendReport, UsageTotals } from "../spend.ts";
import { WEEK_SECONDS } from "../weekly-spend.ts";

const DAY = 86_400_000;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const windows = (now: number, days = 3) => [
  { label: "5h", used: 24, durationSeconds: 18_000, resetsAt: now + 3_600_000 },
  { label: "7d", used: 61, durationSeconds: WEEK_SECONDS, resetsAt: now + days * DAY },
];

function metrics(tokensTotal: number, cacheSavings = true): UsageTotals {
  return {
    tokens: { input: tokensTotal * 0.6, cacheRead: tokensTotal * 0.15, cacheWrite: tokensTotal * 0.05, output: tokensTotal * 0.2, total: tokensTotal },
    cost: { input: 0.12, cacheRead: 0.01, cacheWrite: 0.03, output: 0.24, total: 0.40 },
    unpricedMessages: 0,
    missingBreakdownMessages: 0,
    ...(cacheSavings ? { cacheSavings: { estimated: 0.08, coveredTokens: 2_500, unratedTokens: 0 } } : {}),
  };
}
function spend(total: number, days: number, count: number, tokenCount = 20_000): Spend {
  const m = metrics(tokenCount);
  const daily = Array.from({ length: days }, (_, i) => i === days - 1 ? total : 0);
  const dailyTokens = Array.from({ length: days }, (_, i) => i === days - 1 ? tokenCount : 0);
  return {
    total, messages: count, days, complete: true, daily, dailyTokens, metrics: m,
    byProvider: [
      { provider: "openai", total: total * 0.75, daily: daily.map(n => n * 0.75), dailyTokens: dailyTokens.map(n => Math.round(n * 0.75)), metrics: metrics(tokenCount * 0.75),
        models: [{ model: "gpt-primary", total: total * 0.75, metrics: metrics(tokenCount * 0.75) }] },
      { provider: "anthropic", total: total * 0.25, daily: daily.map(n => n * 0.25), dailyTokens: dailyTokens.map(n => Math.round(n * 0.25)), metrics: metrics(tokenCount * 0.25),
        models: [{ model: "claude-sonnet", total: total * 0.25, metrics: metrics(tokenCount * 0.25) }] },
    ],
  };
}
function report(): SpendReport {
  return {
    allTime: { ...spend(123.45, 60, 42, 987_654), complete: true },
    week: spend(12.34, 7, 5, 50_000),
    month: spend(45.67, 30, 18, 180_000),
    twoMonths: spend(89.01, 60, 35, 400_000),
  };
}
function sections(): Section[] {
  const now = Date.now();
  return [
    { name: "Anthropic", loading: false, extra: [], wins: [...windows(now), { label: "7d Opus", used: 43, durationSeconds: WEEK_SECONDS, resetsAt: now + 3 * DAY }], weekly: { status: "ready", total: 23.45, from: now - 4 * DAY, to: now + 3 * DAY, asOf: now } },
    { name: "Codex", plan: "plus", loading: false, extra: [], wins: windows(now, 6), weekly: { status: "ready", total: 8.1, from: now - DAY, to: now + 6 * DAY, asOf: now } },
    { name: "Antigravity", loading: false, extra: [], wins: [], weekly: { status: "unavailable", reason: "model groups reset separately" } },
    { name: "Spend", loading: false, extra: [], wins: [], spend: report() },
  ];
}
const view = (data = sections(), height = 100) => new UsageView(data, () => {}, () => {}, () => {}, () => height);
const spendTab = (panel: UsageView) => panel.handleInput("\t");

test("Limits is the default tab and shows quota/reset data without dollar analytics", () => {
  const text = plain(view().render(96));
  assert.match(text, /\[ Limits \]/); assert.match(text, /Spend/);
  assert.match(text, /Quota used/); assert.match(text, /Reset in/);
  assert.match(text, /24%/); assert.match(text, /61%/); assert.match(text, /7d Opus/);
  assert.doesNotMatch(text, /\$\d/);
  const noWindows = view([{ name: "Empty", loading: false, wins: [], extra: [] }]);
  assert.match(plain(noWindows.render(80)), /No quota windows reported/);
});

test("Tab and Shift-Tab toggle tabs; Spend defaults to month and period keys select all four windows", () => {
  const panel = view(); spendTab(panel);
  let text = plain(panel.render(76));
  assert.match(text, /\[ Spend \]/); assert.match(text, /\[30 days\]/); assert.match(text, /45\.67/);
  assert.doesNotMatch(text, /Subscription weeks/);
  for (const [key, active] of [["1", "7 days"], ["2", "30 days"], ["3", "60 days"], ["4", "All time"]]) {
    panel.handleInput(key);
    text = plain(panel.render(76));
    assert.match(text, new RegExp(`\\[${active}\\]`));
    assert.equal((text.match(/\[(?:7 days|30 days|60 days|All time)\]/g) ?? []).length, 1);
  }
  panel.handleInput("\x1b[Z"); assert.match(plain(panel.render(76)), /\[ Limits \]/);
  panel.handleInput("\t"); panel.handleInput("\x1b[D"); assert.match(plain(panel.render(76)), /\[60 days\]/);
  panel.handleInput("\x1b[C"); assert.match(plain(panel.render(76)), /\[All time\]/);
  panel.handleInput("\x1b[C"); assert.match(plain(panel.render(76)), /\[7 days\]/);
});

test("Spend overview stays compact and contains lifetime tokens, selected summary, categories, and cache analytics", () => {
  const panel = view(); spendTab(panel);
  const lines = panel.render(76), text = plain(lines);
  assert.ok(lines.length <= 25, `overview has ${lines.length} lines`);
  assert.match(text, /987,654 tokens all time/); assert.match(text, /\[30 days\]/);
  assert.match(text, /45\.67/); assert.match(text, /tokens/);
  for (const item of ["Uncached input", "Cache read", "Cache write", "Output", "Cache hit", "Est. saved", "$0.08"]) assert.ok(text.includes(item), item);
  assert.equal((text.match(/Tokens\s+Volume\s+Cost/g) ?? []).length, 1, "one compact category header");
  assert.doesNotMatch(text, /Period\s+|Total processed|Provider|gpt-primary|claude-sonnet|Daily tokens|Daily cost/);
  const headers = text.split("\n").filter(line => /Tokens\s+Volume\s+Cost/.test(line));
  assert.equal(headers.length, 1);
});

test("period selection changes selected cost, wraps left, and d shows detailed models, charts, and subscription weeks", () => {
  const panel = view(); spendTab(panel);
  const month = plain(panel.render(76));
  panel.handleInput("\x1b[D");
  const week = plain(panel.render(76));
  assert.match(week, /\[7 days\]/); assert.doesNotMatch(week, /\[30 days\]/);
  assert.notEqual(week.match(/API-equivalent cost[\s\S]{0,80}/)?.[0], month.match(/API-equivalent cost[\s\S]{0,80}/)?.[0]);
  panel.handleInput("d");
  const full = plain(panel.render(76));
  for (const item of ["Models & history", "gpt-primary", "claude-sonnet", "Daily tokens", "Daily cost", "Subscription weeks", "Anthropic", "Codex", "local time", "Exact token counts"]) assert.ok(full.includes(item), item);
  panel.handleInput("\t");
  const limits = plain(panel.render(76));
  assert.doesNotMatch(limits, /Models & history|gpt-primary|Daily tokens|Subscription weeks/);
  panel.handleInput("\t");
  assert.match(plain(panel.render(76)), /Models & history/);
  panel.handleInput("d");
  assert.doesNotMatch(plain(panel.render(76)), /Models & history/);
});

test("overview prices only the selected period; sub-cent costs stay precise and unrelated all-time pricing does not warn", () => {
  const data = sections();
  const history = data[3]!.spend!;
  history.allTime.metrics!.unpricedMessages = 7;
  history.allTime.total = 0.0000001;
  history.month.total = 0.0012;
  history.month.metrics!.cost.total = 0.0012;
  const panel = view(data); spendTab(panel);
  const text = plain(panel.render(76));
  assert.match(text, /\$0\.001200/);
  assert.doesNotMatch(text, /unpriced|subtotal/i);
});

test("backward-compatible metrics without optional savings omit the estimate", () => {
  const data = sections();
  data[3]!.spend!.month.metrics = metrics(20_000, false);
  const panel = view(data); spendTab(panel);
  const text = plain(panel.render(76));
  assert.match(text, /Est\. saved\s+unavailable/);
  assert.match(text, /Cache hit/);
});

test("selected incomplete history and pricing metadata show concise warnings", () => {
  const data = sections();
  data[3]!.spend!.allTime.complete = false;
  data[3]!.spend!.month.metrics!.unpricedMessages = 2;
  data[3]!.spend!.month.metrics!.missingBreakdownMessages = 1;
  data[3]!.spend!.month.metrics!.cacheSavings!.unratedTokens = 500;
  const panel = view(data); spendTab(panel);
  const text = plain(panel.render(76));
  assert.match(text, /Partial history:/);
  assert.match(text, /2 responses unpriced; cost is a known subtotal/);
  assert.match(text, /Category costs are partial/);
  assert.match(text, /Savings exclude cache tokens/);
});

test("bounded widths, minimum heights and resize work in both tabs and both details states", () => {
  for (const width of [1, 4, 10, 30, 50, 80, 96, 140]) {
    for (const selectedTab of ["limits", "spend"] as const) for (const details of [false, true]) {
      const panel = view(sections(), 7);
      if (selectedTab === "spend") spendTab(panel);
      if (details) panel.handleInput("d");
      const lines = panel.render(width);
      assert.ok(lines.length <= 7, `${selectedTab}/${details} height at width ${width}`);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `${selectedTab}/${details} width ${width}`);
      assert.ok(lines.length >= 1);
    }
  }
  let height = 18, renders = 0;
  const panel = new UsageView(sections(), () => {}, () => {}, () => renders++, () => height);
  for (const selectedTab of ["limits", "spend"] as const) {
    if (selectedTab === "spend") spendTab(panel);
    const start = plain(panel.render(50));
    assert.match(start, /tab tabs.*d (?:dates|models)/, "tab-specific detail action stays visible");
    panel.handleInput("\x1b[F");
    assert.notEqual(plain(panel.render(50)), start);
    panel.handleInput("\x1b[H"); assert.equal(plain(panel.render(50)), start);
    panel.handleInput("d"); assert.ok(panel.render(50).length <= height);
    height = 12; assert.ok(panel.render(50).length <= height);
    panel.handleInput("d"); height = 18;
  }
  assert.ok(renders >= 8);
});

test("close, refresh, scroll and mouse-wheel interactions remain available", () => {
  let closed = 0, refreshed = 0, renders = 0;
  const panel = new UsageView(sections(), () => refreshed++, () => closed++, () => renders++, () => 100);
  panel.handleInput("r"); panel.handleInput("q"); panel.handleInput("\x1b"); panel.handleInput("\r");
  assert.equal(refreshed, 1); assert.equal(closed, 3);
  assert.equal(panel.handleMouse({ type: "wheel", wheelDelta: 2 } as any)?.handled, true);
  panel.handleInput("j"); panel.handleInput("k"); panel.handleInput("\x1b[6~"); panel.handleInput("\x1b[5~");
  assert.ok(renders >= 5);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const readySpend = (total = 10): Spend => spend(total, 7, 2);

test("quota publishes independently before the deferred SpendReport; weekly read uses injected history", async () => {
  const now = Date.now(), history = deferred<SpendReport>(), data: Section[] = [], historyCalls: any[] = [];
  const sources: UsageSource[] = [{ name: "Codex", providerIds: ["openai"], fetch: async () => ({ wins: windows(now, 3) }) }];
  const done = refreshUsageSections(data, sources, {
    isCurrent: () => true, onChange() {}, now: () => now,
    readReport: async options => { assert.equal(options.dir, "/mock/sessions"); return history.promise; },
    readHistory: async options => { historyCalls.push(options); return readySpend(7); },
    dir: "/mock/sessions",
  });
  await new Promise(setImmediate);
  assert.equal(data[0]!.loading, false); assert.equal(data[0]!.wins[1]!.used, 61);
  assert.equal(data[0]!.weekly?.status, "loading"); assert.equal(data[1]!.loading, true);
  history.resolve(report()); await done;
  assert.equal(data[1]!.spend!.month.total, 45.67);
  assert.equal(data[0]!.weekly?.status, "ready");
  assert.equal((data[0]!.weekly as any).total, 5.25);
  assert.deepEqual(historyCalls.map(c => [c.from, c.to]), [[now - 4 * DAY, now + 3 * DAY]]);
});

test("closed/stale refresh cannot publish late quota, report, or weekly results", async () => {
  let current = true, changes = 0;
  const quota = deferred<Partial<Section>>(), history = deferred<SpendReport>(), data: Section[] = [];
  const done = refreshUsageSections(data, [{ name: "Codex", providerIds: ["openai"], fetch: () => quota.promise }], {
    isCurrent: () => current, onChange: () => changes++, readReport: () => history.promise, readHistory: async () => readySpend(),
  });
  await new Promise(setImmediate); current = false;
  const before = changes, snapshot = structuredClone(data);
  quota.resolve({ wins: windows(Date.now()) }); history.resolve(report()); await done;
  assert.deepEqual(data, snapshot); assert.equal(changes, before);
});

test("quota failure does not block Spend report and report failure does not block quota publication", async () => {
  const data: Section[] = [];
  await refreshUsageSections(data, [
    { name: "Anthropic", providerIds: ["anthropic"], fetch: async () => { throw Error("not signed in"); } },
    { name: "Codex", providerIds: ["openai"], fetch: async () => ({ wins: windows(Date.now()) }) },
  ], { isCurrent: () => true, onChange() {}, readReport: async () => report(), readHistory: async () => readySpend() });
  assert.equal(data[0]!.error, "not signed in"); assert.ok(data[1]!.wins.length);
  assert.ok(data[2]!.spend); assert.equal(data[2]!.loading, false);

  const reportFailure: Section[] = [];
  await refreshUsageSections(reportFailure, [{ name: "Codex", providerIds: ["openai"], fetch: async () => ({ wins: windows(Date.now()) }) }], {
    isCurrent: () => true, onChange() {}, readReport: async () => { throw Error("history denied"); }, readHistory: async () => readySpend(),
  });
  assert.equal(reportFailure[1]!.error, "history denied");
  assert.equal(reportFailure[0]!.loading, false); assert.equal(reportFailure[0]!.wins[0]!.used, 24);
  assert.equal(reportFailure[0]!.weekly?.status, "ready");
});

test("incomplete weekly history becomes a warning, never a zero-dollar result", async () => {
  const now = Date.now(), data: Section[] = [];
  await refreshUsageSections(data, [{ name: "Codex", providerIds: ["openai"], fetch: async () => ({ wins: windows(now) }) }], {
    isCurrent: () => true, onChange() {}, readReport: async () => report(),
    readHistory: async () => ({ ...readySpend(), complete: false }), now: () => now,
  });
  assert.deepEqual(data[0]!.weekly, { status: "unavailable", reason: "session history could not be fully read" });
});
