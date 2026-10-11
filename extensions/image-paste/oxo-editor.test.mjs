import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestLoader, piModuleUrl } from "../../tests/pi-runtime.mjs";

const loader = await createTestLoader();
const { OxoEditor } = await loader.import(join(dirname(fileURLToPath(import.meta.url)), "../oxo-ui/index.ts"));
const { attachImagePaths } = await loader.import(join(dirname(fileURLToPath(import.meta.url)), "attach.ts"));
const pasteFold = (await loader.import(join(dirname(fileURLToPath(import.meta.url)), "../paste-fold/index.ts"))).default;
pasteFold({});
const { Editor, TuiAltScreen } = await import(piModuleUrl("@earendil-works/pi-tui/dist/index.js"));
const theme = { borderColor: (s) => s, selectList: {} };
const kb = { matches: () => false };
const WIDTH = 50;
function editor() {
  return new OxoEditor({ requestRender() {}, terminal: { rows: 40, columns: WIDTH } }, theme, kb);
}
const click = (e, x, y = 1) => e.handleMouse({ type: "click", button: "left", x, y, width: WIDTH, height: 8, screenX: x, screenY: y });

test("OxoEditor remains a real CustomEditor and chips never replace model-facing text", () => {
  const e = editor();
  assert.ok(e instanceof Editor);
  const path = "/tmp/Screen\\ shot 你好.png";
  e.insertTextAtCursor(`describe ${path} please`);
  assert.equal(e.getText(), `describe ${path} please`);
  assert.equal(e.getExpandedText(), `describe ${path} please`);
  assert.ok(e.render(WIDTH).some((line) => line.includes(`[Image 1 · Screen shot 你好.png ×]`)));
  assert.ok(e.render(WIDTH).every((line) => !line.includes("/tmp/Screen")));
});

test("existing pasted-text markers remain expanded for submission beside image chips", () => {
  const e = editor();
  const body = "large pasted prompt ".repeat(32);
  e.handleInput(`\x1b[200~${body}\x1b[201~`);
  e.insertTextAtCursor(" /tmp/shot.png");
  assert.equal(e.getExpandedText(), `${body} /tmp/shot.png`);
  const rendered = e.render(WIDTH).join("\n");
  assert.match(rendered, /paste #1/);
  assert.match(rendered, /Image 1 · shot.png/);
});

test("clicking a chip's × removes only that path and is undoable", () => {
  const e = editor();
  const path = "/tmp/shot.png";
  e.insertTextAtCursor(`before ${path} after`);
  e.render(WIDTH);
  const x = 2 + "before ".length + "[Image 1 · shot.png ".length;
  const result = click(e, x);
  assert.equal(result?.handled, true);
  assert.equal(e.getText(), "before  after");
  assert.equal(e.getExpandedText(), "before  after");
  e.undo();
  assert.equal(e.getText(), `before ${path} after`);
});

test("the unchanged source still produces a real outgoing image attachment", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-chip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "Screenshot 你好.png");
  writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  const e = editor();
  e.insertTextAtCursor(`inspect ${path.replace(/ /g, "\\ ")}`);
  const raw = e.getExpandedText();
  assert.ok(e.render(WIDTH).join("\n").includes("Image 1 · Screenshot 你好.png"));
  const result = await attachImagePaths(raw);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(result.text, "inspect [image 1: Screenshot 你好.png]");
});

test("ordinary click coordinates account for the Oxo arrow gutter", () => {
  const e = editor();
  e.insertTextAtCursor("abc");
  e.render(WIDTH);
  click(e, 3);
  assert.equal(e.state.cursorCol, 1);
});

test("clicking blank space after a chip does not inspect or remove it", () => {
  const e = editor();
  const path = "/tmp/shot.png";
  let inspected;
  e.onImageInspect = (value) => { inspected = value; };
  e.insertTextAtCursor(path);
  const lines = e.render(WIDTH);
  assert.ok(lines.join("\\n").includes("Image 1 · shot.png"));
  click(e, WIDTH - 3);
  assert.equal(inspected, undefined);
  assert.equal(e.getText(), path);
});

