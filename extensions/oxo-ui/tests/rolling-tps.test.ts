import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { tmpdir } from "node:os";
import oxoExtension from "../index.ts";

const SHARED_TPS = Symbol.for("pi-config.oxo-ui.rolling-tps");

function fixture(t: TestContext) {
  delete (globalThis as any)[SHARED_TPS]; // reloads share state in memory; tests must not
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const handlers = new Map<string, any>();
  let footer: any;
  let branchChanged: (() => void) | undefined;
  let branchScans = 0;
  let leafId: string | null = "leaf-1";
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
    sessionManager: {
      getBranch: () => { branchScans++; return branch; },
      getLeafId: () => leafId,
    },
    ui: {
      setEditorComponent: () => {},
      setFooter: (factory: any) => {
        footer?.dispose();
        footer = factory?.({ requestRender: () => {} }, {}, {
          onBranchChange: (callback: () => void) => { branchChanged = callback; return () => {}; },
          getGitBranch: () => undefined, getExtensionStatuses: () => new Map(),
        });
      },
    },
  } as any;
  const register = (reason?: string) => { oxoExtension(pi); handlers.get("session_start")({ reason }, ctx); };
  register();
  const emit = (event: string, payload: any = {}) => handlers.get(event)?.(payload, ctx);
  const shows = () => /([\d.]+|–) avg t\/s/.exec(text())?.[1];
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
  /** Text arriving steadily: a delta every milliseconds/steps, the last one exactly milliseconds from now. */
  const stream = (milliseconds: number, steps = 10) => {
    for (let i = 0; i < steps; i++) {
      t.mock.timers.tick(milliseconds / steps);
      delta();
    }
  };
  const response = (output: number, milliseconds = 1000, stopReason = "stop", reasoning?: number) => {
    emit("message_start", { message: { role: "assistant" } });
    delta();
    stream(milliseconds);
    end(output, stopReason, "assistant", reasoning);
  };
  return {
    emit, text, shows, rate, delta, stream, end, response, register, branch,
    branchScans: () => branchScans,
    navigate: (nextLeafId: string) => { leafId = nextLeafId; emit("session_tree"); },
    changeGitBranch: () => branchChanged?.(),
  };
}

test("turn_end and agent_end share one branch stats scan", t => {
  const f = fixture(t);
  assert.equal(f.branchScans(), 1, "session installation initializes branch stats");
  f.emit("turn_end");
  f.emit("agent_end");
  assert.equal(f.branchScans(), 1, "the same branch leaf should not be scanned twice");
});

test("session navigation refreshes branch stats when the leaf changes", t => {
  const f = fixture(t);
  f.branch.push({ type: "message", message: {
    role: "assistant", stopReason: "error", content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.125 } },
  }});
  f.navigate("leaf-2");
  assert.equal(f.branchScans(), 2);
  assert.match(f.text(), /\$0\.125/);
  assert.match(f.text(), /✘/);
  f.emit("turn_end");
  f.emit("agent_end");
  assert.equal(f.branchScans(), 2);
});

test("git-branch notifications do not invalidate unchanged conversation stats", t => {
  const f = fixture(t);
  f.changeGitBranch();
  assert.equal(f.branchScans(), 1);
});

test("a completed answer refreshes stats once, without another scan at agent_end", t => {
  const f = fixture(t);
  f.response(40);
  f.branch.push({ type: "message", message: {
    role: "assistant", stopReason: "stop", content: [],
    usage: { input: 10, output: 40, cacheRead: 90, cacheWrite: 0, cost: { total: 0.25 } },
  }});
  f.emit("turn_end");
  assert.equal(f.branchScans(), 2);
  assert.match(f.text(), /90%.*cache/);
  assert.match(f.text(), /\$0\.250/);
  f.emit("agent_end");
  assert.equal(f.branchScans(), 2);
});

test("first response initializes TPS; later responses blend into the one previous number", t => {
  const f = fixture(t);
  f.response(400, 2000);
  assert.equal(f.rate(), 200);
  f.response(200, 2000);
  assert.equal(f.rate(), 150);
  f.response(300, 2000);
  assert.equal(f.rate(), 150);
  assert.deepEqual(f.branch, []);
});

test("footer identifies the metric as an average", t => {
  const f = fixture(t);
  assert.match(f.text(), /– avg t\/s/);
});

test("the clock runs from the start of the reply to its end, so thinking and tool arguments count", t => {
  const f = fixture(t);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta("thinking_delta");
  t.mock.timers.tick(4000);
  f.delta();
  t.mock.timers.tick(1000);
  f.end(1000, "stop", "assistant", 600);
  assert.equal(f.rate(), 200, "1000 output tokens over the 5 s reply, not 400 answer tokens over the last second");
});

test("an answer that arrives in one burst after silent thinking is measured over the whole reply", t => {
  const f = fixture(t);
  // The 467 t/s case: Opus thinks for ~20 s, then the answer text lands within a second or two.
  f.emit("message_start", { message: { role: "assistant" } });
  t.mock.timers.tick(20000);
  for (let i = 0; i < 73; i++) f.delta();
  f.end(2046, "stop", "assistant", 1193);
  assert.equal(f.rate(), 102);
});

