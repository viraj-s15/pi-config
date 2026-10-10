import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@earendil-works/pi-tui";
import pasteFold from "../index.ts";

pasteFold({} as any);

const theme = { borderColor: (s: string) => s, selectList: {} } as any;
const WIDTH = 60;

function editor() {
  const e = new Editor({ requestRender() {}, terminal: { rows: 40, columns: 80 } } as any, theme) as any;
  e.render(WIDTH);
  return e;
}
const paste = (e: any, text: string) => e.handleInput(`\x1b[200~${text}\x1b[201~`);
const click = (e: any, x: number, y: number, extra: object = {}) =>
  e.handleMouse({ type: "click", button: "left", x, y, width: WIDTH, height: 8, screenX: x, screenY: y, ...extra });
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i % 10}`.padEnd(3, "x")).join(" "); // 4 chars per word incl. space
const text = (chars: number) => { const t = words(Math.ceil(chars / 4) + 1).slice(0, chars); assert.equal(t.length, chars); return t; };

test("a paste of more than 500 characters collapses into a marker", () => {
  const e = editor();
  const body = text(600);
  paste(e, body);
  assert.equal(e.getText(), "[paste #1 600 chars]");
  assert.equal(e.getExpandedText(), body, "the full text is still what gets sent");
});

test("500 characters stay inline, 501 collapse", () => {
  const a = editor(); paste(a, text(500));
  assert.equal(a.getText(), text(500));
  const b = editor(); paste(b, text(501));
  assert.equal(b.getText(), "[paste #1 501 chars]");
});

test("short pastes are untouched, and Pi's own line and size rules still apply", () => {
  const short = editor(); paste(short, "hello world");
  assert.equal(short.getText(), "hello world");
  const lines = editor(); paste(lines, Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"));
  assert.equal(lines.getText(), "[paste #1 +12 lines]");
  const huge = editor(); paste(huge, text(1500));
  assert.equal(huge.getText(), "[paste #1 1500 chars]");
});

test("the character count ignores what Pi strips from a paste", () => {
  const e = editor();
  paste(e, text(480) + "\x00\x01\x02".repeat(40)); // control characters are removed, leaving 480
  assert.equal(e.getText(), text(480));
});

test("the marker sits where the cursor was, and later pastes get later numbers", () => {
  const e = editor();
  e.insertTextAtCursor("before ");
  paste(e, text(700));
  e.insertTextAtCursor(" after ");
  paste(e, text(900));
  assert.equal(e.getText(), "before [paste #1 700 chars] after [paste #2 900 chars]");
  assert.equal(e.getExpandedText(), `before ${text(700)} after ${text(900)}`);
});

test("clicking the marker expands it in place", () => {
  const e = editor();
  const body = text(600);
  paste(e, body);
  e.render(WIDTH);
  const result = click(e, 3, 1);
  assert.deepEqual({ handled: result?.handled, focus: result?.focus }, { handled: true, focus: true });
  assert.equal(e.getText(), body);
  assert.equal(e.pastes.size, 0);
  assert.deepEqual([e.state.cursorLine, e.state.cursorCol], [0, 600], "cursor ends after the text, ready to keep typing");
});

test("text around the marker is kept when it expands", () => {
  const e = editor();
  e.insertTextAtCursor("see: ");
  paste(e, text(600));
  e.insertTextAtCursor(" thanks");
  e.render(WIDTH);
  click(e, 8, 1);
  assert.equal(e.getText(), `see: ${text(600)} thanks`);
});

test("a multi-line paste expands into separate lines", () => {
  const e = editor();
  const body = Array.from({ length: 12 }, (_, i) => `line number ${i}`).join("\n");
  e.insertTextAtCursor("A ");
  paste(e, body);
  e.insertTextAtCursor(" Z");
  e.render(WIDTH);
  click(e, 4, 1);
  assert.equal(e.getText(), `A ${body} Z`);
  assert.equal(e.state.lines.length, 12);
  assert.deepEqual([e.state.cursorLine, e.state.cursorCol], [11, "line number 11".length]);
});

test("expanding one of two markers renumbers the other so it still expands on send", () => {
  const e = editor();
  const first = text(600), second = text(800);
  paste(e, first);
  e.insertTextAtCursor(" ");
  paste(e, second);
  e.render(WIDTH);
  click(e, 3, 1); // the first marker
  assert.equal(e.getText(), `${first} [paste #1 800 chars]`);
  assert.equal(e.getExpandedText(), `${first} ${second}`);
  assert.deepEqual([...e.pastes.keys()], [1]);
  paste(e, text(700)); // lands at the cursor, which is now after the expanded first paste
  assert.match(e.getText(), /\[paste #2 700 chars\]/, "the next paste continues the numbering");
  assert.equal(e.getExpandedText(), `${first}${text(700)} ${second}`, "and every marker still expands to its own text");
});

test("expanding is undoable", () => {
  const e = editor();
  paste(e, text(600));
  e.render(WIDTH);
  click(e, 3, 1);
  assert.equal(e.getText().length, 600);
  e.undo();
  assert.equal(e.getText(), "[paste #1 600 chars]");
  assert.equal(e.getExpandedText(), text(600));
});

test("only a left click on the marker expands it", () => {
  const e = editor();
  e.insertTextAtCursor("plain text ");
  paste(e, text(600));
  e.render(WIDTH);
  const marker = "plain text ".length + 2;
  click(e, 2, 1); // on the plain text
  assert.match(e.getText(), /\[paste #1/);
  click(e, marker, 0); // the border above the text
  click(e, marker, 5); // below the text area
  click(e, marker, 1, { button: "right" });
  e.handleMouse({ type: "press", button: "left", x: marker, y: 1, width: WIDTH, height: 8, screenX: marker, screenY: 1 });
  e.handleMouse({ type: "release", button: "left", x: marker, y: 1, width: WIDTH, height: 8, screenX: marker, screenY: 1 });
  assert.match(e.getText(), /\[paste #1 600 chars\]/, "still collapsed");
  click(e, marker, 1);
  assert.equal(e.getText(), `plain text ${text(600)}`);
});

test("moving the cursor onto a marker with the keyboard does not expand it", () => {
  const e = editor();
  paste(e, text(600));
  e.state.cursorCol = 0;
  assert.equal(e.getText(), "[paste #1 600 chars]");
});

test("applying the extension again after a reload does not stack a second wrapper", () => {
  pasteFold({} as any);
  pasteFold({} as any);
  const e = editor();
  paste(e, text(600));
  assert.equal(e.getText(), "[paste #1 600 chars]");
  e.render(WIDTH);
  click(e, 3, 1);
  assert.equal(e.getText(), text(600));
});

test("clicking ordinary text still moves the cursor like before", () => {
  const e = editor();
  e.insertTextAtCursor("hello world");
  e.render(WIDTH);
  click(e, 5, 1);
  assert.equal(e.state.cursorCol, 5);
});
