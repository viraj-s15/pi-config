import { basename } from "node:path";
import type { AgentActivityOutcome, AgentBeforeSettleEvent, AgentSettledEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionStartEvent, UIPromptEndEvent, UIPromptStartEvent } from "@earendil-works/pi-coding-agent";

const FOCUS_LISTENER = Symbol.for("pi-config.notifications.focus-listener");
type Globals = typeof globalThis & { [FOCUS_LISTENER]?: () => void };

type NotificationTransport = (title: string, body: string) => Promise<void> | void;
type ProcessRunner = (executable: string, args: string[], options: { timeout: number }) => Promise<void>;

type Dependencies = {
  notify: NotificationTransport;
  getGlobal?: () => Globals;
};

const osascript = "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run";

export function createOsascriptTransport(runProcess: ProcessRunner): NotificationTransport {
  return (title, body) => runProcess("osascript", ["-e", osascript, title, body], { timeout: 3000 });
}

async function runOsascript(executable: string, args: string[], options: { timeout: number }): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve) => {
    execFile(executable, args, options, () => resolve());
  });
}


export function parseFocusInput(data: string): boolean | undefined {
  const focusedAt = data.lastIndexOf("\u001b[I");
  const blurredAt = data.lastIndexOf("\u001b[O");
  if (focusedAt < 0 && blurredAt < 0) return undefined;
  return focusedAt > blurredAt;
}

export function createNotificationExtension(pi: ExtensionAPI, deps: Dependencies): void {
  const root = deps.getGlobal?.() ?? globalThis as Globals;
  root[FOCUS_LISTENER]?.();
  delete root[FOCUS_LISTENER];

  let enabled = true;
  let terminalFocused: boolean | undefined;
  let unsubscribeTerminal: (() => void) | undefined;
  let activeRun = false;
  let runOutcome: AgentActivityOutcome | undefined;
  let runContext: ExtensionContext | undefined;
  let pendingPrompts: Array<{ kind: UIPromptStartEvent["kind"]; title?: string; notified: boolean }> = [];
  let disposed = false;
  const unsubscribeEvents: Array<() => void> = [];

  const titleFor = (cwd: string) => (basename(cwd.replace(/[\\/]+$/, "")) || "Pi").replace(/[\x00-\x1f\x7f;]/g, "-").slice(0, 80);
  const send = (ctx: ExtensionContext, body: string): boolean => {
    if (!enabled || disposed || ctx.mode !== "tui" || terminalFocused !== false) return false;
    try { void Promise.resolve(deps.notify(titleFor(ctx.cwd), body)).catch(() => {}); } catch { /* notifications never affect runs */ }
    return true;
  };
  const removeTerminal = () => {
    unsubscribeTerminal?.();
    unsubscribeTerminal = undefined;
  };
  const notifyPendingPrompts = (ctx: ExtensionContext) => {
    for (const prompt of pendingPrompts) {
      if (!prompt.notified && send(ctx, "Input needed")) prompt.notified = true;
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    activeRun = false;
    runContext = undefined;
    pendingPrompts = [];
    removeTerminal();
    for (const unsubscribe of unsubscribeEvents.splice(0)) unsubscribe();
    if (root[FOCUS_LISTENER] === dispose) delete root[FOCUS_LISTENER];
  };
  root[FOCUS_LISTENER] = dispose;

  pi.registerCommand("notify", {
    description: "Toggle or inspect background notifications",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase();
      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action !== "" && action !== "status") {
        ctx.ui.notify("Usage: /notify on|off|status", "info");
        return;
      }
      ctx.ui.notify(`Background notifications ${enabled ? "on" : "off"}`, "info");
    },
  });

  unsubscribeEvents.push(pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    activeRun = false;
    runOutcome = undefined;
    runContext = undefined;
    pendingPrompts = [];
    if (ctx.mode !== "tui" || disposed) return;
    removeTerminal();
    terminalFocused = undefined;
    unsubscribeTerminal = ctx.ui.onTerminalInput((data: string) => {
      const focus = parseFocusInput(data);
      if (focus !== undefined) {
        terminalFocused = focus;
        if (!focus && activeRun && runContext) notifyPendingPrompts(runContext);
      }
      // Observe synchronously and leave all terminal input untouched.
      return undefined;
    });
  }));
  unsubscribeEvents.push(pi.on("agent_start", (_event, ctx: ExtensionContext) => {
    activeRun = true;
    runOutcome = undefined;
    runContext = ctx;
    pendingPrompts = [];
  }));
  unsubscribeEvents.push(pi.on("agent_before_settle", (event: AgentBeforeSettleEvent) => {
    if (activeRun) runOutcome = event.outcome;
  }));
  unsubscribeEvents.push(pi.on("ui_prompt_start", (event: UIPromptStartEvent, ctx: ExtensionContext) => {
    if (!activeRun) return;
    const prompt = { kind: event.kind, title: event.title, notified: false };
    pendingPrompts.push(prompt);
    if (terminalFocused === false && send(ctx, "Input needed")) prompt.notified = true;
  }));
  unsubscribeEvents.push(pi.on("ui_prompt_end", (event: UIPromptEndEvent) => {
    if (!activeRun) return;
    const index = pendingPrompts.findIndex((prompt) => prompt.kind === event.kind && prompt.title === event.title);
    if (index >= 0) pendingPrompts.splice(index, 1);
  }));
  unsubscribeEvents.push(pi.on("agent_settled", (event: AgentSettledEvent, ctx: ExtensionContext) => {
    if (!activeRun) return;
    if (!event.aborted && runOutcome === "completed") send(ctx, "Task finished");
    else if (!event.aborted && runOutcome === "error") send(ctx, "Task failed");
    activeRun = false;
    runOutcome = undefined;
    runContext = undefined;
    pendingPrompts = [];
  }));
  unsubscribeEvents.push(pi.on("session_shutdown", () => dispose()));
}

export default function notificationsExtension(pi: ExtensionAPI): void {
  createNotificationExtension(pi, { notify: sendDesktopNotification });
}

async function sendDesktopNotification(title: string, body: string): Promise<void> {
  if (process.platform === "darwin") {
    await createOsascriptTransport(runOsascript)(title, body);
    return;
  }
  if (process.stdout.isTTY) process.stdout.write(`\u001b]777;notify;${title};${body}\u0007`);
}
