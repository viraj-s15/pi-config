import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import userBar from "../index.ts";

initTheme("dark", false);
const commands = new Map<string, any>();
const handlers = new Map<string, any>();
const api = { on: (name: string, cb: any) => handlers.set(name, cb), registerCommand: (name: string, c: any) => commands.set(name, c) } as any;
const ctx = { hasUI: true, ui: { notify() {}, theme: { bg: (_n: string, s: string) => s, fg: (_n: string, s: string) => s } } } as any;
userBar(api);
handlers.get("session_start")({}, ctx);
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const body = "A long user message with a lot of detail. ".repeat(30) + "END_OF_MESSAGE";
const rows = (m: UserMessageComponent, width = 70) => m.render(width).map(plain);
const content = (m: UserMessageComponent, width = 70) => rows(m, width).filter(s => s.trim());
const control = (m: UserMessageComponent, width = 70) => rows(m, width).findIndex(s => /Show more|Show less/.test(s));
const click = (m: UserMessageComponent, y: number, extra: object = {}) => m.handleMouse({
  type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
  width: 70, height: rows(m).length, shift: false, alt: false, ctrl: false, ...extra,
});

// Each test starts with both settings on, even after tests that exercise the commands.
async function reset() {
  await commands.get("userbar").handler("on", ctx);
  if (commands.has("userfold")) await commands.get("userfold").handler("on", ctx);
}

test("a sent long message is two preview rows and one show-more row", async () => {
  await reset();
  const m = new UserMessageComponent(body);
  assert.equal(content(m).length, 3);
  assert.match(content(m)[2]!, /▸ Show more.*characters/);
  assert.ok(content(m).every(s => s.startsWith("▎ ")), "blue bar on every content row");
  assert.ok(!rows(m).join("\n").includes("END_OF_MESSAGE"));
  assert.equal((m as any).text, body, "the full original text stays untouched");
});

test("short messages and exactly 500 characters are unchanged", async () => {
  await reset();
  for (const text of ["hello", "x ".repeat(250)]) {
    const m = new UserMessageComponent(text);
    assert.equal(control(m), -1);
    assert.equal((m as any).text, text);
  }
  assert.notEqual(control(new UserMessageComponent("x ".repeat(251))), -1);
});

test("click show-more expands, then show-less collapses again", async () => {
  await reset();
  const m = new UserMessageComponent(body);
  const result = click(m, control(m));
  assert.equal(result?.handled, true);
  assert.equal(result?.render, true);
  assert.ok(!result?.focus, "do not steal keyboard focus from the editor");
  assert.ok(rows(m).join("\n").includes("END_OF_MESSAGE"));
  assert.match(content(m).at(-1)!, /▾ Show less/);
  assert.ok(content(m).length > 3);
  click(m, control(m));
  assert.equal(content(m).length, 3);
  assert.equal((m as any).text, body);
});

test("preview text, padding, right-clicks and drags do not toggle", async () => {
  await reset();
  const m = new UserMessageComponent(body);
  const y = control(m);
  assert.ok(y >= 0);
  click(m, y - 1);
  click(m, 0);
  click(m, y, { button: "right" });
  click(m, y, { type: "press" });
  click(m, y, { type: "drag" });
  click(m, y, { type: "release" });
  click(m, y, { x: 69 }); // right padding, not the link
  click(m, y, { ctrl: true });
  assert.equal(content(m).length, 3);
});

test("each message has its own expansion state", async () => {
  await reset();
  const a = new UserMessageComponent(body), b = new UserMessageComponent(body);
  click(a, control(a));
  assert.ok(content(a).length > 3);
  assert.equal(content(b).length, 3);
});

test("fullscreen Container routes the control row to the message", async () => {
  await reset();
  const m = new UserMessageComponent(body);
  const c = new Container();
  c.addChild(new Spacer(4));
  c.addChild(m);
  const y = control(m) + 4;
  const result = c.handleMouse({ type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
    width: 70, height: c.render(70).length, shift: false, alt: false, ctrl: false });
  assert.equal(result?.handled, true);
  assert.equal(result?.target.component, m);
  assert.ok(rows(m).join("\n").includes("END_OF_MESSAGE"));
});

