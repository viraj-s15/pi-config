import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Spacer, TuiAltScreen } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { installToolGrouping } from "../tool-groups.ts";
import { installThinkingLabels } from "../thinking-label.ts";

initTheme("dark", false);
const OBSERVED = Symbol.for("pi-config.compact-tools.observed-result");
const RED = "\x1b[38;2;250;77;86m";
const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");
const screen = (chat: Container, width = 100) => strip(chat.render(width).join("\n"));
const headerOf = (chat: Container, width = 100) => strip(chat.render(width).find((line) => /tool call|thought/.test(strip(line)) && /[▸▾]/.test(line)) ?? "").trim();

const tool = (id: string, isError = false, requestRender: () => void = () => {}, command = `echo ${id}`) => {
	const component = new ToolExecutionComponent("bash", id, { command }, { outputPad: 0 }, {
		renderShell: "self",
		renderCall: (args: any) => ({ render: () => [`● ${args.command}`], invalidate() {} }),
		renderResult: (_result: any, options: any) => ({ render: () => options.expanded ? [`output ${id}`] : [], invalidate() {} }),
	} as any, { requestRender } as any, "/tmp");
	component.updateResult({ content: [{ type: "text", text: `output ${id}` }], isError }, false);
	return component;
};

let clock = 1_800_000_000_000; // clear of the timestamps other test files use
const usage = (output: number, reasoning?: number) => ({ input: 0, output, reasoning, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } });
/** A reply that only thought and called a tool: it shows as one "● thought" row. */
const thinkingOnly = (timestamp = clock++) => new AssistantMessageComponent(
	{ role: "assistant", content: [{ type: "thinking", thinking: "planning" }, { type: "toolCall", id: "x", name: "bash", arguments: {} }], usage: usage(100, 100), stopReason: "toolUse", timestamp } as any,
	true, undefined, "● thinking…", 0,
);
/** Assistant text, optionally thinking first (a final answer usually does). */
const withText = (text: string, thought = false, timestamp = clock++) => new AssistantMessageComponent(
	{ role: "assistant", content: [...(thought ? [{ type: "thinking", thinking: "deciding" }] : []), { type: "text", text }], usage: usage(200, thought ? 100 : undefined), stopReason: "stop", timestamp } as any,
	true, undefined, "● thinking…", 0,
);
const chatOf = (...children: any[]) => {
	const chat = new Container();
	for (const child of children) chat.addChild(child);
	return chat;
};
const mouseTerminal = () => ({ columns: 100, rows: 40, write() {}, hideCursor() {}, showCursor() {}, stop() {} }) as any;

function setup() {
	const labels = installThinkingLabels();
	labels.setEnabled(true);
	const grouping = installToolGrouping();
	grouping.reset();
	grouping.setEnabled(true);
	return {
		labels, grouping,
		done() { grouping.setEnabled(false); labels.setEnabled(false); },
	};
}

test("a finished stretch of work folds into one line; the chat's real children are untouched", () => {
	const s = setup();
	try {
		const a = tool("a"), b = tool("b"), c = tool("c");
		const chat = chatOf(a, b, c);
		const before = [...chat.children];
		assert.equal(headerOf(chat), "▸ 3 tool calls · echo ×3");
		assert.equal(chat.render(100).length, 1, "one line");
		assert.deepEqual(chat.children, before, "Pi's Ctrl+O traversal still sees every real tool row");
		assert.equal(chat.render(100).length, 1, "re-rendering never stacks lines");
	} finally { s.done(); }
});

test("failures fold too, counted in red", () => {
	const s = setup();
	try {
		const chat = chatOf(tool("a"), tool("bad", true), tool("b"));
		assert.equal(headerOf(chat), "▸ 3 tool calls (1 failed) · echo ×3");
		assert.ok(chat.render(100)[0]!.includes(`${RED}(1 failed)`));
	} finally { s.done(); }
});

test("thinking rows fold in, and the line says how long it thought", () => {
	const s = setup();
	try {
		const t1 = thinkingOnly(), t2 = thinkingOnly();
		s.labels.recordEnd((t1 as any).lastMessage, (t1 as any).lastMessage.timestamp + 5_000);
		s.labels.recordEnd((t2 as any).lastMessage, (t2 as any).lastMessage.timestamp + 7_000);
		const chat = chatOf(t1, tool("a"), t2, tool("b"));
		assert.equal(headerOf(chat), "▸ 2 tool calls · thought 12s · echo ×2");
		assert.ok(!screen(chat).includes("● thought"), "no separate thinking rows");
	} finally { s.done(); }
});

