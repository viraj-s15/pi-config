import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { UsageView, refreshUsageSections, type Section, type UsageSource } from "../index.ts";
import type { Spend } from "../spend.ts";
import { WEEK_SECONDS } from "../weekly-spend.ts";

const DAY = 86_400_000;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const windows = (now: number, ahead = 3) => [
  { label: "5h", used: 24, durationSeconds: 18000, resetsAt: now + 3600000 },
  { label: "7d", used: 61, durationSeconds: WEEK_SECONDS, resetsAt: now + ahead * DAY },
];
function sections(): Section[] {
  const now = Date.now();
  return [
    { name: "Anthropic", loading: false, extra: [], wins: [...windows(now), { label: "7d Opus", used: 43, durationSeconds: WEEK_SECONDS, resetsAt: now + 3 * DAY }], weekly: { status: "ready", total: 23.45, from: now - 4 * DAY, to: now + 3 * DAY, asOf: now } },
    { name: "Codex", plan: "plus", loading: false, extra: [], wins: windows(now, 6), weekly: { status: "ready", total: 8.1, from: now - DAY, to: now + 6 * DAY, asOf: now } },
    { name: "Antigravity", loading: false, extra: [], wins: [], weekly: { status: "unavailable", reason: "model groups reset separately" } },
    { name: "API cost", plan: "last 30 days", loading: false, extra: [], wins: [], cost: {
      total: 123.45, plansTotal: 20, providers: [{ name: "OpenAI", color: [51,177,255], total: 123.45, share: 100, daily: Array(30).fill(4.115), plan: 20, multiple: 6.2, models: [{ model: "gpt-primary", total: 100 }, { model: "gpt-secondary", total: 23.45 }] }],
    } },
  ];
}
const view = (data = sections(), height = 100) => new UsageView(data, () => {}, () => {}, () => {}, () => height);

test("compact view keeps quota and stacked cost bars and reset-aligned dollars, without secondary charts or model detail", () => {
  const text = plain(view().render(96));
  assert.match(text, /Weekly API value/);
  assert.match(text, /Anthropic[^\n]*\$23\.45/);
  assert.match(text, /Codex[^\n]*\$8\.10/);
  assert.match(text, /since/);
  assert.match(text, /API-equivalent.*saved Pi sessions only/);
  assert.match(text, /24%/); assert.match(text, /61%/); assert.match(text, /█/);
  assert.match(text, /\$123\.45/); assert.match(text, /Antigravity[^\n]*unavailable/);
  assert.match(text, /7d Opus/);
  for (const secondary of ["gpt-primary", "peak", "6.2×", "model groups reset separately"]) assert.ok(!text.includes(secondary), secondary);
});

test("details keeps quota bars and restores model costs, value multiples, trend and unavailable explanations", () => {
  const panel = view(); const compact = panel.render(96).length;
  panel.handleInput("d"); const full = panel.render(96), text = plain(full);
  for (const detail of ["7d Opus", "gpt-primary", "peak", "6.2×", "model groups reset separately", "local time", "Excludes subagent"]) assert.ok(text.includes(detail), detail);
  assert.ok(full.length > compact);
  panel.handleInput("d"); assert.equal(panel.render(96).length, compact);
});

test("width and height stay bounded including narrow terminals, resize and details; footer stays visible while scrolling", () => {
  for (const width of [1, 4, 10, 30, 50, 80, 96, 140]) {
    const panel = view(sections(), 20);
    for (const detail of [false, true]) {
      if (detail) panel.handleInput("d");
      const lines = panel.render(width);
      assert.ok(lines.length <= 20, `height ${width}`);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
    }
  }
  let height = 18, renders = 0;
  const panel = new UsageView(sections(), () => {}, () => {}, () => renders++, () => height);
  const first = plain(panel.render(50)); assert.match(first, /esc close/); assert.match(first, /↑↓ scroll/);
  panel.handleInput("\x1b[F"); const last = plain(panel.render(50));
  assert.notEqual(first, last); assert.match(last, /30-day API value/); assert.match(last, /esc close/);
  panel.handleInput("\x1b[H"); assert.equal(plain(panel.render(50)), first);
  panel.handleInput("j"); assert.notEqual(plain(panel.render(50)), first);
  panel.handleInput("k"); assert.equal(plain(panel.render(50)), first);
  height = 12; assert.ok(panel.render(50).length <= 12);
  assert.ok(renders >= 4);
});

