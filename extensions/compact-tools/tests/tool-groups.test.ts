import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, TuiAltScreen } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";
import { installToolGrouping } from "../tool-groups.ts";

initTheme("dark", false);
const OBSERVED = Symbol.for("pi-config.compact-tools.observed-result");

const tool = (id: string, isError = false, requestRender: () => void = () => {}) => {
	const component = new ToolExecutionComponent("bash", id, { command: `echo ${id}` }, { outputPad: 0 }, {
		renderShell: "self",
		renderCall: (args: any) => ({ render: () => [`● ${args.command}`], invalidate() {} }),
		renderResult: (_result: any, options: any) => ({ render: () => options.expanded ? [`output ${id}`] : [], invalidate() {} }),
	} as any, { requestRender } as any, "/tmp");
	component.updateResult({ content: [{ type: "text", text: `output ${id}` }], isError }, false);
	return component;
};

const mouseTerminal = () => ({ columns: 80, rows: 30, write() {}, hideCursor() {}, showCursor() {}, stop() {} }) as any;

test("successful runs project a visual group without replacing original chat children", () => {
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const a = tool("a"), failed = tool("bad", true), b = tool("b"), c = tool("c");
		const chat = new Container();
		for (const row of [a, failed, b, c]) chat.addChild(row);
		const before = [...chat.children];
		const output = chat.render(80).join("\n");
		assert.match(output, /2 successful tools/);
		assert.deepEqual(chat.children, before, "render restores exact original child references and order");
		assert.ok(chat.children.every(child => child instanceof ToolExecutionComponent), "Pi's direct-child traversal still finds each real tool row");
		assert.equal(chat.render(80).filter(line => line.includes("successful tools")).length, 1, "re-rendering never nests or stacks groups");
	} finally {
		grouping.setEnabled(false);
	}
});

test("running rows stay visible and completed rows reconstructed by updateResult group safely", () => {
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const a = tool("a"), b = tool("b");
		const running = new ToolExecutionComponent("bash", "running", { command: "echo running" }, { outputPad: 0 }, {
			renderShell: "self", renderCall: () => ({ render: () => ["● echo running"], invalidate() {} }),
		} as any, { requestRender() {} } as any, "/tmp");
		const chat = new Container();
		chat.addChild(running);
		chat.addChild(a);
		chat.addChild(b);
		assert.match(chat.render(80).join("\n"), /echo running[\s\S]*2 successful tools/);
		running.updateResult({ content: [], isError: false }, false);
		assert.match(chat.render(80).join("\n"), /3 successful tools/);
		assert.deepEqual(chat.children, [running, a, b]);
	} finally {
		grouping.setEnabled(false);
	}
});

test("successful tools stay ungrouped until the active agent run settles, then regroup and request render", () => {
	const grouping = installToolGrouping();
	let requests = 0;
	try {
		grouping.setEnabled(true);
		grouping.reset();
		const a = tool("run-a", false, () => requests++);
		const b = tool("run-b", false, () => requests++);
		const chat = new Container();
		chat.addChild(a);
		chat.addChild(b);
		grouping.beginRun();
		grouping.toolStart("run-a");
		grouping.toolStart("run-b");
		a.updateResult({ content: [{ type: "text", text: "output a" }], isError: false }, false);
		b.updateResult({ content: [{ type: "text", text: "output b" }], isError: false }, false);
		assert.match(chat.render(80).join("\n"), /echo run-a[\s\S]*echo run-b/);
		assert.ok(!chat.render(80).join("\n").includes("successful tools"), "completed rows remain visible before agent_settled");
		const requestsBeforeSettle = requests;
		grouping.settle();
		assert.ok(requests > requestsBeforeSettle, "settling schedules a full TUI render using the runtime row UI");
		assert.match(chat.render(80).join("\n"), /2 successful tools/);
		assert.deepEqual(chat.children, [a, b]);
		grouping.beginRun();
		const next = tool("next", false, () => requests++);
		chat.addChild(next);
		grouping.toolStart("next");
		next.updateResult({ content: [{ type: "text", text: "output next" }], isError: false }, false);
		assert.match(chat.render(80).join("\n"), /2 successful tools[\s\S]*echo next/);
		const nextTwo = tool("next-two", false, () => requests++);
		chat.addChild(nextTwo);
		grouping.toolStart("next-two");
		nextTwo.updateResult({ content: [{ type: "text", text: "output next two" }], isError: false }, false);
		assert.match(chat.render(80).join("\n"), /2 successful tools[\s\S]*echo next[\s\S]*echo next-two/);
		grouping.reset();
		assert.match(chat.render(80).join("\n"), /4 successful tools/, "session reset clears tracked run IDs without replacing tool children");
		assert.deepEqual(chat.children, [a, b, next, nextTwo]);
	} finally {
		grouping.setEnabled(false);
	}
});

