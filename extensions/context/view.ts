/** The /context dashboard: a rose box like /usage with one stacked bar and a legend. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ContextBreakdown, formatTokens, OTHER } from "./breakdown.ts";

type RGB = [number, number, number];
const RESET = "\x1b[0m";
const fg = ([r, g, b]: RGB, s: string) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const ROSE: RGB = [0xff, 0x7e, 0xb6];
const TEXT: RGB = [0xdd, 0xe1, 0xe6];
const MUTED: RGB = [0x8d, 0x91, 0x99];
const SUBTLE: RGB = [0x6e, 0x74, 0x7d];
const TRACK: RGB = [0x33, 0x35, 0x3b];

const COLORS: Record<string, RGB> = {
	"System prompt": [0x78, 0xa9, 0xff],
	"Project instructions": [0x33, 0xb1, 0xff],
	Skills: [0x08, 0xbd, 0xba],
	"Tool definitions": [0x3d, 0xdb, 0xd9],
	"Your messages": [0xff, 0x7e, 0xb6],
	"Agent text": [0xbe, 0x95, 0xff],
	"Tool results": [0xff, 0x83, 0x2b],
	Summaries: [0x42, 0xbe, 0x65],
	"Extension messages": [0xee, 0x53, 0x96],
	[OTHER]: [0x6e, 0x74, 0x7d],
};

/** Each part gets at least one cell if it is there at all, so small parts stay visible. */
function stacked(parts: Array<{ tokens: number; color: RGB }>, total: number, width: number): string {
	const cells = parts.map((part) => (part.tokens > 0 ? Math.max(1, Math.round((part.tokens / total) * width)) : 0));
	let over = cells.reduce((sum, n) => sum + n, 0) - width;
	while (over > 0) {
		const i = cells.indexOf(Math.max(...cells));
		cells[i]!--;
		over--;
	}
	return parts.map((part, i) => fg(part.color, "█".repeat(cells[i]!))).join("") + fg(TRACK, "█".repeat(Math.max(0, -over)));
}

export function renderContext(b: ContextBreakdown, width: number): string[] {
	const inner = Math.max(10, width - 2);
	const edge = (s: string) => fg(ROSE, s);
	const row = (content: string) => {
		const t = truncateToWidth(content, inner);
		return edge("│") + t + " ".repeat(Math.max(0, inner - visibleWidth(t))) + edge("│");
	};
	const title = ` ${bold("Context")} `;
	const lines = [edge("╭─") + fg(ROSE, title) + edge("─".repeat(Math.max(0, inner - 1 - visibleWidth(title))) + "╮"), row("")];

	const window = Math.max(b.contextWindow, b.total);
	const percent = window > 0 ? Math.round((b.total / window) * 100) : 0;
	const free = Math.max(0, b.contextWindow - b.total);
	lines.push(row(`  ${fg(TEXT, bold(`${formatTokens(b.total)} of ${formatTokens(b.contextWindow)} tokens · ${percent}%`))}${b.estimated ? fg(MUTED, "  (estimated: no reply yet)") : ""}`));
	lines.push(row(""));
	const barWidth = Math.max(10, inner - 4);
	lines.push(row(`  ${stacked(b.parts.map((p) => ({ tokens: p.tokens, color: COLORS[p.label] ?? SUBTLE })), window, barWidth)}`));
	lines.push(row(""));

	const labelWidth = Math.max(4, ...b.parts.map((p) => p.label.length));
	const share = (n: number) => `${Math.round((n / Math.max(1, window)) * 100)}%`.padStart(4);
	for (const part of b.parts) {
		const color = COLORS[part.label] ?? SUBTLE;
		lines.push(row(`  ${fg(color, "■")} ${fg(TEXT, part.label.padEnd(labelWidth))}  ${fg(color, formatTokens(part.tokens).padStart(7))}  ${fg(SUBTLE, share(part.tokens))}`));
	}
	lines.push(row(`  ${fg(TRACK, "■")} ${fg(MUTED, "Free".padEnd(labelWidth))}  ${fg(MUTED, formatTokens(free).padStart(7))}  ${fg(SUBTLE, share(free))}`));

	if (b.biggest.length) {
		lines.push(row(""));
		lines.push(row(`  ${fg(MUTED, "Biggest items")}`));
		const sizeWidth = Math.max(...b.biggest.map((item) => formatTokens(item.tokens).length));
		for (const item of b.biggest) lines.push(row(`    ${fg(TEXT, formatTokens(item.tokens).padStart(sizeWidth))}  ${fg(MUTED, item.label)}`));
	}
	lines.push(row(""));
	lines.push(row(`  ${fg(SUBTLE, "Parts are estimated from their text and fitted to the total.  esc close")}`));
	lines.push(edge(`╰${"─".repeat(inner)}╯`));
	return lines;
}
