import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";

/** "12s", "1m 04s". */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function shortPath(path: unknown, cwd: string): string {
	if (typeof path !== "string" || !path) return "";
	if (isAbsolute(path)) {
		const inside = relative(cwd, path);
		if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
		const home = homedir();
		return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
	}
	return path;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const humanize = (name: string) => name.replace(/[_-]+/g, " ").trim();

/** What a running tool is doing, in a few words: "Reading src/a.ts", "Running npm test". */
export function describeTool(name: string, args: Record<string, any> = {}, cwd: string): string {
	switch (name) {
		case "bash": return `Running ${clip(String(args.command ?? "").replace(/\s+/g, " ").trim(), 60)}`;
		case "read": return `Reading ${shortPath(args.path, cwd)}`;
		case "edit": return `Editing ${shortPath(args.path, cwd)}`;
		case "write": return `Writing ${shortPath(args.path, cwd)}`;
		case "grep": return `Searching for "${clip(String(args.pattern ?? ""), 40)}"`;
		case "find": return `Finding "${clip(String(args.pattern ?? ""), 40)}"`;
		case "ls": return `Listing ${shortPath(args.path, cwd) || "."}`;
		case "web_search": return `Searching the web for "${clip(String(args.query ?? ""), 40)}"`;
		case "subagent": return "Running a subagent";
		case "ask_user": return "Waiting for your answer";
		case "todo": return "Updating todos";
		default: return `Running ${humanize(name)}`;
	}
}

const PREPARING: Record<string, string> = { bash: "a command", edit: "an edit", write: "a file", read: "a read", ask_user: "a question" };

type Phase =
	| { kind: "waiting" }
	| { kind: "thinking" }
	| { kind: "writing" }
	| { kind: "preparing"; tool?: string };

/** Tracks what the agent is doing right now, as a short label for the working line. */
export function createActivity(cwd: string) {
	let phase: Phase = { kind: "waiting" };
	const running = new Map<string, string>();

	return {
		start() {
			running.clear();
			phase = { kind: "waiting" };
		},
		replyStart() {
			phase = { kind: "waiting" };
		},
		/** An assistant stream event: thinking, answer text, or a tool call being written. */
		delta(type: string, _text: string, toolName?: string) {
			if (type.startsWith("thinking")) phase = { kind: "thinking" };
			else if (type === "text_delta" || type === "text_start") phase = { kind: "writing" };
			else if (type.startsWith("toolcall")) phase = { kind: "preparing", tool: toolName ?? (phase.kind === "preparing" ? phase.tool : undefined) };
		},
		toolStart(id: string, name: string, args?: Record<string, any>) {
			running.set(id, describeTool(name, args ?? {}, cwd));
		},
		toolEnd(id: string) {
			running.delete(id);
			if (running.size === 0) phase = { kind: "waiting" };
		},
		label(): string {
			if (running.size > 1) return `Running ${running.size} tools`;
			const [tool] = running.values();
			if (tool) return tool;
			switch (phase.kind) {
				case "thinking": return "Thinking";
				case "writing": return "Writing the answer";
				case "preparing": return `Preparing ${phase.tool ? PREPARING[phase.tool] ?? `a ${humanize(phase.tool)} call` : "a tool call"}`;
				default: return "Waiting for the model";
			}
		},
	};
}
