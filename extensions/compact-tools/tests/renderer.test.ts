import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";

test("compact renderer renders test summaries, full commands, and honest failures", () => {
	let resolver: any;
	const commands: Record<string, any> = {};
	extension({ registerToolRenderer(fn: any) { resolver = fn; }, registerCommand(name: string, command: any) { commands[name] = command; }, on() {} } as any);
	const renderer = resolver("bash", () => undefined);
	const args = { command: "node tests/run.mjs" };
	const context = { outputPad: 1, isError: false, isPartial: false, args, durationMs: 1200, state: {} as Record<PropertyKey, unknown> };
	assert.match(renderer.renderCall(args, {}, context).render(80).join(""), /Tests/);
	const call = renderer.renderCall(args, {}, context);
	const summary = renderer.renderResult({ content: [{ type: "text", text: "ℹ tests 176\nℹ pass 176\nℹ fail 0" }] }, { expanded: false }, {}, context);
	assert.deepEqual(summary.render(80), [], "successful test counts are folded into the operation row");
	assert.match(call.render(80).join(""), /176 passed · 0 failed/);
	const expandedCommand = renderer.renderCall({ command: "node tests/run.mjs --runInBand --reporter=verbose" }, {}, { ...context, expanded: true });
	assert.ok(expandedCommand.render(12).join("\n").includes("--reporter"), "expanded command wraps instead of truncating");
	const expandedOutput = renderer.renderResult({ content: [{ type: "text", text: "first long line that wraps\nsecond" }] }, { expanded: true }, {}, context);
	assert.ok(expandedOutput.render(12).length > 2, "expanded output keeps wrapped full lines");
	const narrow = renderer.renderCall(args, {}, context).render(12).join("");
	assert.ok(narrow.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length <= 12);
	const wideArgs = { command: "printf '界'" };
	const wide = renderer.renderCall(wideArgs, {}, { ...context, args: wideArgs }).render(20)[0]!;
	assert.ok(visibleWidth(wide) <= 20, "ANSI styling and wide characters fit the requested terminal width");
	const failure = renderer.renderResult({ content: [{ type: "text", text: "ℹ tests 176\nℹ pass 176\nℹ fail 0\nCommand exited with code 1" }] }, { expanded: false }, {}, { ...context, isError: true, args });
	assert.match(failure.render(80).join(""), /Tests failed \(exit code 1\)/, "non-zero exit overrides contradictory pass counts");
	assert.match(failure.render(80).join(""), /38;2;250;77;86/, "actual tool errors use error styling");
	assert.ok(commands.toolgroups && commands.bullets);
});

test("successful observed result updates the shared call row without a duplicate result row", () => {
	let resolver: any;
	extension({ registerToolRenderer(fn: any) { resolver = fn; }, registerCommand() {}, on() {} } as any);
	const renderer = resolver("read", () => undefined);
	const state: Record<string, unknown> = {};
	const args = { path: "src/file.ts" };
	const context = { outputPad: 1, isError: false, isPartial: false, args, state };
	const call = renderer.renderCall(args, {}, context);
	assert.match(call.render(80).join("").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), /Read\(src\/file.ts\)/);
	const result = renderer.renderResult({ content: [{ type: "text", text: "one\ntwo\nthree" }] }, { expanded: false }, {}, context);
	assert.deepEqual(result.render(80), [], "successful result is folded into the operation row");
	assert.match(call.render(80).join(""), /3 lines/);
});

test("non-bash successful results summarize observed writes and searches", () => {
	let resolver: any;
	extension({ registerToolRenderer(fn: any) { resolver = fn; }, registerCommand() {}, on() {} } as any);
	for (const [tool, args, text, expected] of [
		["write", { path: "out.txt", content: "twelve chars" }, "Successfully wrote to out.txt", /12 bytes/],
		["grep", { pattern: "x" }, "a.ts:1: x\na.ts:2: x", /2 matches/],
	] as const) {
		const renderer = resolver(tool, () => undefined);
		const state: Record<string, unknown> = {};
		const context = { outputPad: 1, isError: false, isPartial: false, args, state };
		const call = renderer.renderCall(args, {}, context);
		renderer.renderResult({ content: [{ type: "text", text }] }, { expanded: false }, {}, context).render(80);
		assert.match(call.render(80).join(""), expected);
	}
});

test("extension reload does not stack renderer instrumentation", async () => {
	const { Container } = await import("@earendil-works/pi-tui");
	const render = (Container.prototype as any).render;
	extension({ registerToolRenderer() {}, registerCommand() {}, on() {} } as any);
	assert.equal((Container.prototype as any).render, render);
});

const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
function rowFor(tool: string, args: Record<string, any>, text: string, isError = false) {
	let resolver: any;
	extension({ registerToolRenderer(fn: any) { resolver = fn; }, registerCommand() {}, on() {} } as any);
	const renderer = resolver(tool, () => undefined);
	const context = { outputPad: 1, isError: false, isPartial: false, args, state: {} as Record<PropertyKey, unknown> };
	const call = renderer.renderCall(args, {}, context);
	const result = renderer.renderResult({ content: [{ type: "text", text }] }, { expanded: false }, {}, { ...context, isError });
	return { call: plain(call.render(100).join("\n")), result: plain(result.render(100).join("\n")) };
}

test("a recognized command is named once, with its observed result, not repeated", () => {
	const tests = rowFor("bash", { command: "node tests/run.mjs > /tmp/x.log 2>&1; tail -9 /tmp/x.log" }, "ℹ tests 228\nℹ pass 228\nℹ fail 0");
	assert.equal(tests.call.trim(), "● Tests(228 passed · 0 failed)");
	const commit = rowFor("bash", { command: "git commit -m x" }, "[main abc1234] x\n 2 files changed, 4 insertions(+)");
	assert.equal(commit.call.trim(), "● Git commit(abc1234 · 2 files)");
	assert.equal(commit.result, "");
	const push = rowFor("bash", { command: "git push origin main" }, "To github.com:o/r.git\n   a1..b2  main -> main");
	assert.equal(push.call.trim(), "● Git push(github.com:o/r.git · main -> main)");
});

test("unrecognized shell keeps its raw preview and gets no invented result", () => {
	const row = rowFor("bash", { command: "ls -la src" }, "total 8");
	assert.equal(row.call.trim(), "● Bash(ls -la src)");
	assert.equal(row.result, "");
});
