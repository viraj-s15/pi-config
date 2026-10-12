import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getHub, type LiveAgent } from "../hub.ts";
import { HubView } from "../hub-view.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

function fresh() {
	const hub = getHub();
	hub.clear();
	return hub;
}

test("the hub tracks each subagent's current step from its event stream", () => {
	const hub = fresh();
	const agent = hub.add({ label: "auth-reviewer", task: "Review auth", model: "openai/gpt-6-luna", cwd: "/p", messages: [], usage: usage() });
	assert.equal(agent.status, "running");
	assert.equal(hub.activity(agent), "Waiting for the model");
	hub.event(agent, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
	assert.equal(hub.activity(agent), "Thinking");
	hub.event(agent, { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "rg -n auth src" } });
	assert.equal(hub.activity(agent), "Running rg -n auth src");
	hub.event(agent, { type: "tool_execution_end", toolCallId: "1" });
	hub.finish(agent, "done");
	assert.equal(agent.status, "done");
	assert.ok(agent.endedAt);
});

test("stopping a subagent calls its stop hook and marks it stopped; listeners hear every change", () => {
	const hub = fresh();
	let changes = 0;
	const off = hub.subscribe(() => changes++);
	const agent = hub.add({ label: "a", task: "t", model: "m", cwd: "/p", messages: [], usage: usage() });
	let stopped = 0;
	agent.stop = () => stopped++;
	hub.stop(agent);
	assert.equal(stopped, 1);
	assert.equal(agent.status, "stopped");
	hub.finish(agent, "failed");
	assert.equal(agent.status, "stopped", "a stop is not overwritten by the exit that follows");
	assert.ok(changes >= 2);
	off();
});

test("the list shows running subagents first, newest first, and keeps only recent finished ones", () => {
	const hub = fresh();
	const old = hub.add({ label: "old", task: "t", model: "m", cwd: "/p", messages: [], usage: usage() });
	hub.finish(old, "done");
	hub.add({ label: "live", task: "t", model: "m", cwd: "/p", messages: [], usage: usage() });
	assert.deepEqual(hub.list().map((a) => a.label), ["live", "old"]);
	for (let i = 0; i < 40; i++) hub.finish(hub.add({ label: `x${i}`, task: "t", model: "m", cwd: "/p", messages: [], usage: usage() }), "done");
	assert.ok(hub.list().length <= 21);
	assert.equal(hub.list()[0]!.label, "live", "running ones are never dropped");
});

function scenario() {
	const hub = fresh();
	const done = hub.add({ label: "docs-writer", task: "Write the docs", model: "anthropic/claude", cwd: "/p", messages: [{ role: "assistant", content: [{ type: "text", text: "All written." }] } as any], usage: { ...usage(), input: 12_000, output: 800, cost: 0.042 } });
	hub.finish(done, "done");
	const live: LiveAgent = hub.add({
		label: "auth-reviewer", task: "Review the auth module for token handling bugs", model: "openai/gpt-6-luna", cwd: "/p",
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Looking at the auth code." }, { type: "toolCall", id: "1", name: "read", arguments: { path: "/p/src/auth.ts" } }] },
			{ role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "export function login() {}\nline 2\nline 3" }], isError: false },
		] as any,
		usage: usage(),
	});
	hub.event(live, { type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "npm test" } });
	return { hub, live, done };
}

test("the list fits its width and says what each one is doing", () => {
	const { hub } = scenario();
	const view = new HubView(hub, () => {}, () => 40);
	for (const width of [50, 90]) {
		const lines = view.render(width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `fits ${width}: ${plain(line)}`);
	}
	const text = plain(view.render(100).join("\n"));
	assert.match(text, /Subagents/);
	assert.match(text, /auth-reviewer.*Running npm test/);
	assert.match(text, /docs-writer.*done.*\$0\.04/);
});

test("enter opens a transcript; x stops the selected one; esc goes back, then closes", () => {
	const { hub, live } = scenario();
	let closed = 0;
	let stopped = 0;
	live.stop = () => stopped++;
	const view = new HubView(hub, () => closed++, () => 40);
	view.handleInput("\r");
	const detail = plain(view.render(90).join("\n"));
	assert.match(detail, /auth-reviewer · openai\/gpt-6-luna · running/);
	assert.match(detail, /Review the auth module/);
	assert.match(detail, /Looking at the auth code\./);
	assert.match(detail, /→ Reading src\/auth\.ts/);
	assert.match(detail, /export function login\(\) \{\}/);
	assert.match(detail, /Running npm test/);
	view.handleInput("x");
	assert.equal(stopped, 1);
	view.handleInput("\x1b");
	assert.match(plain(view.render(90).join("\n")), /↑↓ select/);
	assert.equal(closed, 0);
	view.handleInput("\x1b");
	assert.equal(closed, 1);
});

test("a long transcript shows its end and scrolls up", () => {
	const hub = fresh();
	const messages = Array.from({ length: 60 }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `line ${i}` }] }));
	hub.add({ label: "long", task: "t", model: "m", cwd: "/p", messages: messages as any, usage: usage() });
	const view = new HubView(hub, () => {}, () => 20);
	view.handleInput("\r");
	let text = plain(view.render(80).join("\n"));
	assert.ok(view.render(80).length <= 20);
	assert.match(text, /line 59/);
	assert.doesNotMatch(text, /line 0\b/);
	for (let i = 0; i < 10; i++) view.handleInput("\x1b[5~"); // page up
	text = plain(view.render(80).join("\n"));
	assert.match(text, /line 0\b/);
});

test("the subagent tool feeds the hub, and stopping one from the hub ends just that subagent", { timeout: 15_000 }, async () => {
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const subagentExtension = ((await import("../index.ts")) as any).default as (pi: any) => void;
	const dir = mkdtempSync(join(tmpdir(), "hub-fake-pi-"));
	const fake = join(dir, "fake-pi.mjs");
	// Stands in for `pi --mode json`: says it is running a command, then waits to be stopped.
	writeFileSync(fake, `
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
out({ type: "message_start", message: { role: "assistant" } });
out({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "sleep 30" } });
setTimeout(() => {}, 30000);
`);
	const argv1 = process.argv[1];
	process.argv[1] = fake;
	const hub = fresh();
	try {
		let tool: any;
		subagentExtension({ events: { emit() {} }, registerTool: (t: any) => (tool = t), registerCommand() {}, registerShortcut() {} } as any);
		const running = tool.execute("call", { task: "look around", name: "scout" }, undefined, undefined, { cwd: dir });
		const agent = await new Promise<LiveAgent>((resolve) => {
			const off = hub.subscribe(() => {
				const a = hub.list()[0];
				if (a && hub.activity(a) === "Running sleep 30") { off(); resolve(a); }
			});
		});
		assert.equal(agent.label, "scout");
		const stoppedAt = Date.now();
		hub.stop(agent);
		const result = await running;
		assert.ok(Date.now() - stoppedAt < 3000, "it stops at once, not after the SIGKILL fallback");
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Stopped by the user from the subagent hub/);
		assert.equal(agent.status, "stopped");
		assert.ok(agent.endedAt);
	} finally {
		process.argv[1] = argv1!;
		rmSync(dir, { recursive: true, force: true });
	}
});
