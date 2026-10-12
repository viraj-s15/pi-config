import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { analyzeContext, formatTokens } from "../breakdown.ts";
import { renderContext } from "../view.ts";
import contextExtension from "../index.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const x = (n: number) => "x".repeat(n);

const SYSTEM = [
	x(4000),
	"Project-specific instructions and guidelines:",
	`<project_instructions path="/p/AGENTS.md">\n${x(8000)}\n</project_instructions>`,
	`<available_skills>\n${x(2000)}\n</available_skills>`,
	x(400),
].join("\n\n");

const tools = [
	{ name: "read", description: x(200), parameters: { type: "object", properties: { path: { type: "string" } } } },
	{ name: "bash", description: x(600), parameters: { type: "object" } },
];

const messages = [
	{ role: "user", content: [{ type: "text", text: x(400) }], timestamp: 1 },
	{ role: "assistant", content: [{ type: "thinking", thinking: x(9000) }, { type: "text", text: x(800) }, { type: "toolCall", id: "r", name: "read", arguments: { path: "/p/src/big.ts" } }], timestamp: 2 },
	{ role: "toolResult", toolCallId: "r", toolName: "read", content: [{ type: "text", text: x(40_000) }], isError: false, timestamp: 3 },
	{ role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "npm test -- --watch=false" } }], timestamp: 4 },
	{ role: "toolResult", toolCallId: "b", toolName: "bash", content: [{ type: "text", text: x(4000) }], isError: false, timestamp: 5 },
	{ role: "compactionSummary", summary: x(1200), tokensBefore: 100, timestamp: 6 },
];

const byLabel = (parts: { label: string; tokens: number }[]) => Object.fromEntries(parts.map((p) => [p.label, p.tokens]));

test("splits the context into what fills it, from the system prompt's sections and the messages", () => {
	const b = analyzeContext({ systemPrompt: SYSTEM, tools, messages, actualTokens: null, contextWindow: 200_000, cwd: "/p" });
	const parts = byLabel(b.parts);
	assert.equal(parts["Project instructions"], 2000);
	assert.equal(parts["Skills"], 500);
	assert.ok(parts["System prompt"]! >= 1100 && parts["System prompt"]! <= 1130, `base prompt ≈ 1.1k, got ${parts["System prompt"]}`);
	assert.ok(parts["Tool definitions"]! > 200);
	assert.equal(parts["Your messages"], 100);
	assert.equal(parts["Tool results"], 11_000);
	assert.equal(parts["Summaries"], 300);
	assert.ok(parts["Agent text"]! >= 200 && parts["Agent text"]! < 240, "text plus tool-call arguments");
	assert.equal(b.estimated, true, "no real count, so it is an estimate");
	assert.equal(parts["Thinking"], undefined, "earlier thinking is not resent, so it is not counted");
});

test("with a real count the parts add up to it: leftover goes to an 'other' slice, overshoot scales down", () => {
	const base = analyzeContext({ systemPrompt: SYSTEM, tools, messages, actualTokens: null, contextWindow: 200_000, cwd: "/p" });
	const more = analyzeContext({ systemPrompt: SYSTEM, tools, messages, actualTokens: base.total + 3000, contextWindow: 200_000, cwd: "/p" });
	assert.equal(more.estimated, false);
	assert.equal(more.total, base.total + 3000);
	assert.equal(byLabel(more.parts)["Other (formatting, reasoning)"], 3000);
	const less = analyzeContext({ systemPrompt: SYSTEM, tools, messages, actualTokens: Math.round(base.total / 2), contextWindow: 200_000, cwd: "/p" });
	assert.equal(less.parts.reduce((sum, p) => sum + p.tokens, 0), less.total);
	assert.ok(Math.abs(byLabel(less.parts)["Tool results"]! - 5500) <= 2);
});

test("lists the biggest single items, naming the file or command", () => {
	const b = analyzeContext({ systemPrompt: SYSTEM, tools, messages, actualTokens: null, contextWindow: 200_000, cwd: "/p" });
	assert.deepEqual(b.biggest.slice(0, 3).map((i) => i.label), ["read src/big.ts", "AGENTS.md", "bash npm test -- --watch=false"]);
	assert.equal(b.biggest[0]!.tokens, 10_000);
});

test("images count as a fixed estimate each", () => {
	const b = analyzeContext({
		systemPrompt: "", tools: [], actualTokens: null, contextWindow: 100_000, cwd: "/p",
		messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 }],
	});
	assert.ok(byLabel(b.parts)["Your messages"]! >= 1500);
});

test("token counts read like the footer: 950, 12.3k, 1.2M", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(12_345), "12.3k");
	assert.equal(formatTokens(1_200_000), "1.2M");
	assert.equal(formatTokens(999_990), "1.0M", "never 1000.0k");
	assert.equal(formatTokens(999.6), "1.0k");
});

test("the dashboard fits its width and shows the total, the parts and the biggest items", () => {
	const b = analyzeContext({ systemPrompt: SYSTEM, tools, messages, actualTokens: 20_000, contextWindow: 200_000, cwd: "/p" });
	for (const width of [60, 96]) {
		const lines = renderContext(b, width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `fits ${width}: ${plain(line)}`);
		const text = plain(lines.join("\n"));
		assert.match(text, /20\.0k of 200\.0k tokens · 10%/);
		assert.match(text, /Tool results\s+11\.0k/);
		assert.match(text, /Free\s+180\.0k/);
		assert.match(text, /read src\/big\.ts/);
	}
});

test("registers /context", () => {
	const commands: string[] = [];
	contextExtension({ registerCommand: (name: string) => commands.push(name), on() {} } as any);
	assert.deepEqual(commands, ["context"]);
});
