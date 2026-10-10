import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { tmpdir } from "node:os";
import { piModuleUrl } from "../../../tests/pi-runtime.mjs";
import oxoExtension from "../index.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";

const { processResponsesStream } = await import(piModuleUrl("@earendil-works/pi-ai/dist/api/openai-responses-shared.js"));

function fixture(t: TestContext) {
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
  return {
    emit, text, rate, delta, end, response, register, branch,
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

type ResponsesFixtureEvent =
  | { type: "response.output_item.added"; output_index: number; item:
      | { id: string; type: "function_call"; status: string; call_id: string; name: string; arguments: string }
      | { id: string; type: "reasoning"; summary: unknown[]; content: unknown[] }
      | { id: string; type: "message"; status: string; role: "assistant"; content: unknown[]; phase: "final_answer" } }
  | { type: "response.output_item.done"; output_index: number; item:
      | { id: string; type: "function_call"; status: string; call_id: string; name: string; arguments: string }
      | { id: string; type: "reasoning"; summary: { type: "summary_text"; text: string }[]; content: unknown[] }
      | { id: string; type: "message"; status: string; role: "assistant"; phase: "final_answer";
          content: { type: "output_text"; text: string; annotations: unknown[] }[] } }
  | { type: "response.reasoning_summary_text.delta"; output_index: number; delta: string }
  | { type: "response.output_text.delta"; output_index: number; content_index: number; delta: string }
  | { type: "response.completed"; response: { id: string; object: "response"; status: "completed"; output: unknown[];
      usage: { input_tokens: number; output_tokens: number; total_tokens: number;
        input_tokens_details?: { cached_tokens: number }; output_tokens_details?: { reasoning_tokens: number } } } };

test("sanitized OpenAI Responses protocol fixture normalizes reasoning, tool use, text, and usage", async t => {
  const f = fixture(t);
  const model = {
    api: "openai-responses", provider: "openai", id: "fixture-model",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<"openai-responses">;
  const baseMessage = (): AssistantMessage => ({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending", timestamp: 0,
  });
  const normalize = async (events: ResponsesFixtureEvent[]) => {
    const message = baseMessage();
    const normalized: AssistantMessageEvent[] = [];
    await processResponsesStream(
      (async function* () { yield* events; })(),
      message, { push: (event: AssistantMessageEvent) => normalized.push(event) }, model,
    );
    return { message, normalized };
  };

  // Sanitized synthetic protocol fixture, shaped for Pi 1.1.0's installed Responses adapter;
  // it is not a captured live provider trace. The supplied 392/217 usage values are recorded
  // from an actual session summary; the surrounding event sequence is constructed for this test.
  const toolTurn = await normalize([
    { type: "response.output_item.added", output_index: 0,
      item: { id: "fc_fixture", type: "function_call", status: "in_progress", call_id: "call_fixture", name: "read", arguments: "{}" } },
    { type: "response.output_item.done", output_index: 0,
      item: { id: "fc_fixture", type: "function_call", status: "completed", call_id: "call_fixture", name: "read", arguments: "{}" } },
    { type: "response.completed", response: { id: "resp_tool", object: "response", status: "completed",
      output: [], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 } } },
  ]);
  assert.equal(toolTurn.message.stopReason, "toolUse");
  assert.ok(toolTurn.message.content.some(block => block.type === "toolCall"));

  const finalAnswer = await normalize([
    { type: "response.output_item.added", output_index: 0,
      item: { id: "rs_fixture", type: "reasoning", summary: [], content: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Planning before answer." },
    { type: "response.output_item.done", output_index: 0,
      item: { id: "rs_fixture", type: "reasoning", summary: [{ type: "summary_text", text: "Planning before answer." }], content: [] } },
    { type: "response.output_item.added", output_index: 1,
      item: { id: "msg_fixture", type: "message", status: "in_progress", role: "assistant", content: [], phase: "final_answer" } },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "A sanitized answer " },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "streamed in pieces." },
    { type: "response.output_item.done", output_index: 1,
      item: { id: "msg_fixture", type: "message", status: "completed", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "A sanitized answer streamed in pieces.", annotations: [] }] } },
    { type: "response.completed", response: { id: "resp_final", object: "response", status: "completed",
      output: [], usage: { input_tokens: 30, output_tokens: 392, total_tokens: 422,
        input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 217 } } } },
  ]);
  assert.equal(finalAnswer.message.usage.output, 392);
  assert.equal(finalAnswer.message.usage.reasoning, 217);
  assert.ok(finalAnswer.normalized.some(event => event.type === "thinking_delta"));
  assert.equal(finalAnswer.normalized.filter(event => event.type === "text_delta").length, 2);

  f.emit("message_start", { message: { role: "assistant" } });
  for (const event of toolTurn.normalized) f.emit("message_update", { assistantMessageEvent: event });
  f.emit("message_end", { message: toolTurn.message });
  assert.equal(f.rate(), 0, "tool-use turn does not initialize TPS");

  f.emit("message_start", { message: { role: "assistant" } });
  for (const event of finalAnswer.normalized) {
    f.emit("message_update", { assistantMessageEvent: event });
    if (event.type === "text_delta") t.mock.timers.tick(2500);
  }
  f.emit("message_end", { message: finalAnswer.message });
  assert.equal(f.rate(), 35, "175 answer tokens over five seconds; reasoning is excluded");
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
