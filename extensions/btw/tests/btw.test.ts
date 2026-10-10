import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, initTheme, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BtwOverlay } from "../overlay.ts";
import btwExtension from "../index.ts";
initTheme("dark", false);
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { buildBtwContext } from "../context.ts";
import { BtwThread } from "../thread.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: "test", provider: "test", api: "openai-responses" } as any;
const user = (text: string) => ({ role: "user", content: text, timestamp: 1 } as const);
const assistant = (text = "answer", extra = {}) => ({ role: "assistant", content: [{ type: "text", text }],
  api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 2, ...extra } as any);
const toolCall = (id: string) => ({ type: "toolCall", id, name: "read", arguments: { path: "config.ts" } });
const toolResult = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "read",
  content: [{ type: "text", text: "export const port = 8080" }], isError: false, timestamp: 3 } as any);
const request = (thread: BtwThread, question = "which port?", registry = provider()) => ({
  registry, model, context: buildBtwContext([user("read the config")], "You are Pi", thread.exchanges, question),
  question, reasoning: "high" as const,
});
function provider(text = "8080", stopReason = "stop", errorMessage?: string) {
  return { streamSimple: (_model: any, _context: any, _options: any) => {
    const message = assistant(text, { stopReason, errorMessage });
    return Object.assign((async function* () {
      yield { type: "text_delta", delta: text, partial: message };
      yield stopReason === "error" ? { type: "error", error: message } : { type: "done", message };
    })(), { result: async () => message });
  }} as any;
}

test("snapshot preserves completed messages and tool results without exposing tools", () => {
  const messages = [
    { role: "system", content: "old", toolsAdded: [{ name: "read", description: "read", parameters: {} }], timestamp: 0 },
    user("read config"), assistant("reading", { content: [toolCall("call-1")] }), toolResult("call-1"), assistant("port 8080"),
  ];
  const original = structuredClone(messages);
  const context = buildBtwContext(messages as any, "current instructions", [], "port?");
  assert.deepEqual(messages, original);
  assert.match(context.systemPrompt!, /current instructions/);
  assert.match(JSON.stringify(context.messages), /Tool result: read \(call-1\)/);
  assert.match(JSON.stringify(context.messages), /export const port = 8080/);
  assert.deepEqual(getCurrentTools(normalizeContext(context).messages), []);
  assert.equal((context.messages.at(-1) as any).content, "port?");
  (context.messages[0] as any).content = "changed";
  assert.deepEqual(messages, original);
});

test("partial output and unfinished parallel tool calls do not enter the snapshot", () => {
  const messages = [user("read both"), assistant("checking", { content: [
    { type: "text", text: "checking" }, toolCall("done"), toolCall("pending"),
  ], stopReason: "toolUse" }), toolResult("done"), assistant("unfinished", { stopReason: "pending" })];
  const context = buildBtwContext(messages as any, "Pi", [], "what is known?");
  assert.match(JSON.stringify(context.messages), /Tool call: read \(done\)/);
  assert.doesNotMatch(JSON.stringify(context), /unfinished|Tool call: read \(pending\)/);
});

test("no-tools requests replay historical tool traces as text, preserving tool-result images", () => {
  const result = toolResult("read-1");
  result.content.push({ type: "image", data: "test-image", mimeType: "image/png" });
  const context = buildBtwContext([user("read"), assistant("", { content: [toolCall("read-1")] }), result] as any, "Pi", [], "what did it show?");
  assert.equal(context.messages.some(m => m.role === "toolResult"), false);
  assert.equal(context.messages.some((m: any) => m.role === "assistant" && m.content.some((b: any) => b.type === "toolCall")), false);
  assert.match(JSON.stringify(context.messages), /config.ts/);
  assert.match(JSON.stringify(context.messages), /export const port = 8080/);
  assert.ok(context.messages.some((m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "image")));
});

test("orphan tool results are omitted", () => {
  const context = buildBtwContext([user("hello"), toolResult("missing")] as any, "Pi", [], "question");
  assert.equal(context.messages.filter(m => m.role === "toolResult").length, 0);
});

test("compaction and context edits follow the actual Pi session projection", () => {
  const session = SessionManager.inMemory();
  session.appendMessage(user("old huge conversation") as any);
  const retained = session.appendMessage(user("retained"));
  session.appendCompaction("earlier discussion summary", retained, 100);
  const changed = session.appendMessage(user("original"));
  session.appendContextEdit(changed, { content: "replacement" });
  const context = buildBtwContext(session.buildSessionProjection().messages, "Pi", [], "question");
  const text = JSON.stringify(context);
  assert.match(text, /earlier discussion summary/);
  assert.match(text, /retained/);
  assert.match(text, /replacement/);
  assert.doesNotMatch(text, /old huge conversation|original/);
});

