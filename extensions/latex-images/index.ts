/**
 * latex-images: render LaTeX math in pi's transcript as real images.
 *
 * Pipeline: LaTeX --MathJax--> SVG --resvg--> PNG --Kitty graphics--> terminal.
 * Images are drawn with Kitty *unicode placeholders* (U+10EEEE + row/column diacritics), so they are
 * ordinary text cells to pi's markdown wrapping, scrolling and resizing, and can sit inside a line.
 *
 *   $x^2$  \(x^2\)        inline, one text row tall
 *   $$...$$  \[...\]      display, centered block (multi-row)
 *
 * Needs a terminal with Kitty graphics + unicode placeholders (Ghostty, Kitty). Otherwise this does
 * nothing and pi's built-in Unicode math rendering stays in charge. Unsupported LaTeX also falls back.
 *
 * Commands: /latex [on|off]  toggle (affects newly rendered messages)
 * Env:      PI_LATEX_IMAGES=0 disables at startup, PI_LATEX_COLOR=#rrggbb sets the equation color.
 */

import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";

const COLOR = process.env.PI_LATEX_COLOR ?? "#dde1e6";
const SUPERSAMPLE = 2; // render PNGs at 2x the cell size; the terminal scales them down
const PLACEHOLDER = "\u{10EEEE}";
const NBSP = "\u00a0";

// Row/column diacritics from kitty's rowcolumn-diacritics.txt (297 entries).
const DIAC = [
	0x305,0x30d,0x30e,0x310,0x312,0x33d,0x33e,0x33f,0x346,0x34a,0x34b,0x34c,0x350,0x351,0x352,0x357,0x35b,0x363,
	0x364,0x365,0x366,0x367,0x368,0x369,0x36a,0x36b,0x36c,0x36d,0x36e,0x36f,0x483,0x484,0x485,0x486,0x487,0x592,
	0x593,0x594,0x595,0x597,0x598,0x599,0x59c,0x59d,0x59e,0x59f,0x5a0,0x5a1,0x5a8,0x5a9,0x5ab,0x5ac,0x5af,0x5c4,
	0x610,0x611,0x612,0x613,0x614,0x615,0x616,0x617,0x657,0x658,0x659,0x65a,0x65b,0x65d,0x65e,0x6d6,0x6d7,0x6d8,
	0x6d9,0x6da,0x6db,0x6dc,0x6df,0x6e0,0x6e1,0x6e2,0x6e4,0x6e7,0x6e8,0x6eb,0x6ec,0x730,0x732,0x733,0x735,0x736,
	0x73a,0x73d,0x73f,0x740,0x741,0x743,0x745,0x747,0x749,0x74a,0x7eb,0x7ec,0x7ed,0x7ee,0x7ef,0x7f0,0x7f1,0x7f3,
	0x816,0x817,0x818,0x819,0x81b,0x81c,0x81d,0x81e,0x81f,0x820,0x821,0x822,0x823,0x825,0x826,0x827,0x829,0x82a,
	0x82b,0x82c,0x82d,0x951,0x953,0x954,0xf82,0xf83,0xf86,0xf87,0x135d,0x135e,0x135f,0x17dd,0x193a,0x1a17,0x1a75,
	0x1a76,0x1a77,0x1a78,0x1a79,0x1a7a,0x1a7b,0x1a7c,0x1b6b,0x1b6d,0x1b6e,0x1b6f,0x1b70,0x1b71,0x1b72,0x1b73,
	0x1cd0,0x1cd1,0x1cd2,0x1cda,0x1cdb,0x1ce0,0x1dc0,0x1dc1,0x1dc3,0x1dc4,0x1dc5,0x1dc6,0x1dc7,0x1dc8,0x1dc9,
	0x1dcb,0x1dcc,0x1dd1,0x1dd2,0x1dd3,0x1dd4,0x1dd5,0x1dd6,0x1dd7,0x1dd8,0x1dd9,0x1dda,0x1ddb,0x1ddc,0x1ddd,
	0x1dde,0x1ddf,0x1de0,0x1de1,0x1de2,0x1de3,0x1de4,0x1de5,0x1de6,0x1dfe,0x20d0,0x20d1,0x20d4,0x20d5,0x20d6,
	0x20d7,0x20db,0x20dc,0x20e1,0x20e7,0x20e9,0x20f0,0x2cef,0x2cf0,0x2cf1,0x2de0,0x2de1,0x2de2,0x2de3,0x2de4,
	0x2de5,0x2de6,0x2de7,0x2de8,0x2de9,0x2dea,0x2deb,0x2dec,0x2ded,0x2dee,0x2def,0x2df0,0x2df1,0x2df2,0x2df3,
	0x2df4,0x2df5,0x2df6,0x2df7,0x2df8,0x2df9,0x2dfa,0x2dfb,0x2dfc,0x2dfd,0x2dfe,0x2dff,0xa66f,0xa67c,0xa67d,
	0xa6f0,0xa6f1,0xa8e0,0xa8e1,0xa8e2,0xa8e3,0xa8e4,0xa8e5,0xa8e6,0xa8e7,0xa8e8,0xa8e9,0xa8ea,0xa8eb,0xa8ec,
	0xa8ed,0xa8ee,0xa8ef,0xa8f0,0xa8f1,0xaab0,0xaab2,0xaab3,0xaab7,0xaab8,0xaabe,0xaabf,0xaac1,0xfe20,0xfe21,
	0xfe22,0xfe23,0xfe24,0xfe25,0xfe26,0x10a0f,0x10a38,0x1d185,0x1d186,0x1d187,0x1d188,0x1d189,0x1d1aa,0x1d1ab,
	0x1d1ac,0x1d1ad,0x1d242,0x1d243,0x1d244
].map((c) => String.fromCodePoint(Number(c)));

