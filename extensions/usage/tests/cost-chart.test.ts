import assert from "node:assert/strict";
import { test } from "node:test";
import { columnChart, costRows, stackedBar, type RGB } from "../cost-chart.ts";

const BLUE: RGB = [51, 177, 255];
const ORANGE: RGB = [255, 131, 43];
const TRACK: RGB = [51, 53, 59];
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const code = ([r, g, b]: RGB) => `${r};${g};${b}m`;
const count = (s: string, c: RGB, ch = "█") => {
  // number of `ch` glyphs painted with foreground colour c
  const re = new RegExp(`\\x1b\\[38;2;${code(c).replace(/;/g, ";")}([^\\x1b]*)`, "g");
  let n = 0;
  for (const m of s.matchAll(re)) n += [...m[1]!].filter(x => x === ch).length;
  return n;
};

test("stackedBar fills exactly the width, in proportion", () => {
  const bar = stackedBar([{ value: 36, color: BLUE }, { value: 12, color: ORANGE }], 60, TRACK);
  assert.equal(plain(bar).length, 60);
  assert.equal(count(bar, BLUE), 45);
  assert.equal(count(bar, ORANGE), 15);
});

test("stackedBar widths always add up, and a nonzero part never vanishes", () => {
  for (const width of [7, 33, 61, 80]) {
    const bar = stackedBar([{ value: 1, color: BLUE }, { value: 1, color: ORANGE }, { value: 1, color: TRACK }], width, TRACK);
    assert.equal(plain(bar).length, width);
  }
  const tiny = stackedBar([{ value: 1000, color: BLUE }, { value: 0.01, color: ORANGE }], 40, TRACK);
  assert.equal(count(tiny, ORANGE), 1);
  assert.equal(count(tiny, BLUE), 39);
});

test("stackedBar with nothing to show is an empty track", () => {
  const bar = stackedBar([{ value: 0, color: BLUE }], 20, TRACK);
  assert.equal(plain(bar).length, 20);
  assert.equal(count(bar, BLUE), 0);
  assert.equal(count(bar, TRACK), 20);
});

const series = (a: number[], b: number[] = a.map(() => 0)) => [{ color: BLUE, daily: a }, { color: ORANGE, daily: b }];

test("columnChart: the peak day reaches the top, a half day fills half the rows", () => {
  const { rows, peak } = columnChart(series([0, 4, 2]), { height: 4, colWidth: 1, width: 10, track: TRACK });
  assert.equal(peak, 4);
  assert.equal(rows.length, 4);
  const cells = rows.map(r => [...plain(r)]);
  assert.deepEqual(cells.map(r => r[1]), ["█", "█", "█", "█"]);
  assert.deepEqual(cells.map(r => r[2]), [" ", " ", "█", "█"]);
});

test("columnChart: an empty day is a faint baseline, not a bar", () => {
  const { rows } = columnChart(series([0, 4]), { height: 3, colWidth: 1, width: 10, track: TRACK });
  assert.equal([...plain(rows[2]!)][0], "▁");
  assert.equal(rows[2]!.includes(`38;2;${code(TRACK)}`), true);
  assert.equal([...plain(rows[0]!)][0], " ");
});

test("columnChart: providers stack bottom to top, each in its own colour", () => {
  const { rows } = columnChart(series([2], [2]), { height: 4, colWidth: 1, width: 5, track: TRACK });
  const colours = rows.map(r => (r.includes(`38;2;${code(BLUE)}`) ? "blue" : r.includes(`38;2;${code(ORANGE)}`) ? "orange" : "none"));
  assert.deepEqual(colours, ["orange", "orange", "blue", "blue"]);
});

test("columnChart: a boundary inside one cell uses both colours at once", () => {
  // height 1 row = 8 eighths: blue 3, orange 5
  const { rows } = columnChart(series([3], [5]), { height: 1, colWidth: 1, width: 5, track: TRACK });
  assert.equal(plain(rows[0]!), "▃");
  assert.ok(rows[0]!.includes(`38;2;${code(BLUE)}`), "lower part blue");
  assert.ok(rows[0]!.includes(`48;2;${code(ORANGE)}`), "upper part orange background");
});

test("columnChart: a tiny but real spend still shows a mark", () => {
  const { rows } = columnChart(series([1000, 0.001]), { height: 4, colWidth: 1, width: 5, track: TRACK });
  assert.notEqual([...plain(rows[3]!)][1], " ");
});

test("columnChart: two-character columns leave a gap, and old days are dropped to fit", () => {
  const wide = columnChart(series([1, 2, 3, 4, 5]), { height: 2, colWidth: 2, width: 6, track: TRACK });
  assert.equal(plain(wide.rows[0]!).length, 6);
  assert.equal(wide.shown, 3);
  assert.equal(wide.peak, 5, "scaled to the days that are shown");
  assert.equal([...plain(wide.rows[1]!)][1], " ");
});

test("costRows: configured plans appear even with no spend, and give a value multiple", () => {
  const rows = costRows([{ provider: "openai", total: 36 }], { openai: 20, anthropic: 20 });
  assert.deepEqual(rows.map(r => r.provider), ["openai", "anthropic"]);
  assert.equal(rows[0]!.multiple, 1.8);
  assert.equal(rows[0]!.plan, 20);
  assert.equal(rows[1]!.total, 0);
  assert.equal(rows[1]!.multiple, 0);
});

test("costRows: biggest spender first; providers without a plan get no multiple", () => {
  const rows = costRows([{ provider: "openrouter", total: 5 }, { provider: "openai", total: 10 }], { openai: 20 });
  assert.deepEqual(rows.map(r => r.provider), ["openai", "openrouter"]);
  assert.equal(rows[1]!.multiple, undefined);
});