test("the answer's own thinking hides in the line, and comes back when the line is opened", () => {
	const s = setup();
	try {
		const answer = withText("Here is the answer.", true);
		s.labels.recordEnd((answer as any).lastMessage, (answer as any).lastMessage.timestamp + 6_000);
		const a = tool("a");
		const chat = chatOf(thinkingOnly(), a, answer);
		const collapsed = screen(chat);
		assert.match(collapsed, /▸ 1 tool call · thought/);
		assert.match(collapsed, /Here is the answer\./);
		assert.doesNotMatch(collapsed, /● thought/, "the answer's thinking row is folded away");
		const tui = new TuiAltScreen(mouseTerminal());
		try {
			tui.addChild(chat);
			(tui as any).beforeTerminalStart();
			tui.renderNow();
			const y = tui.getScreenLines().findIndex((line) => line.includes("tool call"));
			for (const suffix of ["M", "m"]) (tui as any).handleViewportInput(`\x1b[<0;5;${y + 1}${suffix}`);
			tui.renderNow();
			const open = strip(tui.getScreenLines().join("\n"));
			assert.match(open, /▾ 1 tool call[\s\S]*● thought[\s\S]*echo a[\s\S]*● thought 3s[\s\S]*Here is the answer\./, "opened: everything, in order");
		} finally { tui.stop({ preserveScreen: true }); }
	} finally { s.done(); }
});

test("notes between tool calls stay visible; each stretch around them gets its own line", () => {
	const s = setup();
	try {
		const chat = chatOf(thinkingOnly(), tool("a"), tool("b"), withText("Found the cause, fixing it."), tool("c"), thinkingOnly(), tool("d"), withText("Done."));
		const text = screen(chat);
		assert.equal((text.match(/▸ 2 tool calls/g) ?? []).length, 2);
		assert.match(text, /▸ 2 tool calls[\s\S]*Found the cause, fixing it\.[\s\S]*▸ 2 tool calls[\s\S]*Done\./);
	} finally { s.done(); }
});

test("a single row is left alone: one tool call, or one thinking row before an answer", () => {
	const s = setup();
	try {
		const lone = screen(chatOf(tool("x"), withText("done")));
		assert.match(lone, /● echo x/);
		assert.doesNotMatch(lone, /tool call/);
		const answerOnly = screen(chatOf(withText("Just an answer.", true)));
		assert.match(answerOnly, /● thought[\s\S]*Just an answer\./);
		assert.doesNotMatch(answerOnly, /▸/);
	} finally { s.done(); }
});

test("spacers around a stretch stay outside it; spacers inside fold away", () => {
	const s = setup();
	try {
		const chat = chatOf(new Spacer(1), tool("a"), new Spacer(1), tool("b"), new Spacer(1), withText("ok"));
		const lines = chat.render(100).map(strip);
		assert.equal(lines[0]!.trim(), "");
		assert.match(lines[1]!, /▸ 2 tool calls/);
		assert.equal(lines[2]!.trim(), "");
	} finally { s.done(); }
});

test("the current run stays live; it folds when the agent settles", () => {
	const s = setup();
	let requests = 0;
	try {
		const old = [tool("old-a"), tool("old-b")];
		const thinking = thinkingOnly();
		const a = tool("run-a", false, () => requests++), b = tool("run-b", false, () => requests++);
		const chat = chatOf(...old, withText("earlier answer"), thinking, a, b);
		s.grouping.beginRun();
		s.grouping.messageStart((thinking as any).lastMessage.timestamp);
		s.grouping.toolStart("run-a");
		s.grouping.toolStart("run-b");
		const live = screen(chat);
		assert.match(live, /▸ 2 tool calls[\s\S]*earlier answer[\s\S]*● thought[\s\S]*echo run-a[\s\S]*echo run-b/, "earlier work is folded, this run is not");
		const before = requests;
		s.grouping.settle();
		assert.ok(requests > before, "settling asks for a redraw");
		assert.equal((screen(chat).match(/▸ 2 tool calls/g) ?? []).length, 2);
	} finally { s.done(); }
});

test("a tool still running keeps its stretch open", () => {
	const s = setup();
	try {
		const running = new ToolExecutionComponent("bash", "running", { command: "echo running" }, { outputPad: 0 }, {
			renderShell: "self", renderCall: () => ({ render: () => ["● echo running"], invalidate() {} }),
		} as any, { requestRender() {} } as any, "/tmp");
		const chat = chatOf(tool("a"), running);
		assert.match(screen(chat), /echo a[\s\S]*echo running/);
		running.updateResult({ content: [], isError: false }, false);
		assert.equal(headerOf(chat), "▸ 2 tool calls · echo ×2");
	} finally { s.done(); }
});