// ---------- MathJax (lazy) ----------
let mj: { doc: any; adaptor: any } | undefined;
function engine() {
	if (!mj) {
		const adaptor = liteAdaptor();
		RegisterHTMLHandler(adaptor);
		const doc = mathjax.document("", {
			InputJax: new TeX({
				packages: AllPackages,
				formatError: (_jax: unknown, err: Error) => {
					throw err;
				},
			}),
			OutputJax: new SVG({ fontCache: "none" }),
		});
		mj = { doc, adaptor };
	}
	return mj;
}

interface Svg {
	inner: string; // everything inside <svg>…</svg>
	minX: number;
	minY: number;
	w: number; // viewBox units: 1000 = 1em
	h: number;
	attrs: string; // namespace attrs to keep
}

function texToSvg(tex: string, display: boolean): Svg | undefined {
	try {
		const { doc, adaptor } = engine();
		const html: string = adaptor.innerHTML(doc.convert(tex, { display }));
		if (html.includes("data-mjx-error")) return undefined;
		const m = /<svg([^>]*)>([\s\S]*)<\/svg>/.exec(html);
		if (!m) return undefined;
		const vb = /viewBox="([-\d.\s]+)"/.exec(m[1]!);
		if (!vb) return undefined;
		const [minX, minY, w, h] = vb[1]!.trim().split(/\s+/).map(Number) as [number, number, number, number];
		if (!(w > 0 && h > 0)) return undefined;
		const attrs = [...m[1]!.matchAll(/(xmlns(?::\w+)?)="([^"]*)"/g)].map((a) => `${a[1]}="${a[2]}"`).join(" ");
		return { inner: m[2]!.replaceAll("currentColor", COLOR), minX, minY, w, h, attrs };
	} catch {
		return undefined;
	}
}

// ---------- image placement ----------
interface Placed {
	rows: string[]; // placeholder text, one string per terminal row (no padding)
	cols: number;
}

const cache = new Map<string, Placed | null>();
let nextId = 0x100000 + Math.floor(Math.random() * 0xa00000); // 24-bit ids, random start per process
const allocId = () => (nextId = nextId >= 0xfffff0 ? 0x100000 : nextId + 1);

