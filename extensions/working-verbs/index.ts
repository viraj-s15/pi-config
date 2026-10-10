/**
 * working-verbs: Claude Code style working indicator.
 *
 *   ✻ Flibbertigibbeting… (14s)
 *
 * A star spinner (· ✢ ✳ ✶ ✻ ✽ and back) plus a random verb, picked again for every model turn,
 * and an elapsed-seconds counter. Command: /verbs on|off
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const VERBS = [
	"Accomplishing", "Actioning", "Actualizing", "Baking", "Beaming", "Befuddling", "Billowing", "Blanching",
	"Bloviating", "Boogieing", "Boondoggling", "Booping", "Bootstrapping", "Brewing", "Burrowing", "Calculating",
	"Canoodling", "Caramelizing", "Cascading", "Catapulting", "Cerebrating", "Channeling", "Choreographing",
	"Churning", "Clauding", "Coalescing", "Cogitating", "Combobulating", "Composing", "Computing", "Concocting",
	"Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Crystallizing", "Cultivating",
	"Deciphering", "Deliberating", "Determining", "Dilly-dallying", "Discombobulating", "Doing", "Doodling",
	"Drizzling", "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting", "Envisioning", "Evaporating",
	"Fermenting", "Fiddle-faddling", "Finagling", "Flambeing", "Flibbertigibbeting", "Flowing", "Flummoxing",
	"Fluttering", "Forging", "Forming", "Frolicking", "Frosting", "Gallivanting", "Galloping", "Garnishing",
	"Generating", "Germinating", "Gitifying", "Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching",
	"Herding", "Honking", "Hullaballooing", "Hyperspacing", "Ideating", "Imagining", "Improvising", "Incubating",
	"Inferring", "Infusing", "Ionizing", "Jitterbugging", "Julienning", "Kneading", "Leavening", "Levitating",
	"Lollygagging", "Manifesting", "Marinating", "Meandering", "Metamorphosing", "Misting", "Moonwalking",
	"Moseying", "Mulling", "Mustering", "Musing", "Nebulizing", "Nesting", "Noodling", "Nucleating", "Orbiting",
	"Orchestrating", "Osmosing", "Perambulating", "Percolating", "Perusing", "Philosophising", "Photosynthesizing",
	"Pollinating", "Pondering", "Pontificating", "Pouncing", "Precipitating", "Prestidigitating", "Processing",
	"Proofing", "Propagating", "Puttering", "Puzzling", "Quantumizing", "Razzle-dazzling", "Razzmatazzing",
	"Recombobulating", "Reticulating", "Roosting", "Ruminating", "Sauteing", "Scampering", "Schlepping",
	"Scurrying", "Seasoning", "Shenaniganing", "Shimmying", "Simmering", "Skedaddling", "Sketching", "Slithering",
	"Smooshing", "Sock-hopping", "Spelunking", "Spinning", "Sprouting", "Stewing", "Sublimating", "Swirling",
	"Swooping", "Symbioting", "Synthesizing", "Tempering", "Thinking", "Thundering", "Tinkering", "Tomfoolering",
	"Topsy-turvying", "Transfiguring", "Transmuting", "Twisting", "Undulating", "Unfurling", "Unravelling",
	"Vibing", "Waddling", "Wandering", "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring", "Whisking",
	"Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
];

// Claude Code's star pulse: grow then shrink
const STARS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const ROSE = "\x1b[38;2;255;126;182m";
const DIM = "\x1b[38;2;141;145;153m";
const FG_RESET = "\x1b[39m";

const pick = (prev?: string) => {
	let v = VERBS[Math.floor(Math.random() * VERBS.length)]!;
	while (v === prev) v = VERBS[Math.floor(Math.random() * VERBS.length)]!;
	return v;
};

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let verb = "";
	let startedAt = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const message = () => {
		const s = Math.floor((Date.now() - startedAt) / 1000);
		return `${ROSE}${verb}…${FG_RESET} ${DIM}(${s}s)${FG_RESET}`;
	};

	const apply = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingIndicator({
			frames: STARS.map((s) => `${ROSE}${s}${FG_RESET}`),
			intervalMs: 140,
		});
	};

	const stop = (ctx: ExtensionContext) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	};

	pi.on("session_start", (_e, ctx) => {
		if (enabled) apply(ctx);
	});

	pi.on("agent_start", (_e, ctx) => {
		if (!enabled || !ctx.hasUI) return;
		verb = pick();
		startedAt = Date.now();
		ctx.ui.setWorkingMessage(message());
		if (timer) clearInterval(timer);
		timer = setInterval(() => ctx.ui.setWorkingMessage(message()), 1000);
	});

	// new verb for every model turn (each tool round trip), like Claude Code
	pi.on("message_start", (e, ctx) => {
		if (!enabled || !ctx.hasUI || !timer || e.message.role !== "assistant") return;
		verb = pick(verb);
		ctx.ui.setWorkingMessage(message());
	});

	pi.on("agent_end", (_e, ctx) => stop(ctx));
	pi.on("session_shutdown", (_e, ctx) => stop(ctx));

	pi.registerCommand("verbs", {
		description: "Claude Code style working indicator: on | off",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			enabled = a === "on" ? true : a === "off" ? false : !enabled;
			stop(ctx);
			if (enabled) apply(ctx);
			else ctx.ui.setWorkingIndicator();
			ctx.ui.notify(`working verbs ${enabled ? "on" : "off"}`, "info");
		},
	});
}
