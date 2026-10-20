import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fit, pair, usageColumns, windowLabel } from "../layout.ts";
import { UsageView, type Section } from "../index.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const DAY = 86400000;
function fixture(): Section[] {
  const now = Date.now();
  return [
    { name: "Anthropic", wins: [{ label: "5h", used: 9, resetsAt: now + 2 * 3600000 }, { label: "7d", used: 90, resetsAt: now + 3 * DAY }], extra: [], loading: false, weekly: { status: "ready", total: 1234.56, from: now - 4 * DAY, to: now + 3 * DAY, asOf: now } },
    { name: "Codex", plan: "plus", wins: [{ label: "5h", used: 100, resetsAt: now + 3600000 }, { label: "7d", used: 40, resetsAt: now + DAY }], extra: [], loading: false, weekly: { status: "ready", total: 8.1, from: now - 6 * DAY, to: now + DAY, asOf: now } },
    { name: "API cost", wins: [], extra: [], loading: false, cost: { total: 12345.67, plansTotal: 40, providers: [
      { name: "OpenAI", total: 10000, share: 81, daily: Array(30).fill(330), models: [], color: [51,177,255] },
      { name: "Anthropic", total: 2345.67, share: 19, daily: Array(30).fill(78), models: [], color: [255,131,43] },
    ] } },
  ];
}
const render = (width: number, data = fixture()) => new UsageView(data, () => {}, () => {}, () => {}, () => 100).render(width).map(plain);

test("fixed-width helpers account for ANSI and double-width characters and reserve amounts before long labels", () => {
  assert.equal(visibleWidth(fit("\x1b[31m红色\x1b[0m", 9)), 9);
  assert.equal(visibleWidth(pair("a very long provider label", "$123,456.78", 25)), 25);
  assert.ok(pair("a very long provider label", "$123,456.78", 25).endsWith("$123,456.78"));
  for (const width of [0,1,4,10,20]) {
    assert.equal(visibleWidth(fit("漢字text", width)), width);
    assert.equal(visibleWidth(pair("漢字provider", "$12.00", width)), width);
  }
});

test("wide layout gives quota and monetary value separate lanes; narrow layout protects full-width quota bars", () => {
  const wide = usageColumns(94, ["5h", "7d"]), narrow = usageColumns(58, ["5h", "7d"]);
  assert.equal(wide.split, true); assert.equal(wide.quotaWidth + 3 + wide.valueWidth, wide.width);
  assert.equal(narrow.split, false); assert.equal(narrow.quotaWidth, narrow.width);
  assert.ok(wide.barWidth >= 12); assert.ok(narrow.barWidth >= 12);
  assert.equal(windowLabel("Claude/Gemini extended group 7d", 18).slice(-3), " 7d");
});

test("all weekly amounts and the 30-day total share a right edge; quota percentages use one fixed column", () => {
  const lines = render(96);
  const heads = [lines.find(s => /Anthropic.*\$1,234\.56/.test(s))!, lines.find(s => /Codex.*\$8\.10/.test(s))!, lines.find(s => /30-day API value.*\$12,345\.67/.test(s))!];
  assert.ok(heads.every(Boolean));
  // Measure the actual end of each amount, not its starting position (currency widths differ).
  assert.equal(new Set(heads.map(s => s.match(/\$[\d,.]+/)!.index! + s.match(/\$[\d,.]+/)![0].length)).size, 1);
  const quota = lines.filter(s => /^│\s+(?:5h|7d)\s/.test(s));
  assert.equal(quota.length, 4); assert.equal(new Set(quota.map(s => s.indexOf("%"))).size, 1);
  assert.equal(new Set(quota.map(s => s.indexOf("█"))).size, 1);
  assert.match(lines.find(s => s.includes("Quota used"))!, /Reset in.*Weekly API value/);
  assert.equal(lines.filter(s => s.includes("since ")).length, 2);
  assert.ok(!lines.some(s => s.includes("Weekly cost")), "no repetitive per-provider cost label");
});

test("narrow layout retains amounts, period dates and explicit reset context without squeezing two panels", () => {
  const lines = render(50);
  assert.ok(lines.some(s => /Anthropic.*\$1,234\.56/.test(s)));
  assert.ok(lines.some(s => /Codex.*\$8\.10/.test(s)));
  assert.ok(lines.some(s => /30-day API value.*\$12,345\.67/.test(s)));
  assert.equal(lines.filter(s => s.includes("since ")).length, 2);
  const quota = lines.filter(s => /^│\s+(?:5h|7d)\s/.test(s));
  assert.ok(quota.every(s => /in \d/.test(s))); assert.ok(quota.every(s => s.includes("%")));
  assert.ok(lines.every(s => visibleWidth(s) === 50));
});

test("30-day share bar spans the content grid, with a single compact legend when it fits", () => {
  const lines = render(96), header = lines.findIndex(s => s.includes("30-day API value"));
  const bar = lines[header+1]!;
  assert.equal((bar.match(/█/g) ?? []).length, usageColumns(94, []).width);
  assert.match(lines[header+2]!, /OpenAI.*\$10,000\.00.*Anthropic.*\$2,345\.67/);
  assert.ok(!lines.some(s => s.includes("at API prices")), "scope belongs to the shared footer, not a repeated headline");
});

test("long and wide-character quota labels preserve their window suffix without shifting prices or bars", () => {
  const data = fixture(); data[0]!.wins[0]!.label = "Claude/Gemini extended group 7d"; data[1]!.wins[0]!.label = "测试模型 family 7d";
  const lines = render(96,data);
  assert.ok(lines.every(s => visibleWidth(s) === 96));
  assert.ok(lines.filter(s => s.includes("█") && s.includes("%")).every(s => /7d|5h/.test(s)));
  assert.ok(lines.some(s => /Anthropic.*\$1,234\.56/.test(s)));
});

test("oversized provider names wrap the monthly key without losing their monetary amounts", () => {
  const data = fixture(); data[2]!.cost!.providers[0]!.name = "A very long custom provider name that cannot fit beside its monetary total";
  const lines = render(50, data);
  assert.ok(lines.some(s => s.includes("■") && s.includes("$10,000.00")));
  assert.ok(lines.every(s => visibleWidth(s) === 50));
});

test("empty recorded cost remains a zero value and empty share track, not a missing or broken panel", () => {
  const data = fixture(); data[2]!.cost = { total: 0, plansTotal: 0, providers: [] };
  const panel = new UsageView(data, () => {}, () => {}, () => {}, () => 100);
  panel.handleInput("d");
  const lines = panel.render(96).map(plain);
  assert.ok(lines.some(s => /30-day API value.*\$0\.00/.test(s)));
  assert.ok(!lines.some(s => s.includes("peak")));
  assert.ok(lines.every(s => visibleWidth(s) === 96));
});
