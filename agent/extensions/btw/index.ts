import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildBtwContext } from "./context.ts";
import { BtwOverlay } from "./overlay.ts";
import { BtwThread } from "./thread.ts";

export default function btwExtension(pi: ExtensionAPI): void {
  const thread = new BtwThread();
  let closeOverlay: (() => void) | undefined;
  let sessionId: string | undefined;

  const reset = () => {
    thread.clear();
    closeOverlay?.();
    closeOverlay = undefined;
  };
  pi.on("session_start", (_event, ctx) => { reset(); sessionId = ctx.sessionManager.getSessionId(); });
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  pi.registerCommand("btw", {
    description: "Ask a side question using this conversation, without adding to its history",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive terminal mode", "error");
        return;
      }
      const id = ctx.sessionManager.getSessionId();
      if (sessionId !== id) { reset(); sessionId = id; }
      if (closeOverlay || thread.busy) {
        ctx.ui.notify("A /btw question is already open. Dismiss it before asking another.", "warning");
        return;
      }
      const question = args.trim();
      if (!question && !thread.current && thread.exchanges.length === 0) {
        ctx.ui.notify("Usage: /btw <question> — answer from this chat without adding to its history", "info");
        return;
      }
      if (question && !ctx.model) {
        ctx.ui.notify("Select a model before asking /btw", "error");
        return;
      }
      // Capture only finalized, compaction-aware context before asynchronous work.
      // This never queues a main-agent prompt and does not wait for its active turn.
      const context = question ? buildBtwContext(
        ctx.sessionManager.buildSessionProjection().messages,
        ctx.getSystemPrompt(), thread.exchanges, question,
      ) : undefined;
      const model = ctx.model;
      const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
      const reasoning = thinking === "off" ? undefined : thinking;
      let ownClose: (() => void) | undefined;
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          const overlay = new BtwOverlay(thread, tui, theme, () => done());
          const close = () => overlay.close();
          ownClose = close;
          closeOverlay = close;
          if (question && context && model) {
            void thread.ask({ registry: ctx.modelRegistry, model, context, question, reasoning }, () => tui.requestRender());
          }
          return {
            render: (width: number) => overlay.render(width),
            handleInput: (data: string) => overlay.handleInput(data),
            invalidate: () => overlay.invalidate(),
            dispose: () => {
              overlay.dispose();
              if (closeOverlay === close) closeOverlay = undefined;
            },
          };
        }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center", margin: 1 } });
      } finally {
        // An old command can resume after a new overlay has already opened.
        if (closeOverlay === ownClose) closeOverlay = undefined;
      }
    },
  });
}