function transmit(id: number, png: Buffer, cols: number, rows: number): void {
	const b64 = png.toString("base64");
	const CHUNK = 4096;
	let out = "";
	for (let i = 0; i < b64.length; i += CHUNK) {
		const more = i + CHUNK < b64.length ? 1 : 0;
		const head = i === 0 ? `a=T,U=1,f=100,i=${id},c=${cols},r=${rows},q=2,m=${more}` : `m=${more}`;
		out += `\x1b_G${head};${b64.slice(i, i + CHUNK)}\x1b\\`;
	}
	process.stdout.write(out);
}

function place(tex: string, display: boolean, maxCols: number): Placed | undefined {
	const cell = getCellDimensions();
	const key = createHash("sha1").update(`${display}|${maxCols}|${cell.widthPx}x${cell.heightPx}|${COLOR}|${tex}`).digest("hex");
	const hit = cache.get(key);
	if (hit !== undefined) return hit ?? undefined;

	const svg = texToSvg(tex, display);
	if (!svg) {
		cache.set(key, null);
		return undefined;
	}

	// size: 1em of math ≈ one terminal font size
	let emPx = cell.heightPx * (display ? 0.95 : 0.8);
	let wPx = (svg.w / 1000) * emPx;
	let hPx = (svg.h / 1000) * emPx;
	if (!display) {
		const fit = Math.min(1, (cell.heightPx * 0.98) / hPx);
		emPx *= fit;
		wPx *= fit;
		hPx *= fit;
	}
	const widthLimit = Math.max(2, maxCols) * cell.widthPx;
	if (wPx > widthLimit) {
		const fit = widthLimit / wPx;
		emPx *= fit;
		wPx *= fit;
		hPx *= fit;
	}
	const cols = Math.max(1, Math.ceil(wPx / cell.widthPx));
	const rows = display ? Math.max(1, Math.ceil(hPx / cell.heightPx)) : 1;
	if (cols > DIAC.length || rows > DIAC.length) {
		cache.set(key, null);
		return undefined;
	}

	// canvas = whole cell grid; the equation sits centered horizontally, and
	// vertically on the text baseline for inline math (centered for display math)
	const S = SUPERSAMPLE;
	const canvasW = cols * cell.widthPx * S;
	const canvasH = rows * cell.heightPx * S;
	const x = (canvasW - wPx * S) / 2;
	let y = (canvasH - hPx * S) / 2;
	if (!display) {
		const ascent = (-svg.minY / 1000) * emPx; // px above baseline
		const baseline = cell.heightPx * 0.78;
		y = Math.min(Math.max(baseline - ascent, 0), cell.heightPx - hPx) * S;
	}
	const doc =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">` +
		`<svg ${svg.attrs} x="${x}" y="${y}" width="${wPx * S}" height="${hPx * S}" viewBox="${svg.minX} ${svg.minY} ${svg.w} ${svg.h}">${svg.inner}</svg></svg>`;

	let png: Buffer;
	try {
		png = new Resvg(doc, { font: { loadSystemFonts: false }, fitTo: { mode: "original" } }).render().asPng();
	} catch {
		cache.set(key, null);
		return undefined;
	}

	const id = allocId();
	transmit(id, png, cols, rows);
	const fgSgr = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
	const out: string[] = [];
	for (let r = 0; r < rows; r++) {
		let line = "";
		for (let c = 0; c < cols; c++) line += PLACEHOLDER + DIAC[r] + DIAC[c];
		out.push(`${fgSgr}${line}\x1b[39m`);
	}
	const placed = { rows: out, cols };
	cache.set(key, placed);
	if (cache.size > 500) cache.delete(cache.keys().next().value!);
	return placed;
}

// ---------- markdown scanning ----------
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function findClose(s: string, close: string, from: number): number {
	for (let i = s.indexOf(close, from); i >= 0; i = s.indexOf(close, i + 1)) {
		let bs = 0;
		for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) bs++;
		if (bs % 2 === 0) return i;
	}
	return -1;
}

