import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotificationExtension, createOsascriptTransport, parseFocusInput } from "../core.ts";

function harness(mode = "tui") {
  const events = new Map<string, Function[]>();
  let terminal: ((data: string) => unknown) | undefined;
  let command: Function | undefined;
  let shutdowns = 0;
  const notifications: Array<{ title: string; body: string }> = [];
  const pi: any = {
    on(name: string, handler: Function) {
      const list = events.get(name) ?? [];
      list.push(handler);
      events.set(name, list);
      return () => events.set(name, (events.get(name) ?? []).filter((item) => item !== handler));
    },
    registerCommand(_name: string, options: any) { command = options.handler; },
  };
  const ctx: any = {
    mode, cwd: "/tmp/example-project", ui: {
      onTerminalInput(handler: (data: string) => unknown) {
        terminal = handler;
        return () => { if (terminal === handler) terminal = undefined; };
      },
      notify() {},
    },
  };
  createNotificationExtension(pi, {
    notify: async (title, body) => { notifications.push({ title, body }); },
    getGlobal: () => globalThis as any,
  });
  return {
    notifications,
    emit(name: string, event: any = {}) { for (const fn of events.get(name) ?? []) fn({ type: name, ...event }, ctx); },
    focus(data: string) { return terminal?.(data); },
    get command() { return command!; },
    get terminalInstalled() { return !!terminal; },
    get listeners() { return events; },
    get shutdownCount() { return shutdowns; },
    shutdown() { this.emit("session_shutdown"); shutdowns++; },
    ctx,
  };
}