test("grouping off restores existing rows on the next render and on does not stack groups", () => {
	const grouping = installToolGrouping();
	try {
		const a = tool("a"), b = tool("b");
		const chat = new Container();
		chat.addChild(a);
		chat.addChild(b);
		grouping.setEnabled(true);
		assert.match(chat.render(80).join("\n"), /2 successful tools/);
		grouping.setEnabled(false);
		assert.match(chat.render(80).join("\n"), /echo a[\s\S]*echo b/);
		grouping.setEnabled(true);
		assert.match(chat.render(80).join("\n"), /2 successful tools/);
		assert.deepEqual(chat.children, [a, b]);
	} finally {
		grouping.setEnabled(false);
	}
});

test("native direct-child expansion and row clicks expose original tool output", () => {
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const a = tool("a"), b = tool("b");
		const chat = new Container();
		chat.addChild(a);
		chat.addChild(b);
		chat.render(80);
		// This matches InteractiveMode's Ctrl+O traversal: it sees only direct native tool children.
		for (const child of chat.children) if (child instanceof ToolExecutionComponent) child.setExpanded(true);
		assert.deepEqual(chat.children, [a, b]);
		assert.match(chat.render(80).join("\n"), /output a[\s\S]*output b/);
		for (const child of chat.children) if (child instanceof ToolExecutionComponent) child.setExpanded(false);
		const collapsed = chat.render(80).join("\n");
		assert.match(collapsed, /2 successful tools/);
		assert.ok(!collapsed.includes("output a"));
	} finally {
		grouping.setEnabled(false);
	}
});

test("group header click toggles the originals through raw fullscreen SGR press and release", () => {
	const grouping = installToolGrouping();
	const tui = new TuiAltScreen(mouseTerminal());
	try {
		grouping.setEnabled(true);
		const a = tool("a"), b = tool("b");
		const chat = new Container();
		chat.addChild(a);
		chat.addChild(b);
		tui.addChild(chat);
		(tui as any).beforeTerminalStart();
		const activate = (label: string) => {
			tui.renderNow();
			const y = tui.getScreenLines().findIndex(line => line.includes(label));
			assert.ok(y >= 0, `${label} is visible`);
			for (const suffix of ["M", "m"]) (tui as any).handleViewportInput(`\x1b[<0;5;${y + 1}${suffix}`);
			tui.renderNow();
		};
		activate("successful tools");
		assert.ok(tui.getScreenLines().some(line => line.includes("output a")), "expanded group renders original output");
		const rowY = tui.getScreenLines().findIndex(line => line.includes("output a"));
		for (const suffix of ["M", "m"]) (tui as any).handleViewportInput(`\x1b[<0;5;${rowY + 1}${suffix}`);
		tui.renderNow();
		assert.ok(!tui.getScreenLines().some(line => line.includes("output a")), "clicking an original row toggles its own output");
		assert.ok(tui.getScreenLines().some(line => line.includes("output b")), "other original rows retain their expanded output");
		activate("successful tools");
		assert.ok(!tui.getScreenLines().some(line => line.includes("output b")), "group header collapses all original rows");
		assert.deepEqual(chat.children, [a, b]);
	} finally {
		tui.stop({ preserveScreen: true });
		grouping.setEnabled(false);
	}
});

const thinkingOnly = () => new AssistantMessageComponent(
	{ role: "assistant", content: [{ type: "thinking", thinking: "planning" }, { type: "toolCall", id: "x", name: "bash", arguments: {} }] } as any,
	true, undefined, "● thinking…", 0,
);
const withText = (text: string) => new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text }] } as any, true, undefined, "● thinking…", 0);
const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("thinking rows between tool calls do not stop a run from grouping (a real chat's shape)", () => {
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const a = tool("a"), t1 = thinkingOnly(), b = tool("b"), t2 = thinkingOnly(), c = tool("c");
		const chat = new Container();
		for (const child of [a, t1, b, t2, c]) chat.addChild(child as any);
		const collapsed = strip(chat.render(80).join("\n"));
		assert.match(collapsed, /3 successful tools/);
		assert.ok(!collapsed.includes("thinking"), "the folded group hides its own thinking rows");
		assert.deepEqual(chat.children, [a, t1, b, t2, c], "the real children are untouched");
		(a as any).setExpanded(true);
		const expanded = strip(chat.render(80).join("\n"));
		assert.match(expanded, /echo a[\s\S]*thinking[\s\S]*echo b[\s\S]*thinking[\s\S]*echo c/, "expanding shows everything in its original order");
	} finally { grouping.setEnabled(false); }
});

