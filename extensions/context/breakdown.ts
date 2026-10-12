/**
 * What fills the context window. Pi only knows the total, so each part is estimated from its text
 * (about 4 characters a token) and the estimates are then fitted to the real total when there is one.
 */

import { homedir } from "node:os";
import { relative } from "node:path";

export interface ContextPart {
	label: string;
	tokens: number;
}

export interface ContextItem {
	label: string;
	tokens: number;
}

export interface ContextBreakdown {
	/** Tokens in the context: the real count when Pi has one, else the sum of the estimates. */
	total: number;
	contextWindow: number;
	/** True when there was no real count to fit the estimates to. */
	estimated: boolean;
	parts: ContextPart[];
	/** The largest single things in the context, biggest first. */
	biggest: ContextItem[];
}

export interface ContextInput {
	systemPrompt: string;
	tools: Array<{ name: string; description?: string; parameters?: unknown }>;
	messages: any[];
	actualTokens: number | null | undefined;
	contextWindow: number;
	cwd: string;
}

const CHARS_PER_TOKEN = 4;
/** A typical screenshot after Pi's resizing; the real cost depends on the image's size. */
const IMAGE_TOKENS = 1_600;
export const OTHER = "Other (formatting, reasoning)";
const ORDER = ["System prompt", "Project instructions", "Skills", "Tool definitions", "Your messages", "Agent text", "Tool results", "Summaries", "Extension messages", OTHER];

const tokensOf = (text: string) => Math.round(text.length / CHARS_PER_TOKEN);

export function formatTokens(n: number): string {
	// Pick the unit after rounding, so 999,990 reads 1.0M rather than 1000.0k.
	if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 999.5) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

function shortPath(path: string, cwd: string): string {
	const inside = relative(cwd, path);
	if (inside && !inside.startsWith("..") && !inside.startsWith("/")) return inside;
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function contentTokens(content: unknown): number {
	if (typeof content === "string") return tokensOf(content);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content) {
		if (block?.type === "text") tokens += tokensOf(String(block.text ?? ""));
		else if (block?.type === "image") tokens += IMAGE_TOKENS;
	}
	return tokens;
}

function describeCall(call: { name?: string; arguments?: any } | undefined, cwd: string): string {
	if (!call) return "tool result";
	const args = call.arguments ?? {};
	const name = call.name ?? "tool";
	if (typeof args.path === "string") return `${name} ${shortPath(args.path, cwd)}`;
	if (typeof args.command === "string") {
		const command = args.command.replace(/\s+/g, " ").trim();
		return `${name} ${command.length > 48 ? `${command.slice(0, 47)}…` : command}`;
	}
	if (typeof args.pattern === "string") return `${name} ${args.pattern}`;
	if (typeof args.query === "string") return `${name} ${args.query}`;
	return name;
}

export function analyzeContext(input: ContextInput): ContextBreakdown {
	const sums = new Map<string, number>();
	const add = (label: string, tokens: number) => {
		if (tokens > 0) sums.set(label, (sums.get(label) ?? 0) + tokens);
	};
	const items: ContextItem[] = [];

	// System prompt: project instructions and the skills list are sections of it.
	let base = input.systemPrompt;
	for (const match of input.systemPrompt.matchAll(/<project_instructions path="([^"]*)">\n?([\s\S]*?)\n?<\/project_instructions>/g)) {
		const tokens = tokensOf(match[2] ?? "");
		add("Project instructions", tokens);
		items.push({ label: shortPath(match[1] ?? "", input.cwd), tokens });
		base = base.replace(match[0], "");
	}
	for (const match of input.systemPrompt.matchAll(/<available_skills>\n?([\s\S]*?)\n?<\/available_skills>/g)) {
		add("Skills", tokensOf(match[1] ?? ""));
		base = base.replace(match[0], "");
	}
	add("System prompt", tokensOf(base));

	for (const tool of input.tools) {
		add("Tool definitions", tokensOf(JSON.stringify({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? {} })));
	}

	const calls = new Map<string, { name?: string; arguments?: unknown }>();
	for (const message of input.messages) {
		switch (message?.role) {
			case "user":
			case "bashExecution": {
				const tokens = message.role === "user"
					? contentTokens(message.content)
					: tokensOf(`${message.command ?? ""}\n${message.output ?? ""}`);
				add("Your messages", tokens);
				break;
			}
			case "assistant":
				for (const block of message.content ?? []) {
					// Earlier thinking is not sent back to the model, so it does not take up room.
					if (block?.type === "text") add("Agent text", tokensOf(String(block.text ?? "")));
					else if (block?.type === "toolCall") {
						calls.set(block.id, block);
						add("Agent text", tokensOf(JSON.stringify(block.arguments ?? {})));
					}
				}
				break;
			case "toolResult": {
				const tokens = contentTokens(message.content);
				add("Tool results", tokens);
				items.push({ label: describeCall(calls.get(message.toolCallId) ?? { name: message.toolName }, input.cwd), tokens });
				break;
			}
			case "compactionSummary":
			case "branchSummary":
				add("Summaries", tokensOf(String(message.summary ?? "")));
				break;
			case "custom":
				add("Extension messages", contentTokens(message.content));
				break;
		}
	}

	const estimate = [...sums.values()].reduce((sum, n) => sum + n, 0);
	const actual = input.actualTokens ?? null;
	let parts = ORDER.filter((label) => sums.has(label)).map((label) => ({ label, tokens: sums.get(label)! }));
	if (actual !== null && actual > 0) {
		if (actual >= estimate) {
			if (actual > estimate) parts.push({ label: OTHER, tokens: actual - estimate });
		} else {
			// Fit down to the real count, keeping the sum exact.
			const scale = actual / estimate;
			parts = parts.map((part) => ({ label: part.label, tokens: Math.round(part.tokens * scale) }));
			const drift = actual - parts.reduce((sum, part) => sum + part.tokens, 0);
			const largest = parts.reduce((a, b) => (b.tokens > a.tokens ? b : a), parts[0]!);
			if (largest) largest.tokens += drift;
		}
	}

	return {
		total: actual !== null && actual > 0 ? actual : estimate,
		contextWindow: input.contextWindow,
		estimated: actual === null || actual <= 0,
		parts,
		biggest: items.filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 6),
	};
}