test("clicking a chip body inspects its original path and ordinary clicks preserve cursor mapping", () => {
  const e = editor();
  const path = "/tmp/shot.png";
  let inspected;
  e.onImageInspect = (value) => { inspected = value; };
  e.insertTextAtCursor(`a ${path} z`);
  e.render(WIDTH);
  click(e, 2 + "a [Image 1 · ".length);
  assert.equal(inspected, path);
  click(e, 3);
  assert.equal(e.state.cursorCol, 1);
});

test("wrapped Unicode chips and later chips hit the correct original path", () => {
  const e = editor();
  const first = `/tmp/${"界🙂".repeat(24)}.png`;
  const second = "/tmp/second.png";
  let inspected;
  e.onImageInspect = (value) => { inspected = value; };
  e.insertTextAtCursor(`${first} ${second}`);
  const rendered = e.render(20).join("\\n");
  assert.ok(rendered.includes("Image 1"));
  const rows = e.render(20);
  const firstChipLine = rows.findIndex((line) => line.includes("Image 1"));
  assert.ok(firstChipLine >= 0);
  click(e, 3, firstChipLine + 1);
  assert.equal(inspected, first);
  const secondChipLine = e.render(20).findIndex((line) => line.includes("Image 2"));
  assert.ok(secondChipLine >= 0);
  click(e, 3, secondChipLine + 1);
  assert.equal(inspected, second);
});

test("raw fullscreen mouse press/release hit the actual chip, not trailing blank space", () => {
  const terminal = { columns: WIDTH, rows: 40, write() {}, hideCursor() {}, showCursor() {}, stop() {} };
  const tui = new TuiAltScreen(terminal);
  const e = new OxoEditor(tui, theme, kb);
  let inspected;
  e.onImageInspect = (value) => { inspected = value; };
  e.insertTextAtCursor("/tmp/shot.png");
  tui.addChild(e);
  tui.beforeTerminalStart();
  try {
    tui.renderNow();
    const row = tui.getScreenLines().findIndex((line) => line.includes("Image 1"));
    assert.ok(row >= 0);
    for (const suffix of ["M", "m"]) (tui).handleViewportInput(`\x1b[<0;${WIDTH};${row + 1}${suffix}`);
    assert.equal(inspected, undefined);
    assert.equal(e.getText(), "/tmp/shot.png");
  } finally { tui.stop({ preserveScreen: true }); }
});

test("vertical cursor movement uses projected wrapping without entering the raw path", () => {
  const e = editor();
  const path = `/tmp/${"long-name-".repeat(12)}.png`;
  e.insertTextAtCursor(`before ${path} after`);
  e.state.cursorCol = 0;
  e.render(16);
  e.handleInput("\x1b[B");
  const start = "before ".length;
  assert.ok(e.state.cursorCol <= start || e.state.cursorCol >= start + path.length);
  assert.equal(e.getText(), `before ${path} after`);
});

test("backspace at an attachment edge removes the whole chip and remains undoable", () => {
  const e = editor();
  const path = "/tmp/shot.png";
  e.insertTextAtCursor(`a ${path}`);
  e.state.cursorCol = e.getText().length;
  e.handleInput("\x7f");
  assert.equal(e.getText(), "a ");
  e.undo();
  assert.equal(e.getText(), `a ${path}`);
});

test("clicking a paste-fold marker beside an image expands its content", () => {
  const e = editor();
  const body = "folded prompt ".repeat(40);
  e.handleInput(`\x1b[200~${body}\x1b[201~`);
  e.insertTextAtCursor(" /tmp/shot.png");
  e.render(WIDTH);
  click(e, 5);
  assert.ok(e.getExpandedText().startsWith(body));
  assert.ok(e.getText().startsWith(body));
  assert.ok(e.getText().includes("/tmp/shot.png"), JSON.stringify({ text: e.getText(), expanded: e.getExpandedText() }));
});

test("left and right cursor movement skip the hidden raw attachment path atomically", () => {
  const e = editor();
  const path = "/tmp/a-very-long-name.png";
  e.insertTextAtCursor(`x ${path} y`);
  e.state.cursorCol = 2;
  e.handleInput("\x1b[C");
  assert.equal(e.state.cursorCol, 2 + path.length);
  e.handleInput("\x1b[D");
  assert.equal(e.state.cursorCol, 2);
});