test("notification lifecycle and transport", async () => {
  assert.equal(parseFocusInput("\u001b[I"), true);
  assert.equal(parseFocusInput("\u001b[O"), false);
  assert.equal(parseFocusInput("abc\u001b[Ixyz"), true);
  assert.equal(parseFocusInput("\u001b[I\u001b[O"), false);
  assert.equal(parseFocusInput("\u001b[O\u001b[I"), true);
  assert.equal(parseFocusInput("ordinary input"), undefined);

  const processCalls: Array<{ executable: string; args: string[]; options: unknown }> = [];
  const osascript = createOsascriptTransport(async (executable, args, options) => {
    processCalls.push({ executable, args, options });
  });
  await osascript("Project", "Input needed");
  assert.equal(processCalls.length, 1);
  assert.equal(processCalls[0].executable, "osascript");
  assert.deepEqual(processCalls[0].args, [
    "-e",
    "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
    "Project",
    "Input needed",
  ]);
  assert.deepEqual(processCalls[0].options, { timeout: 3000 });

  const h = harness();
  h.emit("session_start");
  assert.equal(h.terminalInstalled, true);
  assert.equal(h.focus("\u001b[I"), undefined, "focus report remains available to TUI");
  h.emit("agent_start");
  h.emit("agent_before_settle", { outcome: "completed" });
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.notifications.length, 0, "unknown/default focused state suppresses notifications");
  h.focus("\u001b[O");
  h.emit("agent_start");
  h.emit("agent_before_settle", { outcome: "completed" });
  h.emit("agent_settled", { aborted: false });
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.notifications.length, 1);
  assert.deepEqual(h.notifications[0], { title: "example-project", body: "Task finished" });

  h.emit("agent_start");
  h.emit("agent_before_settle", { outcome: "error" });
  h.emit("agent_settled", { aborted: false });
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].body, "Task failed");
  h.emit("agent_start");
  h.emit("agent_before_settle", { outcome: "aborted" });
  h.emit("agent_settled", { aborted: true });
  assert.equal(h.notifications.length, 2, "abort is not success or failure");

  h.emit("ui_prompt_start", { reason: "ui_prompt", kind: "input", title: "Private prompt text" });
  assert.equal(h.notifications.filter((item) => item.body === "Input needed").length, 0, "prompts outside active runs are ignored");

  h.emit("agent_start");
  h.focus("\u001b[I");
  h.emit("ui_prompt_start", { reason: "ui_prompt", kind: "input", title: "Secret input prompt" });
  assert.equal(h.notifications.filter((item) => item.body === "Input needed").length, 0, "focused prompts wait for focus-out");
  h.focus("\u001b[O");
  assert.equal(h.notifications.filter((item) => item.body === "Input needed").length, 1, "focus-out notifies for a pending prompt");
  h.emit("ui_prompt_end", { reason: "ui_prompt", kind: "input", title: "Secret input prompt" });
  h.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Secret confirmation" });
  h.emit("ui_prompt_start", { reason: "ui_prompt", kind: "select", title: "Secret selection" });
  assert.equal(h.notifications.filter((item) => item.body === "Input needed").length, 3, "each actual prompt type gets one notification");
  assert.ok(!JSON.stringify(h.notifications).includes("Secret"));
  const finishedBeforeAbort = h.notifications.filter((item) => item.body === "Task finished").length;
  h.emit("agent_before_settle", { outcome: "completed" });
  h.emit("agent_settled", { aborted: true });
  assert.equal(h.notifications.filter((item) => item.body === "Task finished").length, finishedBeforeAbort, "settled abort overrides the earlier completed outcome");

  await h.command("status", h.ctx);
  await h.command("off", h.ctx);
  assert.equal(h.notifications.length, 5);
  h.emit("agent_start"); h.emit("agent_before_settle", { outcome: "completed" }); h.emit("agent_settled", { aborted: false });
  assert.equal(h.notifications.length, 5);
  await h.command("on", h.ctx);
  h.focus("\u001b[I");
  h.emit("agent_start"); h.emit("agent_before_settle", { outcome: "completed" }); h.emit("agent_settled", { aborted: false });
  assert.equal(h.notifications.length, 5, "focused terminal suppresses notification");

  const oldTerminal = h.focus;
  h.shutdown();
  assert.equal(h.terminalInstalled, false);
  assert.equal((h.listeners.get("agent_settled") ?? []).length, 0);

  const promptRetry = harness();
  promptRetry.emit("session_start");
  promptRetry.focus("\u001b[O");
  promptRetry.emit("agent_start");
  await promptRetry.command("off", promptRetry.ctx);
  promptRetry.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" });
  await promptRetry.command("on", promptRetry.ctx);
  promptRetry.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" });
  assert.equal(promptRetry.notifications.filter((item) => item.body === "Input needed").length, 1, "disabled prompts are not marked notified; a later prompt can notify");

  const stale = harness();
  stale.emit("session_start");
  stale.focus("\u001b[O");
  stale.emit("agent_start");
  stale.emit("agent_before_settle", { outcome: "completed" });
  stale.emit("session_start", { reason: "resume" });
  stale.emit("agent_settled", { aborted: false });
  assert.equal(stale.notifications.length, 0, "session start abandons prior run state");
  stale.emit("agent_start");
  stale.emit("ui_prompt_start", { reason: "ui_prompt", kind: "input" });
  stale.emit("session_start", { reason: "resume" });
  stale.emit("agent_start");
  stale.focus("\u001b[O");
  assert.equal(stale.notifications.length, 0, "new/resumed sessions clear pending prompts");

  const shutdownPrompt = harness();
  shutdownPrompt.emit("session_start");
  shutdownPrompt.focus("\u001b[I");
  shutdownPrompt.emit("agent_start");
  shutdownPrompt.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" });
  shutdownPrompt.shutdown();
  assert.equal(shutdownPrompt.notifications.length, 0, "shutdown clears pending prompts without notifying");

  const headless = harness("print");
  assert.equal(headless.terminalInstalled, false);
  headless.emit("agent_start"); headless.emit("agent_before_settle", { outcome: "completed" }); headless.emit("agent_settled", { aborted: false });
  assert.equal(headless.notifications.length, 0);
  void oldTerminal;

  const reloading = harness();
  reloading.emit("session_start");
  const replacement = harness();
  assert.equal(reloading.terminalInstalled, false, "reload removes the previous terminal listener");
  replacement.emit("session_start");
  assert.equal((reloading.listeners.get("agent_settled") ?? []).length, 0, "reload removes old lifecycle listeners");
  replacement.focus("\u001b[O");
  replacement.emit("agent_start");
  replacement.emit("agent_before_settle", { outcome: "completed" });
  replacement.emit("agent_settled", { aborted: false });
  assert.equal(replacement.notifications.length, 1);
});
