import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";

export interface AttachedImage {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface AttachDeps {
	home?: string;
	/** Number of the first placeholder, when the message already carries images. */
	firstNumber?: number;
}

export interface AttachResult {
	text: string;
	images: AttachedImage[];
	warnings: string[];
}

export const MAX_IMAGES = 8;
// Pi shrinks prompt images to each model's limits after input handlers run, so the original bytes
// go through untouched. This only stops us reading something absurd into memory.
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SEND = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const LOOKBACK = 1024; // how far before an extension a path may start

/** Ends of every ".png/.jpg/.jpeg/.gif/.webp" that is not followed by more name characters. */
function extensionEnds(text: string): number[] {
	return [...text.matchAll(/\.(?:png|jpe?g|gif|webp)(?![\w-])/gi)].map((m) => m.index! + m[0].length);
}

/** Where an absolute or ~/ path could start: at the beginning, or after whitespace, a quote or a bracket. */
function isPathStart(text: string, i: number): boolean {
	const c = text[i];
	if (c !== "/" && !(c === "~" && text[i + 1] === "/")) return false;
	return i === 0 || /[\s'"(<[=]/.test(text[i - 1]!);
}

/** Terminals paste dropped files shell-escaped (`My\ Shot.png`); undo that. */
const unescape = (raw: string) => raw.replace(/\\(.)/gs, "$1");

const toPath = (raw: string, home: string) => {
	const p = unescape(raw);
	return p.startsWith("~/") ? join(home, p.slice(2)) : p;
};

async function isFile(path: string): Promise<number | undefined> {
	try {
		const s = await stat(path);
		return s.isFile() ? s.size : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Turn image file paths in a message into attached base64 images, leaving a numbered
 * placeholder in the text. Only existing files that really are images (checked by their
 * bytes, not their name) are attached; anything else stays exactly as typed.
 */
export async function attachImagePaths(text: string, deps: AttachDeps = {}): Promise<AttachResult> {
	const home = deps.home ?? homedir();
	const images: AttachedImage[] = [];
	const warnings: string[] = [];
	let out = "";
	let cursor = 0;
	let number = deps.firstNumber ?? 1;
	let capped = false;

	for (const end of extensionEnds(text)) {
		if (end <= cursor) continue;
		if (images.length >= MAX_IMAGES) {
			if (!capped) warnings.push(`only the first ${MAX_IMAGES} images were attached`);
			capped = true;
			break;
		}
		for (let start = Math.max(cursor, end - LOOKBACK); start < end; start++) {
			if (!isPathStart(text, start)) continue;
			const path = toPath(text.slice(start, end), home);
			const size = await isFile(path);
			if (size === undefined) continue;

			let mimeType: string | null = null;
			try {
				mimeType = (await detectSupportedImageMimeTypeFromFile(path)) ?? null;
			} catch {}
			if (!mimeType || !SEND.has(mimeType)) continue;

			const name = basename(path);
			if (size > MAX_FILE_BYTES) {
				warnings.push(`${name} is too large to attach (${(size / 1048576).toFixed(0)} MB)`);
				break;
			}
			const bytes = await readFile(path);
			images.push({ type: "image", data: bytes.toString("base64"), mimeType });
			// Matching quotes around the path belong to the path, not the sentence.
			const quote = text[start - 1];
			const quoted = start > cursor && (quote === "'" || quote === '"') && text[end] === quote;
			out += text.slice(cursor, quoted ? start - 1 : start) + `[image ${number++}: ${name}]`;
			cursor = quoted ? end + 1 : end;
			break;
		}
	}
	return { text: out + text.slice(cursor), images, warnings };
}
