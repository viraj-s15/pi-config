import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestLoader } from "../../../tests/pi-runtime.mjs";

const loader = await createTestLoader();
const { buildActionItems, selectAction, ActionPalette } = await loader.import(
  fileURLToPath(new URL("../index.ts", import.meta.url)),
);

const commands = [
  { name: "actions", description: "Open palette", source: "extension", sourceInfo: { source: "extension", name: "actions" } },
  { name: "help", description: "Show help", source: "extension", sourceInfo: { source: "extension", name: "demo" } },
  { name: "review", description: "Review changes", source: "skill", sourceInfo: { source: "skill", name: "review" } },
  { name: "prompt", description: "A prompt", source: "prompt", sourceInfo: { source: "prompt", name: "prompt" } },
];

test("discovers extension, skill, prompt, and curated builtin actions with honest metadata", () => {
  const items = buildActionItems(commands);
  assert(items.some((item) => item.name === "help" && item.source === "extension"));
  assert(items.some((item) => item.name === "review" && item.source === "skill"));
  assert(items.some((item) => item.name === "prompt" && item.source === "prompt"));
  assert(items.some((item) => item.name === "settings" && item.source === "builtin"));
  assert.equal(items.find((item) => item.name === "settings")?.shortcut, undefined);
  assert.equal(items.find((item) => item.name === "actions")?.shortcut, "Ctrl+Shift+K");
  assert.equal(items.find((item) => item.name === "help")?.hint, "Insert slash command; press Enter to run");
  assert.equal(items.find((item) => item.name === "model")?.label, "/model");
  assert.equal(items.find((item) => item.name === "thinking")?.label, "/thinking");
  assert(items.some((item) => item.name === "copy" && item.description.includes("Copy last agent message")));
  assert(items.some((item) => item.name === "settings" && item.description === "Open settings menu"));
});

test("command-name overrides use getCommands metadata rather than stale curated metadata", () => {
  const items = buildActionItems([
    { name: "settings", description: "Extension override", source: "extension", sourceInfo: { source: "extension", name: "custom" } },
  ]);
  const settings = items.filter((item) => item.name === "settings");
  assert.equal(settings.length, 1);
  assert.equal(settings[0].description, "Extension override");
  assert.equal(settings[0].source, "extension");
});

test("selecting an action with an empty draft inserts a first-line slash command without sending", async () => {
  const calls = [];
  const ctx = {
    sendUserMessage() { throw new Error("Palette selection must not send a user message"); },
    ui: {
      getEditorText: () => "",
      setEditorText: (text) => calls.push(["editor", text]),
      notify: (...args) => calls.push(["notify", ...args]),
    },
  };
  await selectAction({ name: "help", command: "/help" }, ctx);
  assert.deepEqual(calls[0], ["editor", "/help"]);
  assert(!calls.some(([kind]) => kind === "send"));
});

test("selecting an action confirms replacement and saves the exact draft for restore", async () => {
  const calls = [];
  let draft = "  unsent draft\nwith newline  ";
  const ctx = {
    ui: {
      getEditorText: () => draft,
      setEditorText: (text) => { calls.push(["editor", text]); draft = text; },
      confirm: async (...args) => { calls.push(["confirm", ...args]); return true; },
      notify: (...args) => calls.push(["notify", ...args]),
    },
  };
  await selectAction({ name: "help", command: "/help" }, ctx);
  assert.deepEqual(calls[0], ["confirm", "Replace editor draft?", "Your current draft will be saved and can be restored with /actions restore."]);
  assert.equal(draft, "/help");
  assert(buildActionItems([], true).some((item) => item.action === "restore"));
  await selectAction({ name: "restore-draft", action: "restore" }, ctx);
  assert.equal(draft, "  unsent draft\nwith newline  ");
});

test("refusing action replacement leaves draft and editor untouched", async () => {
  const calls = [];
  const draft = "do not alter";
  const ctx = {
    ui: {
      getEditorText: () => draft,
      setEditorText: (...args) => calls.push(["editor", ...args]),
      confirm: async () => false,
      notify: (...args) => calls.push(["notify", ...args]),
    },
  };
  await selectAction({ name: "help", command: "/help" }, ctx);
  assert.equal(calls.length, 0);
  assert.equal(draft, "do not alter");
});

test("whitespace-only drafts still require confirmation before replacement", async () => {
  const calls = [];
  const draft = "  \n";
  const ctx = {
    ui: {
      getEditorText: () => draft,
      setEditorText: (...args) => calls.push(["editor", ...args]),
      confirm: async (...args) => { calls.push(["confirm", ...args]); return false; },
      notify: (...args) => calls.push(["notify", ...args]),
    },
  };
  await selectAction({ name: "help", command: "/help" }, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "confirm");
  assert.equal(draft, "  \n");
});

test("palette uses real Input and SelectList, filters interactively, and cancel does not touch draft", () => {
  let done;
  let selected;
  const tui = { requestRender() {} };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const kb = { matches: () => false };
  const component = ActionPalette.create({
    tui, theme, keybindings: kb, done: (value) => { done = value; },
    actions: [{ name: "help", label: "/help", description: "Show help", source: "extension" }],
    onSelect: (item) => { selected = item; },
  });
  component.focused = true;
  assert.equal(component.focused, true);
  assert.match(component.render(60).join("\n"), /Search:/);
  assert.match(component.render(60).join("\n"), /\/help/);
  component.handleInput("z");
  assert.match(component.render(60).join("\n"), /No matching actions/);
  component.handleInput("\x1b");
  assert.equal(done, null);
  assert.equal(selected, undefined);
});

