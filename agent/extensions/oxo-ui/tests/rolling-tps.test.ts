import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { tmpdir } from "node:os";
import oxoExtension from "../index.ts";

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const handlers = new Map<string, any>();
  let footer: any;
  const branch: any[] = [];
  const pi = {
    on: (event: string, handler: any) => { handlers.set(event, handler); return () => {}; },
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    appendEntry: () => { throw new Error("TPS must not be persisted"); },
    sendMessage: () => { throw new Error("TPS must not change conversation context"); },
  } as any;
  const ctx = {
    hasUI: true, cwd: tmpdir(), model: { id: "test" },
    getContextUsage: () => undefined,
    sessionManager: { getBranch: () => branch },
    ui: {
      setEditorComponent: () => {},
      setFooter: (factory: any) => {
        footer?.dispose();
        footer = factory?.({ requestRender: () => {} }, {}, {
          onBranchChange: () => () => {}, getGitBranch: () => undefined, getExtensionStatuses: () => new Map(),
        });
      },
    },
  } as any;
  const register = () => { oxoExtension(pi); handlers.get("session_start")({}, ctx); };
  register();
  const emit = (event: string, payload: any = {}) => handlers.get(event)?.(payload, ctx);
  const text = () => footer.render(300).join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const rate = () => {
    const match = /([\d.]+) (?:avg )?t\/s/.exec(text());
    assert.ok(match, "footer should display a numeric TPS segment");
    return Number(match[1]);
  };
  const delta = (type = "text_delta") => emit("message_update", { assistantMessageEvent: { type, delta: "x".repeat(400) } });
  const end = (output: number, stopReason = "stop", role = "assistant") => emit("message_end", { message: {
    role, stopReason,
    usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }});
  const response = (output: number, milliseconds = 1000, stopReason = "stop") => {
    emit("message_start", { message: { role: "assistant" } });
    delta();
    t.mock.timers.tick(milliseconds);
    end(output, stopReason);
  };
  return { emit, text, rate, delta, end, response, register, branch };
}

test("first response initializes TPS; later responses blend into the one previous number", t => {
  const f = fixture(t);
  f.response(100);
  assert.equal(f.rate(), 100);
  f.response(20);
  assert.equal(f.rate(), 60);
  f.response(40);
  assert.equal(f.rate(), 50);
  assert.deepEqual(f.branch, []);
});

test("footer identifies the metric as an average", t => {
  const f = fixture(t);
  assert.match(f.text(), /0 avg t\/s/);
});

test("streaming leaves the previous completed average unchanged", t => {
  const f = fixture(t);
  f.response(40);
  f.emit("agent_start");
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta();
  t.mock.timers.tick(1000);
  f.delta();
  assert.equal(f.rate(), 40);
  t.mock.timers.tick(1000);
  f.end(40);
  assert.equal(f.rate(), 30); // blend 40 with the new 20 t/s response
});

test("average stays visible through idle time and the next agent start", t => {
  const f = fixture(t);
  f.response(80);
  f.emit("agent_end");
  t.mock.timers.tick(30000);
  assert.equal(f.rate(), 80);
  f.emit("agent_start");
  assert.equal(f.rate(), 80);
});

test("tool time and pre-token waiting are excluded from the next response's rate", t => {
  const f = fixture(t);
  f.response(100);
  t.mock.timers.tick(60000);
  f.emit("message_start", { message: { role: "assistant" } });
  t.mock.timers.tick(5000);
  f.delta("thinking_delta");
  t.mock.timers.tick(1000);
  f.end(20, "toolUse");
  assert.equal(f.rate(), 60);
});

test("errored and aborted responses do not change the average", t => {
  const f = fixture(t);
  f.response(100);
  f.response(20, 1000, "error");
  assert.equal(f.rate(), 100);
  f.response(40, 1000, "aborted");
  assert.equal(f.rate(), 100);
});

test("zero/non-finite output and sub-0.3-second responses are ignored", t => {
  const f = fixture(t);
  f.response(100);
  f.response(0);
  f.response(20, 100);
  f.response(Number.NaN);
  f.response(Number.POSITIVE_INFINITY);
  assert.equal(f.rate(), 100);
  assert.doesNotMatch(f.text(), /NaN|Infinity/);
});

test("a message without streamed deltas cannot reuse another response's start time", t => {
  const f = fixture(t);
  f.response(100);
  f.emit("message_start", { message: { role: "assistant" } });
  t.mock.timers.tick(1000);
  f.end(20);
  assert.equal(f.rate(), 100);
});

test("user messages cannot change TPS or reset an assistant's pending timing", t => {
  const f = fixture(t);
  f.response(100);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta();
  t.mock.timers.tick(500);
  f.emit("message_start", { message: { role: "user" } });
  f.end(10, "stop", "user");
  t.mock.timers.tick(500);
  f.end(20);
  assert.equal(f.rate(), 60);
});

test("session start clears the average and any pending response timestamp", t => {
  const f = fixture(t);
  f.response(100);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta();
  t.mock.timers.tick(1000);
  f.emit("session_start");
  assert.equal(f.rate(), 0);
  f.end(20);
  assert.equal(f.rate(), 0);
  f.response(40);
  assert.equal(f.rate(), 40);
});

test("reloading extension state begins a fresh in-memory average", t => {
  const f = fixture(t);
  f.response(100);
  f.register();
  assert.equal(f.rate(), 0);
  f.response(20);
  assert.equal(f.rate(), 20);
});

test("fractional TPS keeps existing low-rate decimal formatting", t => {
  const f = fixture(t);
  f.response(5, 2000);
  assert.equal(f.rate(), 2.5);
  f.response(3, 2000);
  assert.equal(f.rate(), 2);
});