test("context projects relevant message data without cloning discarded details", () => {
  const image = { type: "image", data: "source-image", mimeType: "image/png" };
  const source = [
    user("question"),
    assistant("answer", { content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "private" }] }),
  ] as any[];
  source[0].content = [{ type: "text", text: "question" }, image];
  Object.defineProperty(source[0], "unused", { enumerable: true, get() { throw new Error("discarded field was cloned"); } });
  const result = toolResult("call");
  Object.defineProperty(result, "details", { enumerable: true, get() { throw new Error("tool details were cloned"); } });
  source.push(assistant("call", { content: [toolCall("call"), { ...toolCall("unused"), arguments: { huge: "unused-argument" } }] }), result);
  const context = buildBtwContext(source, "Pi", [], "ask");
  const copiedBlocks = (context.messages[0] as any).content;
  assert.notEqual(copiedBlocks[1], image);
  assert.equal(copiedBlocks[1].data, image.data);
  assert.notEqual(copiedBlocks[0], source[0].content[0]);
  copiedBlocks[1].data = "provider mutation";
  assert.equal(image.data, "source-image");
  image.mimeType = "source mutation";
  assert.equal(copiedBlocks[1].mimeType, "image/png");
  assert.match(JSON.stringify(context), /private/);
  assert.doesNotMatch(JSON.stringify(context), /huge|unused-argument/);
});

test("snapshot keeps shell output and custom messages while respecting excluded shell commands", () => {
  const context = buildBtwContext([
    { role: "bashExecution", command: "pwd", output: "/workspace", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
    { role: "bashExecution", command: "secret", output: "not-for-context", excludeFromContext: true, exitCode: 0, cancelled: false, truncated: false, timestamp: 2 },
    { role: "custom", customType: "note", display: true, content: [{ type: "text", text: "custom note" }], timestamp: 3 },
  ], "Pi", [], "where?");
  assert.match(JSON.stringify(context), /workspace/);
  assert.match(JSON.stringify(context), /custom note/);
  assert.doesNotMatch(JSON.stringify(context), /not-for-context/);
});

test("snapshot isolates assistant usage and signatures in both directions", () => {
  const source = assistant("answer", { usage: structuredClone(usage), providerThinkingLevel: "high", thinkingLevel: "high", content: [
    { type: "text", text: "answer", textSignature: "signature" },
    { type: "thinking", thinking: "reason", thinkingSignature: "thinking-signature" },
  ] });
  const context = buildBtwContext([source], "Pi", [], "ask");
  const copied = context.messages.find(m => m.role === "assistant")!;
  assert.equal(copied.providerThinkingLevel, "high", "Anthropic replays per-message effort levels");
  assert.equal(copied.thinkingLevel, "high");
  copied.usage.cost.total = 42;
  assert.equal(source.usage.cost.total, 0);
  source.content[0].textSignature = "mutated";
  assert.equal(copied.content[0].type === "text" && copied.content[0].textSignature, "signature");
});

test("follow-up side exchanges are replayed separately from main history", () => {
  const main = [user("main")];
  const context = buildBtwContext(main, "Pi", [{ question: "side one", answer: "answer one", status: "done" }], "follow-up");
  assert.equal(main.length, 1);
  assert.match(JSON.stringify(context.messages), /side one/);
  assert.match(JSON.stringify(context.messages), /answer one/);
  assert.equal((context.messages.at(-1) as any).content, "follow-up");
  assert.match(JSON.stringify(context.messages), /no tool access/i);
});

test("thread streams a response, retaining only successful exchanges", async () => {
  const thread = new BtwThread();
  const updates: string[] = [];
  await thread.ask(request(thread), () => updates.push(thread.current?.answer || ""));
  assert.ok(updates.includes("8080"));
  assert.equal(thread.current?.status, "done");
  assert.deepEqual(thread.exchanges.map(e => e.answer), ["8080"]);
  assert.equal(thread.busy, false);
});

test("a burst of 1000 deltas requests one redraw per interval and flushes on completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const thread = new BtwThread();
  const updates: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const registry = { streamSimple: () => Object.assign((async function* () {
    for (let i = 0; i < 1000; i++) yield { type: "text_delta", delta: "a", partial: assistant() };
    await wait;
    yield { type: "text_delta", delta: "b", partial: assistant() };
    yield { type: "done", message: assistant("a".repeat(1000) + "b") };
  })(), { result: async () => assistant("a".repeat(1000) + "b") }) } as any;
  const pending = thread.ask(request(thread, "burst", registry), () => updates.push(thread.current?.answer || ""));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(49);
  assert.deepEqual(updates, []);
  t.mock.timers.tick(1);
  assert.deepEqual(updates, ["a".repeat(1000)]);
  release(); await pending;
  assert.deepEqual(updates, ["a".repeat(1000), "a".repeat(1000) + "b"]);
  t.mock.timers.tick(1000);
  assert.equal(updates.length, 2, "completion clears the trailing timer");
});