test("Enter selects a filtered result and the renderer stays within a narrow width", async () => {
  let selected;
  const tui = { requestRender() {} };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const component = ActionPalette.create({
    tui, theme, keybindings: { matches: () => false }, done() {},
    actions: [
      { name: "help", label: "/help", description: "Show help", source: "extension" },
      { name: "reload", label: "/reload", description: "Reload extensions", source: "builtin" },
    ],
    onSelect: (item) => { selected = item; },
  });
  component.handleInput("r");
  component.handleInput("\r");
  assert.equal(selected?.name, "reload");
  const runtime = await import("../../../tests/pi-runtime.mjs");
  const { visibleWidth } = await import(runtime.piModuleUrl("@earendil-works/pi-tui/dist/index.js"));
  assert(component.render(24).every((line) => visibleWidth(line) <= 24));
});

test("extension registers one palette command and shortcut and skips custom UI outside TUI", async () => {
  const { default: extension } = await loader.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
  const commands = new Map();
  const shortcuts = new Map();
  const commandsList = [{ name: "extension-task", description: "An extension action", source: "extension" }];
  extension({
    getCommands: () => commandsList,
    registerCommand: (name, options) => commands.set(name, options),
    registerShortcut: (key, options) => shortcuts.set(key, options),
  });
  assert.equal(commands.size, 1);
  assert.equal(shortcuts.size, 1);
  assert.equal(shortcuts.has("ctrl+shift+k"), true);
  assert.equal(shortcuts.has("ctrl+shift+p"), false);
  let editor = "original";
  const editorUi = {
    getEditorText: () => editor,
    setEditorText: (text) => { editor = text; },
    confirm: async () => true,
    notify() {},
  };
  await selectAction({ name: "custom", command: "/custom" }, { ui: editorUi });
  await commands.get("actions").handler("restore", { mode: "rpc", ui: editorUi });
  assert.equal(editor, "original");
  let customCalls = 0;
  await commands.get("actions").handler("", {
    mode: "rpc", ui: { custom: () => { customCalls++; } },
  });
  assert.equal(customCalls, 0);
});

test("restoring refuses to overwrite a different unsent draft without confirmation", async () => {
  let editor = "original draft";
  let allow = true;
  const ctx = { ui: {
    getEditorText: () => editor,
    setEditorText: text => { editor = text; },
    confirm: async () => allow,
    notify() {},
  } };
  await selectAction({ name: "usage", command: "/usage" }, ctx);
  editor = "a new unsent draft";
  allow = false;
  await selectAction({ name: "restore-draft", action: "restore" }, ctx);
  assert.equal(editor, "a new unsent draft");
  allow = true;
  await selectAction({ name: "restore-draft", action: "restore" }, ctx);
  assert.equal(editor, "original draft");
  await selectAction({ name: "restore-draft", action: "restore" }, ctx);
  assert.equal(editor, "a new unsent draft", "the replaced draft remains recoverable");
});

test("choosing another action before running preserves the original draft backup", async () => {
  let editor = "original draft";
  const ctx = { ui: {
    getEditorText: () => editor,
    setEditorText: text => { editor = text; },
    confirm: async () => true,
    notify() {},
  } };
  await selectAction({ name: "usage", command: "/usage" }, ctx);
  await selectAction({ name: "model", command: "/model" }, ctx);
  await selectAction({ name: "restore-draft", action: "restore" }, ctx);
  assert.equal(editor, "original draft");
});

test("the palette is an opaque /usage-style box: rounded border, every row padded to full width", async () => {
  const { visibleWidth } = await import((await import("../../../tests/pi-runtime.mjs")).piModuleUrl("@earendil-works/pi-tui/dist/index.js"));
  const theme = { fg: (_c, t) => t, bold: t => t };
  const component = ActionPalette.create({
    tui: { requestRender() {} }, theme, keybindings: { matches: () => false }, done() {},
    actions: [{ name: "help", label: "/help", description: "Show help", source: "extension" }],
    onSelect() {},
  });
  component.focused = true;
  for (const width of [60, 24]) {
    const lines = component.render(width);
    const plain = lines.map(l => l.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b_pi:c\x07/g, ""));
    assert.ok(lines.every(l => visibleWidth(l) === width), `every row is exactly ${width} columns, so the transcript cannot show through`);
    assert.ok(plain[0].startsWith("╭") && plain[0].endsWith("╮") && plain[0].includes("Actions"), plain[0]);
    assert.ok(plain.slice(1, -1).every(l => l.startsWith("│") && l.endsWith("│")), "side borders on every body row");
    assert.ok(plain.slice(1, -1).every(l => l.startsWith("│ ")), "one column of padding inside the border, like /usage");
    assert.ok(plain.at(-1).startsWith("╰") && plain.at(-1).endsWith("╯"));
  }
  assert.match(component.render(60).join("\n"), /38;2;255;126;182/, "rose border like /usage");
});
