/**
 * /context: what fills the context window, as a stacked bar with a legend and the biggest items
 * (files read, command output, AGENTS.md). Like Claude Code's /context.
 */

import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { analyzeContext } from "./breakdown.ts";
import { renderContext } from "./view.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show what fills the context window",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const usage = ctx.getContextUsage();
			const active = new Set(pi.getActiveTools());
			const breakdown = analyzeContext({
				systemPrompt: ctx.getSystemPrompt(),
				tools: pi.getAllTools().filter((tool) => active.has(tool.name)),
				messages: buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
				actualTokens: usage?.tokens,
				contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
				cwd: ctx.cwd,
			});
			await ctx.ui.custom<void>(
				(_tui, _theme, _kb, done) => ({
					render: (width: number) => renderContext(breakdown, width),
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") done();
					},
				}),
				{ overlay: true, overlayOptions: { width: 84, minWidth: 50, maxHeight: "90%", anchor: "center" } },
			);
		},
	});
}