test("clicking the line opens compact rows, Ctrl+O still shows tool output, clicking again closes", () => {
	const s = setup();
	const tui = new TuiAltScreen(mouseTerminal());
	try {
		const a = tool("a"), b = tool("b");
		const chat = chatOf(a, b);
		tui.addChild(chat);
		(tui as any).beforeTerminalStart();
		const click = (label: string) => {
			tui.renderNow();
			const y = tui.getScreenLines().findIndex((line) => line.includes(label));
			assert.ok(y >= 0, `${label} is visible`);
			for (const suffix of ["M", "m"]) (tui as any).handleViewportInput(`\x1b[<0;5;${y + 1}${suffix}`);
			tui.renderNow();
		};
		click("tool calls");
		let lines = strip(tui.getScreenLines().join("\n"));
		assert.match(lines, /▾ 2 tool calls[\s\S]*echo a[\s\S]*echo b/);
		assert.doesNotMatch(lines, /output a/, "opening the line shows the rows, not every output");
		for (const child of chat.children) if (child instanceof ToolExecutionComponent) child.setExpanded(true); // Ctrl+O
		tui.renderNow();
		assert.match(tui.getScreenLines().join("\n"), /output a[\s\S]*output b/);
		click("tool calls");
		lines = strip(tui.getScreenLines().join("\n"));
		assert.doesNotMatch(lines, /echo a/);
		assert.deepEqual(chat.children, [a, b]);
	} finally {
		tui.stop({ preserveScreen: true });
		s.done();
	}
});

test("Ctrl+O on a folded line opens it", () => {
	const s = setup();
	try {
		const a = tool("a"), b = tool("b");
		const chat = chatOf(a, b);
		chat.render(100);
		for (const child of chat.children) if (child instanceof ToolExecutionComponent) child.setExpanded(true);
		assert.match(screen(chat), /▾ 2 tool calls[\s\S]*output a[\s\S]*output b/);
	} finally { s.done(); }
});

test("the line names what ran: recognised results first, then programs and tools", () => {
	const s = setup();
	try {
		const noop = () => {};
		const a = tool("a"), b = tool("b", false, noop, "rg -n x src | head"), c = tool("c", false, noop, "cd src && rg y"), d = tool("d", false, noop, "sed -n 1p f");
		(a as any).rendererState[OBSERVED] = "Tests 228 passed 0 failed";
		const chat = chatOf(a, b, c, d);
		assert.equal(headerOf(chat), "▸ 4 tool calls · Tests 228 passed 0 failed · rg ×2 · sed");
		assert.ok(strip(chat.render(30)[0]!).length <= 30, "narrow widths truncate");
	} finally { s.done(); }
});

test("turning folding off shows every row, including the answer's thinking", () => {
	const s = setup();
	const answer = withText("The answer.", true);
	const chat = chatOf(thinkingOnly(), tool("a"), tool("b"), answer);
	assert.match(screen(chat), /▸ 2 tool calls/);
	s.grouping.setEnabled(false);
	const off = screen(chat);
	assert.doesNotMatch(off, /tool call/);
	assert.match(off, /● thought[\s\S]*echo a[\s\S]*echo b[\s\S]*● thought[\s\S]*The answer\./);
	s.labels.setEnabled(false);
});

test("a stale patch left by an older version after /reload is replaced, not trusted", () => {
	const LEGACY = Symbol.for("pi-config.compact-tools.grouping");
	const V2 = Symbol.for("pi-config.compact-tools.grouping.v2");
	const proto = Container.prototype as any;
	const s = setup();
	try {
		const original = proto[V2].original;
		let staleCalls = 0;
		proto.render = function (this: any, width: number) { staleCalls++; return original.call(this, width); };
		proto[LEGACY] = { enabled: true, originalRender: original };
		const reloaded = installToolGrouping();
		reloaded.setEnabled(true);
		assert.equal(proto[LEGACY], undefined, "the legacy marker is cleared");
		const chat = chatOf(tool("a"), tool("b"));
		assert.match(screen(chat), /2 tool calls/);
		assert.equal(staleCalls, 0, "the old wrapper is no longer in the render path");
	} finally { s.done(); }
});
