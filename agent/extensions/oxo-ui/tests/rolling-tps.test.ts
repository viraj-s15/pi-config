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
  const delta = (type = "text_delta", text = "x".repeat(400)) => emit("message_update", { assistantMessageEvent: { type, delta: text } });
  const end = (output: number, stopReason = "stop", role = "assistant", reasoning?: number) => emit("message_end", { message: {
    role, stopReason, content: [{ type: "text", text: "answer" }],
    usage: { input: 0, output, reasoning, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }});
  const response = (output: number, milliseconds = 1000, stopReason = "stop", reasoning?: number) => {
    emit("message_start", { message: { role: "assistant" } });
    delta();
    t.mock.timers.tick(milliseconds);
    end(output, stopReason, "assistant", reasoning);
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
  f.delta();
  t.mock.timers.tick(1000);
  f.end(20);
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

test("hidden reasoning is subtracted before computing and blending answer TPS", t => {
  const f = fixture(t);
  // 200 answer tokens over 5 seconds = 40 TPS, not 84 total-output TPS.
  f.response(420, 5000, "stop", 220);
  assert.equal(f.rate(), 40);
  // 20 answer tokens over 1 second blends with the previous 40 to give 30.
  f.response(400, 1000, "stop", 380);
  assert.equal(f.rate(), 30);
});

test("the observed 392-output/217-reasoning reply is sampled as 175 answer tokens", t => {
  const f = fixture(t);
  f.response(392, 5000, "stop", 217);
  assert.equal(f.rate(), 35);
});

test("reasoning and tool-argument deltas cannot start the answer-text clock", t => {
  const f = fixture(t);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta("thinking_delta");
  t.mock.timers.tick(10000);
  f.delta("toolcall_delta");
  t.mock.timers.tick(10000);
  f.delta();
  t.mock.timers.tick(1000);
  f.end(420, "stop", "assistant", 380);
  assert.equal(f.rate(), 40);
});

test("an empty text delta cannot start timing before answer text is delivered", t => {
  const f = fixture(t);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta("text_delta", "");
  t.mock.timers.tick(10000);
  f.delta();
  t.mock.timers.tick(1000);
  f.end(40);
  assert.equal(f.rate(), 40);
});

test("tool-call responses with commentary do not pollute the answer average", t => {
  const f = fixture(t);
  f.response(40);
  f.response(500, 1000, "toolUse", 100);
  assert.equal(f.rate(), 40);
  f.response(20);
  assert.equal(f.rate(), 30);
});

test("tool-call-only and reasoning-only bursts cannot initialize the average", t => {
  const f = fixture(t);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta("toolcall_delta");
  t.mock.timers.tick(1000);
  f.end(500, "toolUse");
  assert.equal(f.rate(), 0);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta("thinking_delta");
  t.mock.timers.tick(1000);
  f.end(500, "stop", "assistant", 500);
  assert.equal(f.rate(), 0);
});

test("a tool call in finalized content excludes that message even with stop reason stop", t => {
  const f = fixture(t);
  f.response(40);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta();
  t.mock.timers.tick(1000);
  f.emit("message_end", { message: {
    role: "assistant", stopReason: "stop", content: [{ type: "text", text: "commentary" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "file" } }],
    usage: { input: 0, output: 500, reasoning: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }});
  assert.equal(f.rate(), 40);
});

test("invalid reasoning breakdowns do not create inflated or negative samples", t => {
  const f = fixture(t);
  f.response(40);
  for (const reasoning of [-20, 101, Number.NaN, Number.POSITIVE_INFINITY, 100]) {
    f.response(100, 1000, "stop", reasoning);
    assert.equal(f.rate(), 40);
  }
});

test("reported reasoning is excluded from truncated final answers too", t => {
  const f = fixture(t);
  f.response(420, 1000, "length", 380);
  assert.equal(f.rate(), 40);
});

test("thinking without a reported token breakdown is skipped rather than counted as answer tokens", t => {
  const f = fixture(t);
  f.response(40);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta();
  t.mock.timers.tick(1000);
  f.emit("message_end", { message: {
    role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "answer" }],
    usage: { input: 0, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }});
  assert.equal(f.rate(), 40);
});

test("fractional TPS keeps existing low-rate decimal formatting", t => {
  const f = fixture(t);
  f.response(5, 2000);
  assert.equal(f.rate(), 2.5);
  f.response(3, 2000);
  assert.equal(f.rate(), 2);
});