test("assistant text, a failure, or a user message still splits groups; trailing thinking stays outside", () => {
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const chat = new Container();
		for (const child of [tool("a"), thinkingOnly(), tool("b"), withText("Here is what I found."), tool("c"), tool("d"), thinkingOnly()]) chat.addChild(child as any);
		const text = strip(chat.render(80).join("\n"));
		assert.equal((text.match(/2 successful tools/g) ?? []).length, 2, "one group before the text, one after");
		assert.ok(text.includes("Here is what I found."));
		assert.ok(text.trimEnd().endsWith("thinking…"), "a thinking row after the last tool is left where it was");
		const single = new Container();
		for (const child of [tool("x"), thinkingOnly(), withText("done")]) single.addChild(child as any);
		assert.ok(!strip(single.render(80).join("\n")).includes("successful tools"), "one tool call is never a group");
	} finally { grouping.setEnabled(false); }
});

test("spacers between tool rows are absorbed", () => {
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const chat = new Container();
		for (const child of [tool("a"), new Spacer(1), tool("b")]) chat.addChild(child as any);
		assert.match(strip(chat.render(80).join("\n")), /2 successful tools/);
	} finally { grouping.setEnabled(false); }
});

test("the collapsed header says what happened, not just how many", () => {
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const a = tool("a"), b = tool("b"), c = tool("c");
		(a as any).rendererState[OBSERVED] = "Tests 228 passed 0 failed";
		const chat = new Container();
		for (const child of [a, b, c]) chat.addChild(child as any);
		const header = strip(chat.render(100)[0]!);
		assert.match(header, /3 successful tools/);
		assert.match(header, /Tests 228 passed 0 failed/);
		assert.match(header, /Bash ×2/);
		assert.ok(strip(chat.render(30)[0]!).length <= 30, "narrow widths truncate");
	} finally { grouping.setEnabled(false); }
});

test("a stale patch left by an older version after /reload is replaced, not trusted", () => {
	const LEGACY = Symbol.for("pi-config.compact-tools.grouping");
	const V2 = Symbol.for("pi-config.compact-tools.grouping.v2");
	const proto = Container.prototype as any;
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const original = proto[V2].original;
		let staleCalls = 0;
		proto.render = function (this: any, width: number) { staleCalls++; return original.call(this, width); };
		proto[LEGACY] = { enabled: true, originalRender: original }; // what an earlier version stored, with no activeToolCallIds
		const reloaded = installToolGrouping();
		reloaded.setEnabled(true);
		assert.equal(proto[LEGACY], undefined, "the legacy marker is cleared");
		const chat = new Container();
		for (const child of [tool("a"), tool("b")]) chat.addChild(child as any);
		assert.match(strip(chat.render(80).join("\n")), /2 successful tools/);
		assert.equal(staleCalls, 0, "the old wrapper is no longer in the render path");
		proto[LEGACY] = { parents: new Set() }; // the very first version only tracked parents and never patched render
		installToolGrouping();
		assert.equal(proto[LEGACY], undefined);
		assert.match(strip(chat.render(80).join("\n")), /2 successful tools/);
	} finally { grouping.setEnabled(false); }
});

test("turning groups off really shows every row again", () => {
	const grouping = installToolGrouping();
	const chat = new Container();
	for (const child of [tool("a"), thinkingOnly(), tool("b")]) chat.addChild(child as any);
	grouping.setEnabled(true);
	assert.match(strip(chat.render(80).join("\n")), /2 successful tools/);
	grouping.setEnabled(false);
	const off = strip(chat.render(80).join("\n"));
	assert.ok(!off.includes("successful tools"));
	assert.match(off, /echo a[\s\S]*thinking[\s\S]*echo b/);
});

test("a thinking row right before the first tool folds into the group too", () => {
	const grouping = installToolGrouping();
	try {
		grouping.setEnabled(true);
		const chat = new Container();
		for (const child of [withText("Let me check."), thinkingOnly(), tool("a"), thinkingOnly(), tool("b")]) chat.addChild(child as any);
		const collapsed = strip(chat.render(80).join("\n"));
		assert.ok(collapsed.includes("Let me check."));
		assert.match(collapsed, /2 successful tools/);
		assert.ok(!collapsed.includes("thinking"), "no stray thinking row above the group");
	} finally { grouping.setEnabled(false); }
});