test("zero, loading, unavailable and reset-passed costs are distinct; keyboard close/refresh and mouse scroll work", () => {
  const data = sections();
  data[0]!.weekly = { status: "ready", total: 0, from: Date.now() - DAY, to: Date.now() + DAY, asOf: Date.now() };
  data[1]!.weekly = { status: "loading" };
  let closed = 0, refreshed = 0, renders = 0;
  const panel = new UsageView(data, () => refreshed++, () => closed++, () => renders++, () => 100);
  assert.match(plain(panel.render(96)), /Anthropic[^\n]*\$0\.00/);
  assert.match(plain(panel.render(96)), /calculating…/);
  data[0]!.weekly = { status: "ready", total: 99, from: Date.now() - 8 * DAY, to: Date.now() - DAY, asOf: Date.now() - DAY };
  const expired = plain(panel.render(96)); assert.ok(!expired.includes("$99.00")); assert.match(expired, /Anthropic[^\n]*unavailable/);
  panel.handleInput("r"); panel.handleInput("q"); panel.handleInput("\x1b"); panel.handleInput("\r");
  assert.equal(refreshed, 1); assert.equal(closed, 3);
  assert.equal(panel.handleMouse({ type: "wheel", wheelDelta: 2 } as any)?.handled, true);
  assert.ok(renders >= 2);
});

function spend(total = 10): Spend {
  return { total, messages: 2, days: 30, complete: true, daily: Array(30).fill(0), byProvider: [{ provider: "openai", total, daily: Array(30).fill(0), models: [] }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("loader publishes quota bars before history completes, then calculates exact distinct provider windows", async () => {
  const now = Date.now(), history = deferred<Spend>(), data: Section[] = [], calls: any[] = [];
  const sources: UsageSource[] = [
    { name: "Codex", providerIds: ["openai"], fetch: async () => ({ wins: windows(now, 3) }) },
    { name: "Anthropic", providerIds: ["anthropic"], fetch: async () => ({ wins: windows(now, 6) }) },
  ];
  const done = refreshUsageSections(data, sources, {
    isCurrent: () => true, onChange() {}, now: () => now,
    readHistory: async options => {
      calls.push(options);
      if (options.from === undefined) return history.promise;
      return options.from === now - 4 * DAY ? spend(7) : { ...spend(9), byProvider: [{ provider: "anthropic", total: 9, daily: [], models: [] }] };
    },
  });
  await new Promise(setImmediate);
  assert.equal(data[0]!.loading, false); assert.equal(data[0]!.weekly?.status, "loading");
  assert.equal(data[2]!.loading, true); assert.equal(calls.length, 1);
  history.resolve(spend()); await done;
  assert.equal(data[0]!.weekly?.status, "ready"); assert.equal(data[1]!.weekly?.status, "ready");
  assert.equal((data[0]!.weekly as any).total, 7); assert.equal((data[1]!.weekly as any).total, 9);
  assert.deepEqual(calls.slice(1).map(c => c.from).sort(), [now - 4 * DAY, now - DAY].sort());
  assert.ok(calls.every(c => c.now() === now));
});

test("old refreshes and closed overlays cannot overwrite newer results or start weekly scans", async () => {
  let current = true, changes = 0, reads = 0;
  const quota = deferred<Partial<Section>>(), data: Section[] = [];
  const done = refreshUsageSections(data, [{ name: "Codex", providerIds: ["openai"], fetch: () => quota.promise }], {
    isCurrent: () => current, onChange: () => changes++, readHistory: async () => { reads++; return spend(); },
  });
  await new Promise(setImmediate); current = false;
  const before = changes, snapshot = structuredClone(data);
  quota.resolve({ wins: windows(Date.now()) }); await done;
  assert.deepEqual(data, snapshot); assert.equal(changes, before); assert.equal(reads, 1);
});

test("one provider's failure does not hide other quotas or cost; missing weekly metadata is not a fake zero", async () => {
  const data: Section[] = [];
  await refreshUsageSections(data, [
    { name: "Anthropic", providerIds: ["anthropic"], fetch: async () => { throw Error("not signed in"); } },
    { name: "Codex", providerIds: ["openai"], fetch: async () => ({ wins: [{ label: "5h", used: 10 }] }) },
  ], { isCurrent: () => true, onChange() {}, readHistory: async () => spend() });
  assert.equal(data[0]!.error, "not signed in"); assert.equal(data[1]!.weekly?.status, "unavailable");
  assert.ok(data[2]!.cost); assert.equal(data[2]!.loading, false);
});
