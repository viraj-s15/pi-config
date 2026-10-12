import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Spacer, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
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
/** Text the agent wrote alongside tool calls ("Now the README:"): a note, not an answer. */
const note = (text: string, timestamp = clock++) => new AssistantMessageComponent(
	{ role: "assistant", content: [{ type: "text", text }, { type: "toolCall", id: "n", name: "bash", arguments: {} }], usage: usage(50), stopReason: "toolUse", timestamp } as any,
	true, undefined, "● thinking…", 0,
);
const FAINT = "\x1b[2m";
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

test("the answer's own thinking hides in the line, and closes the timeline when the line is opened", () => {
	const s = setup();
	try {
		const answer = withText("Here is the answer.", true);
		s.labels.recordEnd((answer as any).lastMessage, (answer as any).lastMessage.timestamp + 6_000);
		const a = tool("a");
		const chat = chatOf(thinkingOnly(), a, answer);
		const collapsed = screen(chat);
		assert.match(collapsed, /▸ Worked for \d+s · 1 tool call · thought/);
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
			assert.match(open, /▾ Worked for \d+s · 1 tool call[\s\S]*│ ● thought[\s\S]*│ ● echo a[\s\S]*│\s+● thought 3s\s*\n[\s\S]*Here is the answer\./, "opened: everything, in order");
		} finally { tui.stop({ preserveScreen: true }); }
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

test("even a single row folds: one tool call, or the thinking before an answer", () => {
	const s = setup();
	try {
		const lone = screen(chatOf(tool("x"), withText("done")));
		assert.match(lone, /▸ 1 tool call · echo[\s\S]*done/);
		assert.doesNotMatch(lone, /● echo x/);
		const answer = withText("Just an answer.", true);
		s.labels.recordEnd((answer as any).lastMessage, (answer as any).lastMessage.timestamp + 4_000);
		const answerOnly = screen(chatOf(answer));
		assert.match(answerOnly, /▸ thought 2s[\s\S]*Just an answer\./);
		assert.doesNotMatch(answerOnly, /● thought/);
	} finally { s.done(); }
});

test("the run in progress folds too, and the line keeps counting as work arrives", () => {
	const s = setup();
	try {
		const thinking = thinkingOnly();
		s.grouping.beginRun();
		s.grouping.messageStart((thinking as any).lastMessage.timestamp);
		const running = new ToolExecutionComponent("bash", "running", { command: "echo running" }, { outputPad: 0 }, {
			renderShell: "self", renderCall: () => ({ render: () => ["● echo running"], invalidate() {} }),
		} as any, { requestRender() {} } as any, "/tmp");
		s.grouping.toolStart("running");
		const chat = chatOf(tool("old"), withText("earlier answer"), thinking, tool("a"), running);
		const live = screen(chat);
		assert.match(live, /▸ (Worked for \d+s · )?1 tool call · echo[\s\S]*earlier answer[\s\S]*▸ Working for \d+s · 2 tool calls · thought · echo ×2/);
		assert.doesNotMatch(live, /● (echo|thought)/, "no separate rows while it works");
		chat.addChild(tool("b"));
		assert.match(screen(chat), /▸ Working for \d+s · 3 tool calls/);
	} finally { s.done(); }
});

test("Ctrl+O does not open folded lines; it only shows output inside one you opened", () => {
	const s = setup();
	try {
		const a = tool("a"), b = tool("b");
		const chat = chatOf(a, b);
		a.setExpanded(true); b.setExpanded(true);
		assert.equal(chat.render(100).length, 1);
		assert.match(headerOf(chat), /^▸ 2 tool calls/);
	} finally { s.done(); }
});

test("a run's thinking, tool calls and notes fold into one 'Worked for' line; only the answer stays", () => {
	const s = setup();
	try {
		const base = 1_900_000_000_000;
		const t1 = thinkingOnly(base), t2 = thinkingOnly(base + 6_000);
		s.labels.recordEnd((t1 as any).lastMessage, base + 5_000);
		s.labels.recordEnd((t2 as any).lastMessage, base + 13_000);
		const n = note("Found the cause, fixing it.", base + 14_000);
		s.labels.recordEnd((n as any).lastMessage, base + 15_000);
		const answer = withText("All done.", false, base + 20_000);
		s.labels.recordEnd((answer as any).lastMessage, base + 72_000);
		const chat = chatOf(t1, tool("a"), t2, tool("b"), n, tool("c"), answer);
		const text = screen(chat);
		assert.equal(headerOf(chat), "▸ Worked for 1m 12s · 3 tool calls · thought 12s · echo ×3");
		assert.doesNotMatch(text, /Found the cause/, "notes fold away with the work");
		assert.match(text, /All done\./);
		assert.equal(chat.render(100).filter((line) => /[▸▾]/.test(strip(line))).length, 1, "one line for the whole run");
	} finally { s.done(); }
});

test("opened, the run is a quiet timeline: every row faint, behind a rail", () => {
	const s = setup();
	const tui = new TuiAltScreen(mouseTerminal());
	try {
		const chat = chatOf(thinkingOnly(), tool("a"), note("Checking the config."), tool("b"), withText("Answer."));
		tui.addChild(chat);
		(tui as any).beforeTerminalStart();
		tui.renderNow();
		const y = tui.getScreenLines().findIndex((line) => line.includes("tool calls"));
		for (const suffix of ["M", "m"]) (tui as any).handleViewportInput(`\x1b[<0;5;${y + 1}${suffix}`);
		tui.renderNow();
		const lines = chat.render(100);
		const header = lines.findIndex((line) => strip(line).includes("▾"));
		const answerAt = lines.findIndex((line) => strip(line).includes("Answer."));
		const inside = lines.slice(header + 1, answerAt).filter((line) => strip(line).trim() && !strip(line).includes("Answer"));
		assert.ok(inside.some((line) => strip(line).includes("Checking the config.")), "notes are back");
		for (const line of inside.filter((l) => strip(l).trim() !== "│")) {
			assert.match(strip(line), /^│ /, `rail: ${strip(line)}`);
			assert.ok(line.includes(FAINT), `faint: ${strip(line)}`);
		}
		assert.ok(!lines[answerAt]!.includes(FAINT), "the answer is not dimmed");
		for (const line of lines) assert.ok(visibleWidth(line) <= 100);
	} finally {
		tui.stop({ preserveScreen: true });
		s.done();
	}
});

test("while the run is going the line counts up: 'Working for'", () => {
	const s = setup();
	try {
		const started = Date.now() - 65_000;
		const t = thinkingOnly(started);
		s.grouping.beginRun();
		s.grouping.messageStart(started);
		const chat = chatOf(t, tool("a"));
		assert.match(headerOf(chat), /^▸ Working for 1m 0[5-6]s · 1 tool call/);
		s.grouping.settle();
	} finally { s.done(); }
});

test("a reply that only thought before answering still reads 'thought Ns'", () => {
	const s = setup();
	try {
		const answer = withText("Short answer.", true, 1_950_000_000_000);
		s.labels.recordEnd((answer as any).lastMessage, 1_950_000_000_000 + 4_000);
		assert.match(screen(chatOf(answer)), /▸ thought 2s\n[\s\S]*Short answer\./);
	} finally { s.done(); }
});