test("attachment management has a shortcut so it can inspect a nonempty draft", async () => {
  const imagePaste = (await loader.import(join(dirname(fileURLToPath(import.meta.url)), "index.ts"))).default;
  let shortcut;
  imagePaste({ on() {}, registerCommand() {}, registerShortcut: (key, options) => {
    assert.equal(key, "ctrl+shift+i"); shortcut = options;
  } });
  assert.ok(shortcut, "keyboard chooser is registered");
  const notices = [];
  await shortcut.handler({ mode: "tui", ui: {
    getEditorText: () => "inspect /tmp/shot.png",
    select: async (_title, options) => options[0],
    notify: message => notices.push(message),
  } });
  assert.match(notices[0], /shot\.png/);
});

test("attachment command arguments survive Pi clearing the editor on command submission", async () => {
  const imagePaste = (await loader.import(join(dirname(fileURLToPath(import.meta.url)), "index.ts"))).default;
  let command;
  imagePaste({ on() {}, registerCommand: (_name, options) => { command = options; }, registerShortcut() {} });
  let draft = "";
  await command.handler("before /tmp/shot.png after", { ui: {
    getEditorText: () => draft,
    setEditorText: text => { draft = text; },
    select: async () => undefined,
    notify() {},
  } });
  assert.equal(draft, "before /tmp/shot.png after");
});

test("/attachments inspect reports path details without opening the file", async () => {
  const imagePaste = (await loader.import(join(dirname(fileURLToPath(import.meta.url)), "index.ts"))).default;
  let command;
  imagePaste({ on() {}, registerCommand: (name, options) => { if (name === "attachments") command = options; }, registerShortcut() {} });
  const notices = [];
  const draft = "/tmp/shot.png";
  const context = {
    ui: {
      getEditorText: () => draft,
      setEditorText() { throw new Error("inspect must not replace the draft"); },
      select: async (title, options) => { assert.equal(title, "/attachments"); assert.equal(options.length, 2); return options[0]; },
      notify: (message, type) => notices.push({ message, type }),
    },
  };
  await command.handler("", context);
  assert.match(notices[0].message, /shot\.png/);
  assert.equal(notices[0].type, "info");
});

test("keyboard attachment removal is undoable through Pi's public editor setter", async () => {
  const imagePaste = (await loader.import(join(dirname(fileURLToPath(import.meta.url)), "index.ts"))).default;
  let shortcut;
  imagePaste({ on() {}, registerCommand() {}, registerShortcut: (_key, options) => { shortcut = options; } });
  const e = editor();
  const body = "large pasted prompt ".repeat(32);
  e.handleInput(`\x1b[200~${body}\x1b[201~`);
  e.insertTextAtCursor(" /tmp/shot.png");
  const raw = e.getText();
  await shortcut.handler({ mode: "tui", ui: {
    getEditorText: () => e.getExpandedText(),
    setEditorText: value => e.setText(value),
    select: async (_title, options) => options.find(item => item.startsWith("Remove")),
    notify: message => assert.ok(!message.includes("cannot be undone")),
  } });
  assert.equal(e.getExpandedText(), `${body} `);
  e.undo();
  assert.equal(e.getText(), raw);
  assert.equal(e.getExpandedText(), `${body} /tmp/shot.png`);
});

test("/attachments remove replaces only the selected image in the expanded draft", async () => {
  const imagePaste = (await loader.import(join(dirname(fileURLToPath(import.meta.url)), "index.ts"))).default;
  let command;
  imagePaste({ on() {}, registerCommand: (name, options) => { if (name === "attachments") command = options; }, registerShortcut() {} });
  let draft = "before /tmp/shot.png after";
  const notices = [];
  const context = {
    ui: {
      getEditorText: () => draft,
      setEditorText: (value) => { draft = value; },
      select: async (_title, options) => options.find((option) => option.startsWith("Remove")),
      notify: (message) => notices.push(message),
    },
  };
  await command.handler("", context);
  assert.equal(draft, "before  after");
  assert.match(notices[0], /removed/i);
});