test("tool-call replies are samples too", t => {
  const f = fixture(t);
  f.emit("message_start", { message: { role: "assistant" } });
  f.delta("toolcall_delta");
  t.mock.timers.tick(2000);
  f.emit("message_end", { message: {
    role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "write", arguments: {} }],
    usage: { input: 0, output: 400, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  }});
  assert.equal(f.rate(), 200);
});

test("streaming leaves the previous completed average unchanged", t => {
  const f = fixture(t);
  f.response(400, 2000);
  f.emit("agent_start");
  f.emit("message_start", { message: { role: "assistant" } });
  f.stream(3000);
  assert.equal(f.rate(), 200);
  f.stream(1000);
  f.end(400);
  assert.equal(f.rate(), 150, "blend 200 with the new 100 t/s reply");
});

test("average stays visible through idle time and the next agent start", t => {
  const f = fixture(t);
  f.response(400, 2000);
  f.emit("agent_end");
  t.mock.timers.tick(30000);
  assert.equal(f.rate(), 200);
  f.emit("agent_start");
  assert.equal(f.rate(), 200);
});

test("time between replies (tools running, the user typing) is not part of any reply", t => {
  const f = fixture(t);
  f.response(400, 2000);
  t.mock.timers.tick(60000);
  f.response(400, 4000);
  assert.equal(f.rate(), 150);
});

test("errored and aborted replies do not change the average", t => {
  const f = fixture(t);
  f.response(400, 2000);
  f.response(400, 4000, "error");
  assert.equal(f.rate(), 200);
  f.response(400, 4000, "aborted");
  assert.equal(f.rate(), 200);
});

test("small replies, sub-second replies and broken usage are ignored", t => {
  const f = fixture(t);
  f.response(400, 2000);
  f.response(199, 4000); // startup time would dominate the rate
  f.response(400, 999);
  f.response(0, 2000);
  f.response(Number.NaN, 2000);
  f.response(Number.POSITIVE_INFINITY, 2000);
  assert.equal(f.rate(), 200);
  assert.doesNotMatch(f.text(), /NaN|Infinity/);
});

test("a reply needs its own start: a stray message_end cannot reuse an earlier one", t => {
  const f = fixture(t);
  f.response(400, 2000);
  t.mock.timers.tick(10000);
  f.end(4000);
  assert.equal(f.rate(), 200);
});

test("user messages cannot change TPS or reset an assistant's pending timing", t => {
  const f = fixture(t);
  f.emit("message_start", { message: { role: "assistant" } });
  t.mock.timers.tick(1000);
  f.emit("message_start", { message: { role: "user" } });
  f.end(10, "stop", "user");
  t.mock.timers.tick(1000);
  f.end(400);
  assert.equal(f.rate(), 200);
});

test("a new session clears the average and any pending reply", t => {
  const f = fixture(t);
  f.response(400, 2000);
  f.emit("message_start", { message: { role: "assistant" } });
  t.mock.timers.tick(2000);
  f.emit("session_start", { reason: "new" });
  assert.equal(f.shows(), "–");
  f.end(400);
  assert.equal(f.shows(), "–");
  f.response(300, 2000);
  assert.equal(f.rate(), 150);
});

test("with no completed reply yet the footer shows a dash, not a zero", t => {
  const f = fixture(t);
  assert.equal(f.shows(), "–");
});

test("reloading keeps this session's average, so /reload does not blank the footer", t => {
  const f = fixture(t);
  f.response(400, 2000);
  f.response(240, 2000);
  assert.equal(f.rate(), 160);
  f.register("reload");
  assert.equal(f.rate(), 160, "average survives the reload");
  f.response(400, 10000);
  assert.equal(f.rate(), 100, "and keeps blending afterwards");
});

test("resuming, forking, a new session and a fresh start all begin without an average", t => {
  const f = fixture(t);
  for (const reason of ["resume", "fork", "new", "startup", undefined]) {
    f.response(400, 2000);
    assert.equal(f.rate(), 200);
    f.register(reason);
    assert.equal(f.shows(), "–", `reason ${reason}`);
  }
});

test("a reload still resets an average that a session change already cleared", t => {
  const f = fixture(t);
  f.response(400, 2000);
  f.emit("session_start", { reason: "new" });
  f.register("reload");
  assert.equal(f.shows(), "–");
});

test("the carried-over average is memory only", t => {
  const f = fixture(t);
  f.response(400, 2000);
  assert.equal(typeof (globalThis as any)[SHARED_TPS], "number");
  assert.doesNotThrow(() => f.register("reload"), "appendEntry/sendMessage would throw in this fixture");
});

test("low rates keep one decimal", t => {
  const f = fixture(t);
  f.response(200, 80000);
  assert.equal(f.rate(), 2.5);
  assert.match(f.text(), /2\.5 avg t\/s/);
});