test("raw fullscreen press/release sequences expand and collapse without an artificial click event", async () => {
  await reset();
  const terminal = { columns: 70, rows: 40, write() {}, hideCursor() {}, showCursor() {}, stop() {} } as any;
  const tui = new TuiAltScreen(terminal);
  const m = new UserMessageComponent(body);
  tui.addChild(m);
  (tui as any).beforeTerminalStart();
  try {
    tui.renderNow();
    const clickControl = (label: string) => {
      const y = tui.getScreenLines().findIndex(s => plain(s).includes(label));
      assert.ok(y >= 0, `${label} is visible`);
      for (const suffix of ["M", "m"]) (tui as any).handleViewportInput(`\x1b[<0;5;${y + 1}${suffix}`);
      tui.renderNow();
    };
    clickControl("Show more");
    assert.ok(tui.getScreenLines().some(s => plain(s).includes("END_OF_MESSAGE")));
    clickControl("Show less");
    assert.ok(tui.getScreenLines().some(s => plain(s).includes("Show more")));
    assert.ok(!tui.getScreenLines().some(s => plain(s).includes("END_OF_MESSAGE")));
  } finally {
    tui.stop({ preserveScreen: true });
  }
});

test("long messages that fit within two rendered rows need no folding", async () => {
  await reset();
  const m = new UserMessageComponent("word ".repeat(110));
  assert.equal(control(m, 1000), -1);
  assert.notEqual(control(m, 70), -1, "fold once resized narrower");
});

test("narrow widths and Unicode never exceed available columns", async () => {
  await reset();
  const m = new UserMessageComponent("界🙂é words ".repeat(120));
  // Pi's Markdown itself cannot fit a wide glyph in a one-column terminal; test usable widths.
  for (const width of [10, 12, 20, 40, 70]) {
    const lines = m.render(width);
    assert.ok(lines.every(s => visibleWidth(s) <= width), `fits ${width} columns`);
    if (width >= 10) assert.equal(lines.map(plain).filter(s => s.trim()).length, 3);
  }
});

test("expanded Markdown matches the unfurled renderer and keeps the original children", async () => {
  await reset();
  const markdown = "# Heading\n\n**Bold**, `code`, and [a link](https://example.com).\n\n" +
    "```python\n" + "print('hello')\n".repeat(45) + "```\n\nFinal paragraph.";
  const m = new UserMessageComponent(markdown);
  const children = [...m.children];
  await commands.get("userfold").handler("off", ctx);
  const full = content(m);
  await commands.get("userfold").handler("on", ctx);
  assert.equal(content(m).length, 3);
  click(m, control(m));
  assert.deepEqual(content(m).filter(s => !s.includes("Show less")), full);
  assert.deepEqual(m.children, children);
  assert.equal((m as any).text, markdown);
});

test("expansion survives resize and padding changes without stale hit targets", async () => {
  await reset();
  const m = new UserMessageComponent(body);
  click(m, control(m));
  assert.equal(control(m, 2000), -1, "the whole message fits at a very wide width");
  m.setOutputPad(3);
  assert.match(content(m).at(-1)!, /Show less/, "still expanded when narrowed again");
  click(m, control(m), { x: 6 });
  assert.equal(content(m).length, 3);
});

test("OSC 133 prompt boundaries survive folding and expansion", async () => {
  await reset();
  const m = new UserMessageComponent(body);
  for (let i = 0; i < 2; i++) {
    const out = m.render(70).join("\n");
    for (const letter of ["A", "B", "C"]) assert.equal(out.split(`\x1b]133;${letter}\x07`).length - 1, 1);
    click(m, control(m));
  }
});

test("folding works with the blue bar disabled too", async () => {
  await reset();
  await commands.get("userbar").handler("off", ctx);
  const m = new UserMessageComponent(body);
  assert.equal(content(m).length, 3);
  assert.ok(content(m).every(s => !s.includes("▎")));
  click(m, control(m));
  assert.ok(rows(m).join("\n").includes("END_OF_MESSAGE"));
});

test("userfold off is a keyboard path to full messages", async () => {
  await reset();
  const m = new UserMessageComponent(body);
  assert.equal(content(m).length, 3);
  assert.ok(commands.has("userfold"));
  await commands.get("userfold").handler("off", ctx);
  assert.ok(rows(m).join("\n").includes("END_OF_MESSAGE"));
  assert.equal(control(m), -1);
  await commands.get("userfold").handler("on", ctx);
  assert.equal(content(m).length, 3);
});

test("reload does not stack wrappers or lose an existing component's expansion", async () => {
  await reset();
  const m = new UserMessageComponent(body);
  click(m, control(m));
  userBar(api);
  userBar(api);
  assert.match(content(m).at(-1)!, /Show less/);
  assert.ok(content(m).every(s => s.indexOf("▎") === s.lastIndexOf("▎")));
  click(m, control(m));
  assert.equal(content(m).length, 3);
});
