import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface DiffFile {
	path: string;
	added: number;
	removed: number;
	binary: boolean;
	patch: string;
	truncated?: boolean;
}

export interface DiffReport {
	files: DiffFile[];
	truncated?: boolean;
}

const INLINE_LINES = 160;

/** Remove terminal protocols and control characters from untrusted git/source text. */
export function sanitize(value: unknown): string {
	return String(value ?? "")
		.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\|$)/g, "") // OSC (titles, hyperlinks, clipboard)
		.replace(/\x1B[P^_][\s\S]*?(?:\x1B\\|\x07|$)/g, "") // DCS, PM, APC
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "") // CSI, including ANSI styling
		.replace(/\x1B[ -/]*[@-~]/g, "")
		.replace(/[\t]/g, " ")
		.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}

function totals(report: DiffReport): { added: number; removed: number } {
	return report.files.reduce((sum, file) => ({ added: sum.added + (Number(file.added) || 0), removed: sum.removed + (Number(file.removed) || 0) }), { added: 0, removed: 0 });
}

export function summary(report: DiffReport): string {
	const { added, removed } = totals(report);
	const count = report.files.length;
	return `▸ Changes · ${count} file${count === 1 ? "" : "s"} · +${added} −${removed}`;
}

function color(theme: any, token: string, text: string): string {
	try { return typeof theme?.fg === "function" ? theme.fg(token, text) : text; } catch { return text; }
}

function safeLabel(value: unknown): string {
	return sanitize(value).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function diffLines(file: DiffFile, expanded: boolean, remaining = INLINE_LINES): string[] {
	if (!expanded) return [];
	if (file.binary) return ["  Binary file changed"];
	const lines = sanitize(file.patch).split(/\r?\n/);
	const preview = lines.slice(0, Math.max(0, remaining));
	const output = preview.map((line) => `  ${line}`);
	if (lines.length > preview.length || file.truncated) output.push("  … inline preview limited; use /diff last for remaining content");
	return output;
}

/** Compact transcript component; source data is sanitized before styling or rendering. */
export class TurnDiffComponent implements Component {
	private expanded: boolean;
	private readonly opened: boolean[];
	private width = 80;

	constructor(private readonly report: DiffReport, private readonly theme: any, expanded = false) {
		this.expanded = expanded;
		this.opened = report.files.map(() => expanded);
	}

	render(width: number): string[] {
		this.width = Math.max(1, width);
		const lines = [truncateToWidth(`${this.expanded ? "▾" : "▸"} ${sanitize(summary(this.report).slice(2))}`, this.width)];
		if (!this.expanded) return lines;
		let remaining = INLINE_LINES;
		this.report.files.forEach((file, index) => {
			const marker = this.opened[index] ? "▾" : "▸";
			const label = `${marker} ${safeLabel(file.path)}  ${color(this.theme, "success", `+${Number(file.added) || 0}`)} ${color(this.theme, "error", `−${Number(file.removed) || 0}`)}${file.binary ? " · binary" : ""}`;
			lines.push(truncateToWidth(label, this.width));
			const patchLines = diffLines(file, this.opened[index]!, remaining);
			remaining -= patchLines.filter((line) => !line.includes("inline preview limited")).length;
			lines.push(...patchLines.map((line) => {
				const clean = truncateToWidth(line, this.width);
				if (/^  \+/.test(clean)) return color(this.theme, "success", clean);
				if (/^  -/.test(clean)) return color(this.theme, "error", clean);
				if (/^  @@/.test(clean)) return color(this.theme, "accent", clean);
				return color(this.theme, "dim", clean);
			}));
		});
		if (this.report.truncated) lines.push(truncateToWidth(color(this.theme, "warning", "… patch safety limit reached; /diff last uses the same limit"), this.width));
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y === 0) {
			this.expanded = !this.expanded;
			if (this.expanded) this.opened.fill(false);
		}
		else if (this.expanded) {
			let row = 1;
			let remaining = INLINE_LINES;
			for (let i = 0; i < this.report.files.length; i++) {
				if (event.y === row) { this.opened[i] = !this.opened[i]; break; }
				const lines = diffLines(this.report.files[i]!, this.opened[i]!, remaining);
				remaining -= lines.filter((line) => !line.includes("inline preview limited")).length;
				row += 1 + lines.length;
			}
		}
		return { handled: true, render: true };
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter") || matchesKey(data, "space")) this.expanded = !this.expanded;
	}

	invalidate(): void {}
}

class DiffPanel implements Component {
	private expanded: boolean[];
	private selected = 0;
	private offset = 0;
	private width = 80;

	constructor(private readonly tui: any, private readonly theme: any, private readonly done: () => void, private readonly report: DiffReport, private readonly title: string) {
		this.expanded = report.files.map(() => true);
	}

