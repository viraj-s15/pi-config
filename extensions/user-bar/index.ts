/**
 * user-bar: your sent messages get a blue left accent bar instead of a grey block.
 *
 *   ▎ can you make the todo line one row
 *   ▎ and move the subagents to the right
 *
 * Wraps UserMessageComponent.render: draws the message one column narrower, strips the theme's
 * userMessageBg, and puts the bar in front of every row of the message (wrapped rows included).
 * Sent messages over 500 characters get two preview rows plus a clickable Show more row.
 * This is display-only: the original text and Markdown children stay intact.
 * Toggles: /userbar [on|off] for the accent, /userfold [on|off] for folding.
 */

import { type ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BAR = "\x1b[38;2;120;169;255m▎\x1b[39m "; // oxocarbon blue
const BOLD = true; // bold text on your messages (set false for normal weight)
const KEY = Symbol.for("pi-config.user-bar");

interface FoldState {
	expanded: boolean;
	row: number;
	left: number;
	right: number;
}

interface Shared {
	enabled: boolean;
	folding?: boolean;
	folds?: WeakMap<object, FoldState>;
	ui?: { theme: { bg(name: string, text: string): string; fg(name: string, text: string): string } }; // live theme proxy
	original: (width: number) => string[];
	originalMouse?: (event: TuiMouseEvent) => ReturnType<UserMessageComponent["handleMouse"]>;
}

const proto = UserMessageComponent.prototype;
const g = globalThis as unknown as Record<symbol, Shared | undefined>;
// survive /reload: keep the very first (unpatched) render and a single shared state object
const shared: Shared = (g[KEY] ??= { enabled: true, original: proto.render });
shared.original ??= proto.render;
shared.originalMouse ??= proto.handleMouse;
shared.folding ??= true;
shared.folds ??= new WeakMap();

const ZONE = /\x1b\]133;[ABC]\x07/g;
const hasText = (line: string) => line.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "").trim() !== "";

/** Clip rendered rows, not the message. Keep Markdown, selection and session/model text unchanged. */
function foldRows(message: UserMessageComponent, original: string[], width: number, barWidth: number): string[] {
	const state = shared.folds!.get(message) ?? { expanded: false, row: -1, left: 0, right: 0 };
	shared.folds!.set(message, state);
	state.row = -1; // never leave a stale click target when folding is disabled or after a resize
	const { text, outputPad } = message as unknown as { text?: string; outputPad?: number };
	if (!shared.folding || width < 8 || typeof text !== "string" || text.length <= 500) return original;
	const first = original.findIndex(hasText);
	let last = original.length - 1;
	while (last >= 0 && !hasText(original[last]!)) last--;
	if (first < 0 || last - first + 1 <= 2) return original;

	// Prompt navigation boundaries must surround the shortened block, not disappear with hidden rows.
	const start = original.join("").match(/\x1b\]133;A\x07/g)?.join("") ?? "";
	const end = original.join("").match(/\x1b\]133;[BC]\x07/g)?.join("") ?? "";
	const lines = original.map(line => line.replace(ZONE, ""));
	const pad = Math.min(Math.max(0, outputPad ?? 1), Math.floor((width - 1) / 2));
	const label = state.expanded ? "▾ Show less" : `▸ Show more · ${text.length.toLocaleString("en-US")} characters`;
	const control = truncateToWidth(label, width - pad * 2);
	const controlLine = " ".repeat(pad) + control + " ".repeat(Math.max(0, width - pad - visibleWidth(control)));
	const styledControl = shared.ui
		? shared.ui.theme.bg("userMessageBg", shared.ui.theme.fg("accent", controlLine))
		: controlLine;
	const shown = state.expanded ? lines.slice(first, last + 1) : lines.slice(first, first + 2);
	const result = [...lines.slice(0, first), ...shown, styledControl, ...lines.slice(last + 1)];
	state.row = first + shown.length;
	state.left = barWidth + pad;
	state.right = state.left + visibleWidth(control);
	result[0] = start + result[0];
	result[result.length - 1] += end;
	return result;
}

// the escape sequence the current theme uses for userMessageBg (read on every render, so theme switches work)
function bgSequence(): string {
	try {
		const sample = shared.ui!.theme.bg("userMessageBg", "x");
		return sample.slice(0, sample.indexOf("x"));
	} catch {
		return "";
	}
}

proto.render = function (this: UserMessageComponent, width: number): string[] {
	const bar = shared.enabled && width >= 10;
	const innerWidth = width - (bar ? 2 : 0);
	const lines = foldRows(this, shared.original.call(this, innerWidth), innerWidth, bar ? 2 : 0);
	if (!bar) return lines;
	const seq = bgSequence();
	const clean = lines.map((l) => (seq ? l.split(seq).join("") : l));
	const first = clean.findIndex(hasText);
	let last = -1;
	for (let i = clean.length - 1; i >= 0; i--) if (hasText(clean[i]!)) { last = i; break; }
	return clean.map((l, i) => {
		if (i < first || i > last) return "  " + l;
		// bold is re-applied per row; "\x1b[22m" at the end keeps it from leaking into the next line
		return BAR + (BOLD ? `\x1b[1m${l}\x1b[22m` : l);
	});
};

proto.handleMouse = function (this: UserMessageComponent, event: TuiMouseEvent) {
	if (event.type === "click" && event.button === "left" && !event.shift && !event.alt && !event.ctrl) {
		this.render(event.width); // refresh local coordinates if resized since the previous render
		const state = shared.folds!.get(this);
		if (state && state.row >= 0 && event.y === state.row && event.x >= state.left && event.x < state.right) {
			state.expanded = !state.expanded;
			this.invalidate();
			// A Container handler returns its concrete target; preserve that dispatch contract.
			return { handled: true as const, render: true, target: {
				component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
				width: event.width, height: event.height,
			} }; // request a layout/render without stealing editor focus
		}
	}
	return shared.originalMouse?.call(this, event);
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		if (!ctx.hasUI) return;
		shared.ui = ctx.ui as Shared["ui"];
	});

	pi.registerCommand("userfold", {
		description: "Collapse long sent user messages: on | off (off shows full text without using the mouse)",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			shared.folding = a === "on" ? true : a === "off" ? false : !shared.folding;
			ctx.ui.notify(`sent-message folding ${shared.folding ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("userbar", {
		description: "Blue left bar on your sent messages instead of a grey block: on | off",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			shared.enabled = a === "on" ? true : a === "off" ? false : !shared.enabled;
			ctx.ui.notify(`user message bar ${shared.enabled ? "on" : "off"} (new messages now, /reload for old ones)`, "info");
		},
	});
}
