/**
 * user-bar: your sent messages get a blue left accent bar instead of a grey block.
 *
 *   ▎ can you make the todo line one row
 *   ▎ and move the subagents to the right
 *
 * Wraps UserMessageComponent.render: draws the message one column narrower, strips the theme's
 * userMessageBg, and puts the bar in front of every row of the message (wrapped rows included).
 * Toggle: /userbar [on|off]. New renders follow the setting; /reload redraws old ones.
 */

import { type ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent";

const BAR = "\x1b[38;2;120;169;255m▎\x1b[39m "; // oxocarbon blue
const BOLD = true; // bold text on your messages (set false for normal weight)
const KEY = Symbol.for("pi-config.user-bar");

interface Shared {
	enabled: boolean;
	ui?: { theme: { bg(name: string, text: string): string } }; // live theme proxy: follows theme switches
	original: (width: number) => string[];
}

const proto = UserMessageComponent.prototype as unknown as { render: (width: number) => string[] };
const g = globalThis as unknown as Record<symbol, Shared | undefined>;
// survive /reload: keep the very first (unpatched) render and a single shared state object
const shared: Shared = (g[KEY] ??= { enabled: true, original: proto.render });
shared.original ??= proto.render;

// the escape sequence the current theme uses for userMessageBg (read on every render, so theme switches work)
function bgSequence(): string {
	try {
		const sample = shared.ui!.theme.bg("userMessageBg", "x");
		return sample.slice(0, sample.indexOf("x"));
	} catch {
		return "";
	}
}

proto.render = function (this: unknown, width: number): string[] {
	if (!shared.enabled || width < 10) return shared.original.call(this, width);
	const lines = shared.original.call(this, width - 2);
	const seq = bgSequence();
	const clean = lines.map((l) => (seq ? l.split(seq).join("") : l));
	const text = (l: string) => l.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "").trim() !== "";
	const first = clean.findIndex(text);
	let last = -1;
	for (let i = clean.length - 1; i >= 0; i--) if (text(clean[i]!)) { last = i; break; }
	return clean.map((l, i) => {
		if (i < first || i > last) return "  " + l;
		// bold is re-applied per row; "\x1b[22m" at the end keeps it from leaking into the next line
		return BAR + (BOLD ? `\x1b[1m${l}\x1b[22m` : l);
	});
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		if (!ctx.hasUI) return;
		shared.ui = ctx.ui as Shared["ui"];
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
