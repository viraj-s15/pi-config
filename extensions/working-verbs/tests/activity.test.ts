import assert from "node:assert/strict";
import { test } from "node:test";
import { createActivity, describeTool, formatElapsed } from "../activity.ts";
import workingVerbs from "../index.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the activity follows the agent: waiting, thinking, writing, preparing a tool, running it", () => {
	const a = createActivity("/home/me/proj");
	a.start();
	assert.equal(a.label(), "Waiting for the model");
	a.delta("thinking_delta", "plan");
	assert.equal(a.label(), "Thinking");
	a.delta("text_delta", "x".repeat(40));
	assert.equal(a.label(), "Writing the answer");
	a.delta("toolcall_start", "", "edit");
	assert.equal(a.label(), "Preparing an edit");
	a.toolStart("t1", "bash", { command: "rg -n foo src | head" });
	assert.equal(a.label(), "Running rg -n foo src | head");
	a.toolEnd("t1");
	assert.equal(a.label(), "Waiting for the model");
	a.delta("thinking_delta", "more");
	a.replyStart();
	assert.equal(a.label(), "Waiting for the model", "a new reply starts by waiting again");
});

test("parallel tools are counted, and the label returns to the one still running", () => {
	const a = createActivity("/p");
	a.start();
	a.toolStart("a", "read", { path: "/p/README.md" });
	a.toolStart("b", "grep", { pattern: "TODO" });
	a.toolStart("c", "bash", { command: "ls" });
	assert.equal(a.label(), "Running 3 tools");
	a.toolEnd("a");
	a.toolEnd("c");
	assert.equal(a.label(), 'Searching for "TODO"');
});

test("tools are described by what they do", () => {
	const cwd = "/Users/me/proj";
	assert.equal(describeTool("read", { path: "/Users/me/proj/src/a.ts" }, cwd), "Reading src/a.ts");
	assert.equal(describeTool("edit", { path: "README.md" }, cwd), "Editing README.md");
	assert.equal(describeTool("write", { path: "/tmp/x.txt" }, cwd), "Writing /tmp/x.txt");
	assert.equal(describeTool("bash", { command: "cd src &&\n  npm test" }, cwd), "Running cd src && npm test", "one line");
	assert.equal(describeTool("bash", { command: "x".repeat(200) }, cwd).length, 68, "long commands are cut to 60 characters");
	assert.equal(describeTool("web_search", { query: "pi agent" }, cwd), 'Searching the web for "pi agent"');
	assert.equal(describeTool("ask_user", {}, cwd), "Waiting for your answer");
	assert.equal(describeTool("todo", { action: "update" }, cwd), "Updating todos");
	assert.equal(describeTool("some_tool", {}, cwd), "Running some tool");
});

test("elapsed time reads in seconds, then minutes", () => {
	assert.equal(formatElapsed(14_900), "14s");
	assert.equal(formatElapsed(64_000), "1m 04s");
});

test("the working line is the verb, the run's time, then what is happening", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const handlers = new Map<string, any>();
	const messages: Array<string | undefined> = [];
	const pi = { on: (name: string, cb: any) => handlers.set(name, cb), registerCommand() {} } as any;
	const ctx = { hasUI: true, cwd: "/p", ui: { setWorkingMessage: (m?: string) => messages.push(m), setWorkingIndicator() {} } } as any;
	workingVerbs(pi);
	handlers.get("session_start")({}, ctx);
	handlers.get("agent_start")({}, ctx);
	assert.match(plain(messages.at(-1)!), /^[A-Z][a-z-]+… \(0s\) · Waiting for the model$/);
	handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
	handlers.get("message_update")({ assistantMessageEvent: { type: "thinking_delta", delta: "hm" } }, ctx);
	assert.match(plain(messages.at(-1)!), / · Thinking$/, "a new step shows at once");
	t.mock.timers.tick(64_000);
	assert.match(plain(messages.at(-1)!), /… \(1m 04s\) · Thinking$/);
	handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "read", args: { path: "/p/a.ts" } }, ctx);
	assert.match(plain(messages.at(-1)!), / · Reading a\.ts$/);
	handlers.get("agent_end")({}, ctx);
	assert.equal(messages.at(-1), undefined, "Pi's default message is restored");
	const count = messages.length;
	t.mock.timers.tick(5_000);
	assert.equal(messages.length, count, "no more updates after the agent ends");
});
