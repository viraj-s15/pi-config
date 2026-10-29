import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fit, pair, usageColumns, windowLabel } from "../layout.ts";
import { UsageView, type Section } from "../index.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const DAY = 86_400_000;
function fixture(): Section[] {
  const now = Date.now();
  return [
    { name: "Anthropic", wins: [{ label: "5h", used: 9, resetsAt: now + 2 * 3_600_000 }, { label: "7d", used: 90, resetsAt: now + 3 * DAY }], extra: [], loading: false },
    { name: "Codex", plan: "plus", wins: [{ label: "5h", used: 100, resetsAt: now + 3_600_000 }, { label: "7d", used: 40, resetsAt: now + DAY }], extra: [], loading: false },
  ];
}
const render = (width: number, data = fixture()) => new UsageView(data, () => {}, () => {}, () => {}, () => 100).render(width).map(plain);

test("fixed-width helpers account for ANSI and wide characters, reserving the right lane", () => {
  assert.equal(visibleWidth(fit("\x1b[31m红色\x1b[0m", 9)), 9);
  assert.equal(visibleWidth(pair("a very long provider label", "$123,456.78", 25)), 25);
  assert.ok(pair("a very long provider label", "$123,456.78", 25).endsWith("$123,456.78"));
  for (const width of [0, 1, 4, 10, 20]) {
    assert.equal(visibleWidth(fit("漢字text", width)), width);
    assert.equal(visibleWidth(pair("漢字provider", "$12.00", width)), width);
  }
});

test("quota columns use the full available width with no monetary split", () => {
  for (const inner of [0, 2, 20, 58, 94, 138]) {
    const cols = usageColumns(inner, ["5h", "7d"]);
    assert.equal(cols.split, false);
    assert.equal(cols.valueWidth, 0);
    assert.equal(cols.quotaWidth, cols.width);
    assert.equal(cols.width, Math.max(0, inner - 4));
  }
  const wide = usageColumns(94, ["5h", "7d"]);
  assert.ok(wide.barWidth >= 12);
  assert.equal(windowLabel("Claude/Gemini extended group 7d", 18).slice(-3), " 7d");
});

test("quota labels, percentages, bars, and reset amounts share fixed aligned columns at full width", () => {
  for (const width of [50, 96, 140]) {
    const lines = render(width);
    assert.ok(lines.every(line => visibleWidth(line) === width));
    const quota = lines.filter(line => /^│\s+(?:5h|7d)\s/.test(line));
    assert.equal(quota.length, 4);
    assert.equal(new Set(quota.map(line => line.indexOf("%"))).size, 1, `percentage alignment at ${width}`);
    assert.equal(new Set(quota.map(line => line.indexOf("█"))).size, 1, `bar alignment at ${width}`);
    assert.equal(new Set(quota.map(line => line.lastIndexOf("│"))).size, 1);
  }
  const lines = render(96);
  assert.match(lines.find(line => line.includes("Quota used"))!, /Reset in/);
  assert.ok(!lines.some(line => /\$\d/.test(line)), "Limits has no dollar amounts");
});

test("long and wide-character quota labels preserve suffixes without shifting quota columns", () => {
  const data = fixture();
  data[0]!.wins[0]!.label = "Claude/Gemini extended group 7d";
  data[1]!.wins[0]!.label = "测试模型 family 7d";
  const lines = render(96, data);
  assert.ok(lines.every(line => visibleWidth(line) === 96));
  const quota = lines.filter(line => line.includes("█") && line.includes("%"));
  assert.equal(quota.length, 4);
  assert.ok(quota.every(line => /7d|5h/.test(line)));
  assert.ok(quota.every(line => /%/.test(line)));
  assert.ok(quota.every(line => /█/.test(line)));
});