test("cancelling a stream prevents queued and late redraws", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const thread = new BtwThread();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const registry = { streamSimple: () => Object.assign((async function* () {
    yield { type: "text_delta", delta: "partial", partial: assistant("partial") };
    await wait;
  })(), { result: async () => assistant("late") }) } as any;
  let updates = 0;
  const pending = thread.ask(request(thread, "cancel", registry), () => { updates++; });
  await new Promise(resolve => setImmediate(resolve));
  thread.cancel();
  t.mock.timers.tick(1000);
  release(); await pending;
  assert.equal(updates, 0);
  assert.equal(thread.current?.status, "cancelled");
});

test("thread holds at most 20 successful exchanges", async () => {
  const thread = new BtwThread();
  for (let i = 0; i < 21; i++) await thread.ask(request(thread, `q${i}`), () => {});
  assert.equal(thread.exchanges.length, 20);
  assert.equal(thread.exchanges[0].question, "q1");
  assert.equal(thread.exchanges.at(-1)?.question, "q20");
});

test("provider errors remain visible but never enter side history", async () => {
  const thread = new BtwThread();
  await thread.ask(request(thread, "fail", provider("", "error", "auth failed")), () => {});
  assert.equal(thread.current?.status, "error");
  assert.match(thread.current?.error || "", /auth failed/);
  assert.equal(thread.exchanges.length, 0);
});

test("synchronous provider setup failure is surfaced and releases the busy guard", async () => {
  const thread = new BtwThread();
  const registry = { streamSimple: () => { throw new Error("missing credentials"); } } as any;
  await thread.ask(request(thread, "fail", registry), () => {});
  assert.equal(thread.current?.status, "error");
  assert.match(thread.current?.error || "", /missing credentials/);
  assert.equal(thread.busy, false);
});

test("empty responses are errors and not retained", async () => {
  const thread = new BtwThread();
  await thread.ask(request(thread, "empty", provider("")), () => {});
  assert.equal(thread.current?.status, "error");
  assert.equal(thread.exchanges.length, 0);
});

test("unexpected tool calls never execute and show a warning", async () => {
  const thread = new BtwThread();
  const registry = { streamSimple: () => {
    const message = assistant("I would read the file", { content: [{ type: "text", text: "I would read the file" }, toolCall("new")], stopReason: "toolUse" });
    return Object.assign((async function* () { yield { type: "done", message }; })(), { result: async () => message });
  }} as any;
  await thread.ask(request(thread, "read", registry), () => {});
  assert.match(thread.current?.answer || "", /nothing was executed/i);
});

test("cancellation uses an independent signal and drops late completion", async () => {
  const thread = new BtwThread();
  const mainController = new AbortController();
  let sideSignal: AbortSignal | undefined;
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const registry = { streamSimple: (_m: any, _c: any, options: any) => {
    sideSignal = options.signal;
    return Object.assign((async function* () { await wait; yield { type: "done", message: assistant("late") }; })(), { result: async () => assistant("late") });
  }} as any;
  const pending = thread.ask(request(thread, "slow", registry), () => {});
  assert.equal(thread.busy, true);
  await assert.rejects(thread.ask(request(thread), () => {}), /already running/i);
  thread.cancel();
  assert.equal(sideSignal?.aborted, true);
  assert.equal(mainController.signal.aborted, false);
  finish(); await pending;
  assert.equal(thread.current?.status, "cancelled");
  assert.equal(thread.exchanges.length, 0);
});

test("clear discards state and prevents cancelled work from reviving it", async () => {
  const thread = new BtwThread();
  await thread.ask(request(thread), () => {});
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const registry = { streamSimple: () => Object.assign((async function* () {
    await wait; yield { type: "done", message: assistant("stale") };
  })(), { result: async () => assistant("stale") }) } as any;
  const pending = thread.ask(request(thread, "slow", registry), () => {});
  thread.clear(); finish(); await pending;
  assert.equal(thread.exchanges.length, 0);
  assert.equal(thread.current, undefined);
});

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
function overlayFixture(thread = new BtwThread(), rows = 24) {
  let dismissed = 0;
  let renders = 0;
  const copied: string[] = [];
  const tui = { terminal: { rows }, requestRender: () => { renders++; } } as any;
  const overlay = new BtwOverlay(thread, tui, plainTheme, () => { dismissed++; }, async text => { copied.push(text); });
  return { overlay, thread, tui, copied, dismissed: () => dismissed, renders: () => renders };
}

