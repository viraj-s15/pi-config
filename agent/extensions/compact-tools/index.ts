/**
 * compact-tools: one-line bullets instead of boxed tool blocks.
 *
 *   ● Bash(git status --short)            yellow while running, green when done, red on error
 *   ● Update(agent/extensions/x.ts)
 *   ● Read(README.md:1-40)  1.2s
 *     ⎿ error text                         only shown when a tool fails
 *
 * Ctrl+O expands a row to the tool's normal output (diffs, full command output, subagent results).
 * Hidden thinking blocks get the same bullet style (toggle thinking with Ctrl+T).
 *
 * Toggle: /bullets [on|off]. New tool rows follow the setting right away; run /reload to redraw old ones.
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

const fg = (rgb: [number, number, number], s: string) => `\x1b[38;2;${rgb.join(";")}m${s}\x1b[39m`;
const C = {
	run: [0xf1, 0xc2, 0x1b] as [number, number, number], // carbon yellow
	ok: [0x42, 0xbe, 0x65] as [number, number, number],
	err: [0xfa, 0x4d, 0x56] as [number, number, number],
	text: [0xdd, 0xe1, 0xe6] as [number, number, number],
	dim: [0x8d, 0x91, 0x99] as [number, number, number],
	faint: [0x6e, 0x74, 0x7d] as [number, number, number],
	thought: [0xbe, 0x95, 0xff] as [number, number, number],
};
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

class Lines implements Component {
	constructor(private build: (width: number) => string[]) {}
	render(width: number): string[] {
		return this.build(width);
	}
	invalidate(): void {}
}
const EMPTY = () => new Lines(() => []);

const NAMES: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	edit: "Update",
	write: "Write",
	grep: "Search",
	find: "Find",
	ls: "List",
	web_search: "Web Search",
	ask_user: "Ask",
	todo: "Todo",
	subagent: "Subagent",
};
const titleCase = (n: string) => NAMES[n] ?? n.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const short = (p: unknown) => {
	const s = String(p ?? "");
	const home = homedir();
	return s.startsWith(home) ? `~${s.slice(home.length)}` : s;
};
const oneLine = (s: unknown) => {
	const lines = String(s ?? "").trim().split("\n");
	const first = lines[0]!.replace(/\s+/g, " ").trim();
	return lines.length > 1 ? `${first} …` : first;
};

function summarize(tool: string, a: Record<string, any>): string {
	switch (tool) {
		case "bash":
			return oneLine(a.command);
		case "read": {
			const range = a.offset !== undefined || a.limit !== undefined ? `:${a.offset ?? 1}${a.limit !== undefined ? `-${(a.offset ?? 1) + a.limit - 1}` : ""}` : "";
			return short(a.path ?? a.file_path) + range;
		}
		case "edit":
			return short(a.path ?? a.file_path);
		case "write":
			return `${short(a.path ?? a.file_path)}${a.content ? ` (${String(a.content).split("\n").length} lines)` : ""}`;
		case "grep":
			return `${a.pattern ?? ""}${a.path ? ` in ${short(a.path)}` : ""}`;
		case "find":
			return `${a.pattern ?? "*"}${a.path ? ` in ${short(a.path)}` : ""}`;
		case "ls":
			return short(a.path ?? ".");
		case "web_search":
			return String(a.query ?? "");
		case "todo":
			return [a.action, a.title ?? a.id].filter(Boolean).join(" ");
		case "subagent": {
			const nameOf = (x: any, i: number, n: number) => x.name || (n > 1 ? `subagent-${i + 1}` : "subagent");
			if (a.chain?.length) return `chain: ${a.chain.map((x: any, i: number) => nameOf(x, i, a.chain.length)).join(" → ")}`;
			if (a.tasks?.length) return `${a.tasks.length} parallel: ${a.tasks.map((x: any, i: number) => nameOf(x, i, a.tasks.length)).join(", ")}`;
			return a.name || oneLine(a.task);
		}
		default: {
			for (const v of Object.values(a ?? {})) if (typeof v === "string" && v.trim()) return oneLine(v);
			const j = JSON.stringify(a ?? {});
			return j === "{}" ? "" : j;
		}
	}
}

const textOf = (result: any): string =>
	(result?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n")
		.trim();

export default function (pi: ExtensionAPI) {
	let enabled = true;

	const applyThinkingLabel = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setHiddenThinkingLabel(enabled ? `${fg(C.thought, "●")} thinking…` : undefined);
	};

	pi.registerToolRenderer((toolName, next) => {
		if (!enabled) return next();
		const original = next();

		return {
			renderShell: "self",

			renderCall(args: any, _theme: any, context: any) {
				const pad = " ".repeat(context.outputPad ?? 1);
				return new Lines((width) => {
					const failed = context.isError;
					const running = context.isPartial;
					const dot = fg(failed ? C.err : running ? C.run : C.ok, "●");
					const detail = summarize(toolName, args ?? {});
					let line = `${pad}${dot} ${bold(fg(C.text, titleCase(toolName)))}`;
					if (detail) line += fg(C.faint, "(") + fg(C.dim, detail) + fg(C.faint, ")");
					const ms = context.durationMs as number | undefined;
					if (ms !== undefined && ms >= 500) line += fg(C.faint, `  ${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);
					return [truncateToWidth(line, width)];
				});
			},

			renderResult(result: any, options: any, theme: any, context: any) {
				const pad = " ".repeat(context.outputPad ?? 1);
				const output = textOf(result);

				if (options.expanded) {
					if (original?.renderResult) {
						try {
							return original.renderResult(result, options, theme, context);
						} catch {
							/* fall back to plain output below */
						}
					}
					if (!output) return EMPTY();
					return new Lines((width) => output.split("\n").map((l) => truncateToWidth(`${pad}  ${fg(C.dim, l)}`, width)));
				}

				if (context.isError && output) {
					const first = oneLine(output);
					return new Lines((width) => [truncateToWidth(`${pad}  ${fg(C.faint, "⎿")} ${fg(C.err, first)}`, width)]);
				}
				return EMPTY();
			},
		};
	});

	pi.on("session_start", (_e, ctx) => applyThinkingLabel(ctx));

	pi.registerCommand("bullets", {
		description: "One-line tool bullets instead of boxed tool blocks: on | off",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			enabled = a === "on" ? true : a === "off" ? false : !enabled;
			applyThinkingLabel(ctx);
			ctx.ui.notify(`tool bullets ${enabled ? "on" : "off"} (new tool rows now, /reload for old ones)`, "info");
		},
	});
}