function transformChunk(s: string, availableWidth: number): string {
	let out = "";
	let i = 0;
	const n = s.length;
	const maxCols = Math.max(4, availableWidth - 2);

	const render = (tex: string, display: boolean, endIdx: number): boolean => {
		const body = tex.trim();
		if (!body) return false;
		// block only when the math owns its line(s)
		const lineStart = out.lastIndexOf("\n") + 1;
		const before = out.slice(lineStart);
		let k = endIdx;
		while (k < n && (s[k] === " " || s[k] === "\t")) k++;
		const ownsLine = display && /^ {0,3}$/.test(before) && (k >= n || s[k] === "\n");
		const placed = place(body, ownsLine, maxCols);
		if (!placed) return false;
		if (ownsLine) {
			const pad = NBSP.repeat(Math.max(0, Math.floor((availableWidth - placed.cols) / 2)));
			out = out.slice(0, lineStart);
			if (out && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
			out += placed.rows.map((r) => pad + r).join("\n") + "\n\n";
			i = k < n ? k + 1 : k;
		} else {
			out += placed.rows[0];
			i = endIdx;
		}
		return true;
	};

	while (i < n) {
		const c = s[i]!;
		if (c === "\\") {
			if (s[i + 1] === "[" || s[i + 1] === "(") {
				const close = s[i + 1] === "[" ? "\\]" : "\\)";
				const end = findClose(s, close, i + 2);
				if (end > 0 && render(s.slice(i + 2, end), s[i + 1] === "[", end + 2)) continue;
			}
			out += s.slice(i, i + 2);
			i += 2;
		} else if (c === "`") {
			let k = i;
			while (s[k] === "`") k++;
			const run = s.slice(i, k);
			const end = s.indexOf(run, k);
			const stop = end >= 0 ? end + run.length : k;
			out += s.slice(i, stop);
			i = stop;
		} else if (c === "$") {
			if (s[i + 1] === "$") {
				const end = findClose(s, "$$", i + 2);
				if (end > 0 && render(s.slice(i + 2, end), true, end + 2)) continue;
				out += "$$";
				i += 2;
				continue;
			}
			const end = findClose(s, "$", i + 1);
			const body = end > 0 ? s.slice(i + 1, end) : "";
			const ok =
				end > 0 &&
				body.length > 0 &&
				!body.includes("\n") &&
				!isSpace(s[i + 1]) &&
				!isSpace(s[end - 1]) &&
				!/\d/.test(s[end + 1] ?? "");
			if (ok && render(body, false, end + 1)) continue;
			out += c;
			i++;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

function transform(markdown: string, availableWidth: number): string {
	if (!markdown.includes("$") && !markdown.includes("\\[") && !markdown.includes("\\(")) return markdown;
	// keep fenced code blocks untouched
	const lines = markdown.split("\n");
	const result: string[] = [];
	let chunk: string[] = [];
	let fence: string | undefined;
	const flush = () => {
		if (chunk.length) result.push(transformChunk(chunk.join("\n"), availableWidth));
		chunk = [];
	};
	for (const line of lines) {
		const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			result.push(line);
			if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = undefined;
		} else if (m) {
			flush();
			fence = m[1];
			result.push(line);
		} else chunk.push(line);
	}
	flush();
	return result.join("\n");
}

// ---------- extension ----------
export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_LATEX_IMAGES !== "0";

	pi.registerMarkdownTransformer((markdown, ctx) => {
		if (!enabled) return markdown;
		const caps = getCapabilities();
		if (caps.images !== "kitty") return markdown;
		try {
			return transform(markdown, ctx.availableWidth);
		} catch {
			return markdown;
		}
	});

	pi.registerCommand("latex", {
		description: "Toggle LaTeX-as-image rendering (on/off); applies to newly rendered messages",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			enabled = a === "on" ? true : a === "off" ? false : !enabled;
			const caps = getCapabilities();
			ctx.ui.notify(
				`latex images ${enabled ? "on" : "off"}${enabled && caps.images !== "kitty" ? " (terminal has no Kitty graphics: using Unicode fallback)" : ""}`,
				"info",
			);
		},
	});
}