test("overlay does not reset Markdown when rendered content is unchanged", () => {
  const fixture = overlayFixture();
  fixture.thread.exchanges.push({ question: "question", answer: "# stable", status: "done" });
  const markdown = (fixture.overlay as any).markdown;
  let setTextCalls = 0;
  const setText = markdown.setText.bind(markdown);
  markdown.setText = (text: string) => { setTextCalls++; setText(text); };
  fixture.overlay.render(80);
  const cachedLines = (markdown as any).cachedLines;
  fixture.overlay.render(80);
  assert.equal(setTextCalls, 1);
  assert.equal((markdown as any).cachedLines, cachedLines);
});

test("overlay renders Markdown within narrow widths and short terminals", () => {
  const fixture = overlayFixture();
  fixture.thread.exchanges.push({ question: "中文 question 👨‍👩‍👧‍👦", answer: "# Header\n\n中文中文中文\n```ts\nconst long = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';\n```", status: "done" });
  for (const rows of [5, 10, 24]) {
    fixture.tui.terminal.rows = rows;
    for (const width of [1, 2, 3, 8, 20, 80]) {
      const lines = fixture.overlay.render(width);
      assert.ok(lines.length <= Math.floor(rows * 0.85), `${lines.length} lines for ${rows} rows`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} columns for width ${width}`);
    }
  }
});

test("multiline side questions cannot inject extra terminal rows into overlay chrome", () => {
  const fixture = overlayFixture();
  fixture.thread.exchanges.push({ question: "first\nquestion\twith tabs", answer: "one", status: "done" },
    { question: "second\r\nquestion", answer: "two", status: "done" });
  for (const rows of [5, 24]) {
    fixture.tui.terminal.rows = rows;
    const lines = fixture.overlay.render(80);
    for (const line of lines) assert.doesNotMatch(line, /[\r\n\t]/);
  }
});

test("short-terminal fallback still supports scrolling through an answer", () => {
  const fixture = overlayFixture(new BtwThread(), 5);
  fixture.thread.exchanges.push({ question: "question", answer: "first line\n\nsecond line\n\nthird line\n\nfourth line", status: "done" });
  const first = fixture.overlay.render(80).join("\n");
  fixture.overlay.handleInput("\x1b[B");
  const scrolled = fixture.overlay.render(80).join("\n");
  assert.notEqual(scrolled, first);
});

test("overlay navigation, scrolling and copying operate on side answers only", async () => {
  const fixture = overlayFixture();
  fixture.thread.exchanges.push({ question: "first", answer: "one\n".repeat(50), status: "done" },
    { question: "second", answer: "two", status: "done" });
  assert.match(fixture.overlay.render(80).join("\n"), /second/);
  fixture.overlay.handleInput("[");
  assert.match(fixture.overlay.render(80).join("\n"), /first/);
  fixture.overlay.handleInput("\x1b[B");
  fixture.overlay.handleInput("c");
  await Promise.resolve();
  assert.deepEqual(fixture.copied, ["one\n".repeat(50)]);
  fixture.overlay.handleInput("]");
  assert.match(fixture.overlay.render(80).join("\n"), /second/);
  fixture.overlay.handleInput("x");
  assert.equal(fixture.thread.exchanges.length, 0);
  assert.equal(fixture.dismissed(), 1);
});

test("Escape cancels only the side request and dismisses the overlay", async () => {
  const fixture = overlayFixture();
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  let signal: AbortSignal | undefined;
  const registry = { streamSimple: (_m: any, _c: any, options: any) => {
    signal = options.signal;
    return Object.assign((async function* () { await wait; yield { type: "done", message: assistant("late") }; })(), { result: async () => assistant("late") });
  }} as any;
  const pending = fixture.thread.ask(request(fixture.thread, "slow", registry), () => {});
  fixture.overlay.handleInput("\x1b");
  assert.equal(signal?.aborted, true);
  assert.equal(fixture.dismissed(), 1);
  finish(); await pending;
});

function commandFixture(mode = "tui") {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const notices: string[] = [];
  const calls: any[] = [];
  const session = SessionManager.inMemory();
  session.appendMessage(user("the config is app.ts"));
  let component: any;
  let close!: () => void;
  const pi = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: any) => events.set(event, handler),
    getThinkingLevel: () => "high",
    sendMessage: () => { throw new Error("Must not write a chat message"); },
    sendUserMessage: () => { throw new Error("Must not write a user message"); },
    appendEntry: () => { throw new Error("Must not persist a side exchange"); },
  } as any;
  const ctx = {
    mode, hasUI: mode === "tui", sessionManager: session, model, thinkingLevel: "high",
    signal: new AbortController().signal,
    isIdle: () => false,
    waitForIdle: () => { throw new Error("Must work during the main turn"); },
    abort: () => { throw new Error("Must not abort the main turn"); },
    getSystemPrompt: () => "same agent instructions",
    modelRegistry: { streamSimple: (...args: any[]) => {
      calls.push(args); return provider("app.ts").streamSimple(...args);
    }},
    ui: {
      notify: (text: string) => notices.push(text),
      custom: (factory: any, options: any) => {
        assert.equal(options.overlay, true);
        return new Promise(resolve => {
          close = () => { resolve(undefined); component?.dispose?.(); };
          component = factory({ terminal: { rows: 24 }, requestRender: () => {} }, plainTheme, {}, close);
        });
      },
    },
  } as any;
  btwExtension(pi);
  return { commands, events, notices, calls, session, ctx, close: () => close(), component: () => component };
}

test("only /btw is registered; non-TUI and empty invocations do not call the model", async () => {
  const fixture = commandFixture("print");
  assert.deepEqual([...fixture.commands.keys()], ["btw"]);
  await fixture.commands.get("btw").handler("question", fixture.ctx);
  assert.match(fixture.notices.join("\n"), /interactive/i);
  assert.equal(fixture.calls.length, 0);
  const empty = commandFixture();
  await empty.commands.get("btw").handler("  ", empty.ctx);
  assert.match(empty.notices.join("\n"), /\/btw/);
  assert.equal(empty.calls.length, 0);
});

test("command uses the current model and context during a main turn without changing session entries", async () => {
  const fixture = commandFixture();
  const before = structuredClone(fixture.session.getEntries());
  const leaf = fixture.session.getLeafId();
  const pending = fixture.commands.get("btw").handler("which config?", fixture.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1);
  const [selected, context, options] = fixture.calls[0];
  assert.equal(selected, model);
  assert.match(JSON.stringify(context), /the config is app.ts/);
  assert.match(context.systemPrompt, /same agent instructions/);
  assert.equal(options.reasoning, "high");
  assert.notEqual(options.signal, fixture.ctx.signal);
  assert.match(fixture.component().render(80).join("\n"), /app.ts/);
  fixture.component().handleInput("\r"); await pending;
  assert.deepEqual(fixture.session.getEntries(), before);
  assert.equal(fixture.session.getLeafId(), leaf);
  const reopen = fixture.commands.get("btw").handler("", fixture.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1);
  fixture.close(); await reopen;
});

test("thinking off is mapped to the model registry's no-reasoning option", async () => {
  const fixture = commandFixture();
  fixture.ctx.thinkingLevel = "off";
  const pending = fixture.commands.get("btw").handler("question", fixture.ctx);
  await new Promise(resolve => setImmediate(resolve));
  fixture.close(); await pending;
  assert.equal(fixture.calls[0][2].reasoning, undefined);
});

test("installed Pi extension loader registers /btw without errors", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-btw-load-"));
  try {
    const result = await discoverAndLoadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], agentDir, agentDir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.deepEqual([...result.extensions[0].commands.keys()], ["btw"]);
    assert.equal(result.extensions[0].tools.size, 0);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("completion of an old overlay cannot remove the new overlay's busy guard", async () => {
  const fixture = commandFixture();
  const first = fixture.commands.get("btw").handler("first", fixture.ctx);
  await new Promise(resolve => setImmediate(resolve));
  fixture.close();
  const second = fixture.commands.get("btw").handler("", fixture.ctx);
  await first;
  const third = fixture.commands.get("btw").handler("third", fixture.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1, "another model request must not start over an existing overlay");
  fixture.close();
  await Promise.all([second, third]);
});

test("session lifecycle cleanup closes overlays and clears their side history", async () => {
  for (const event of ["session_start", "session_tree", "session_shutdown"]) {
    const fixture = commandFixture();
    const pending = fixture.commands.get("btw").handler("question", fixture.ctx);
    await new Promise(resolve => setImmediate(resolve));
    await fixture.events.get(event)({}, fixture.ctx);
    await pending;
    await fixture.commands.get("btw").handler("", fixture.ctx);
    assert.match(fixture.notices.join("\n"), /\/btw/);
    assert.equal(fixture.calls.length, 1);
  }
});