	private fileRow(index: number): number {
		let row = 0;
		for (let i = 0; i < index; i++) row += 1 + (this.expanded[i] ? (this.report.files[i]!.binary ? 1 : sanitize(this.report.files[i]!.patch).split(/\r?\n/).length) : 0);
		return row;
	}

	private content(width: number): string[] {
		const out: string[] = [];
		if (!this.report.files.length) out.push(color(this.theme, "dim", "No file changes."));
		this.report.files.forEach((file, index) => {
			const arrow = index === this.selected ? "▶" : " ";
			out.push(truncateToWidth(`${arrow} ${this.expanded[index] ? "▾" : "▸"} ${safeLabel(file.path)}  +${Number(file.added) || 0} −${Number(file.removed) || 0}${file.binary ? " · binary" : ""}`, width));
			if (this.expanded[index]) {
				if (file.binary) out.push(color(this.theme, "dim", "  Binary file changed"));
				else for (const line of sanitize(file.patch).split(/\r?\n/)) {
					let styled = `  ${line}`;
					if (line.startsWith("+") && !line.startsWith("+++")) styled = color(this.theme, "success", styled);
					else if (line.startsWith("-") && !line.startsWith("---")) styled = color(this.theme, "error", styled);
					else if (line.startsWith("@@")) styled = color(this.theme, "accent", styled);
					out.push(truncateToWidth(styled, width));
				}
			}
		});
		if (this.report.truncated || this.report.files.some((file) => file.truncated)) out.push(color(this.theme, "warning", "Safety limit reached; inspect the source diff instead of regenerating (same cap)."));
		return out;
	}

	render(width: number): string[] {
		this.width = Math.max(1, width);
		const rows = this.content(this.width).map((line) => truncateToWidth(line, this.width));
		const available = Math.max(1, Math.min(30, (Number(this.tui?.terminal?.rows) || 24) - 4));
		const bodyHeight = Math.max(1, available - 2);
		const maxOffset = Math.max(0, rows.length - bodyHeight);
		this.offset = Math.max(0, Math.min(this.offset, maxOffset));
		const body = rows.slice(this.offset, this.offset + bodyHeight);
		const footer = `Esc/q close · ↑↓/jk scroll · n/p/Tab file · Enter toggle · a all · PgUp/PgDn  ${rows.length ? `${this.offset + 1}-${Math.min(rows.length, this.offset + bodyHeight)}/${rows.length}` : ""}`;
		return [truncateToWidth(color(this.theme, "accent", safeLabel(this.title)), this.width), ...body, truncateToWidth(color(this.theme, "dim", footer), this.width)].slice(0, available);
	}

	handleInput(data: string): void {
		const count = this.report.files.length;
		if (matchesKey(data, "escape") || data === "q" || data === "Q") { this.done(); return; }
		if (matchesKey(data, "up") || data === "k") this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down") || data === "j") this.offset += 1;
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 10);
		else if (matchesKey(data, "pageDown")) this.offset += 10;
		else if (matchesKey(data, "tab") || data === "n") { if (count) { this.selected = (this.selected + 1) % count; this.offset = this.fileRow(this.selected); } }
		else if (matchesKey(data, "shift+tab") || data === "p") { if (count) { this.selected = (this.selected - 1 + count) % count; this.offset = this.fileRow(this.selected); } }
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = this.content(this.width).length;
		else if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "space")) {
			if (count) this.expanded[this.selected] = !this.expanded[this.selected];
		} else if (data === "a" || data === "A") {
			const expand = this.expanded.some((value) => !value);
			this.expanded = this.report.files.map(() => expand);
		} else return;
		this.tui?.requestRender?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") { this.offset = Math.max(0, this.offset + (event.wheelDelta ?? 0)); this.tui?.requestRender?.(); return { handled: true, render: true }; }
		if (event.type !== "click" || event.button !== "left") return undefined;
		const clicked = this.offset + event.y - 1;
		let file = -1;
		let row = 0;
		for (let i = 0; i < this.report.files.length; i++) {
			if (clicked === row) { file = i; break; }
			row += 1 + (this.expanded[i] ? (this.report.files[i]!.binary ? 1 : sanitize(this.report.files[i]!.patch).split(/\r?\n/).length) : 0);
		}
		if (file >= 0 && file < this.report.files.length) { this.selected = file; this.expanded[file] = !this.expanded[file]; this.tui?.requestRender?.(); return { handled: true, render: true }; }
		return undefined;
	}
	invalidate(): void {}
}


/** Open the complete, keyboard-navigable diff panel. */
export async function showDiff(ctx: any, report: DiffReport, title: string): Promise<void> {
	if (!ctx?.ui?.custom) return;
	await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new DiffPanel(tui, theme, done, report, title));
}
