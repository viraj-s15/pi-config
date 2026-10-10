import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getNativeClipboard } from "@earendil-works/pi-tui";

/** What a terminal sends for a paste with no text, e.g. Cmd+V on an image-only clipboard when Ghostty is set to chain it. */
export const EMPTY_PASTE = "\x1b[200~\x1b[201~";

export interface ClipboardReader {
	getText(): Promise<string | null | undefined>;
	getImage(): Promise<Uint8Array | null | undefined>;
	getFilePaths?(): Promise<string[] | null | undefined>;
}

export interface SaveDeps {
	/** Omit for the real system clipboard; null means there is none. */
	clipboard?: ClipboardReader | null;
	dir?: string;
	/** Turn an unsupported image format (macOS screenshots can be TIFF) into PNG bytes. */
	convert?: (bytes: Uint8Array) => Promise<Uint8Array | undefined>;
}

export const realClipboard = (): ClipboardReader | undefined => getNativeClipboard();

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** Image format from the leading bytes. Only formats the models accept. */
function sniff(b: Uint8Array): { ext: string } | undefined {
	if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png" };
	if (startsWith(b, [0xff, 0xd8, 0xff])) return { ext: "jpg" };
	if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return { ext: "gif" };
	if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return { ext: "webp" };
	return undefined;
}

async function convertWithSips(bytes: Uint8Array): Promise<Uint8Array | undefined> {
	if (process.platform !== "darwin") return undefined;
	const work = mkdtempSync(join(tmpdir(), "pi-clip-convert-"));
	try {
		const input = join(work, "in");
		const output = join(work, "out.png");
		writeFileSync(input, bytes);
		await promisify(execFile)("sips", ["-s", "format", "png", input, "--out", output], { timeout: 10_000 });
		return new Uint8Array(readFileSync(output));
	} catch {
		return undefined;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * If the clipboard holds only an image, save it to a private temp file and return its path.
 * Returns undefined when there is nothing to do: text or copied files on the clipboard were
 * already pasted by the terminal. Reads run one at a time, because the macOS pasteboard
 * aborts the whole process when two reads overlap.
 */
export async function saveClipboardImage(deps: SaveDeps = {}): Promise<string | undefined> {
	const clipboard = deps.clipboard === undefined ? realClipboard() : deps.clipboard;
	if (!clipboard) return undefined;
	if ((await clipboard.getText())?.length) return undefined;
	if ((await clipboard.getFilePaths?.())?.length) return undefined;
	let bytes = await clipboard.getImage();
	if (!bytes?.length) return undefined;

	let format = sniff(bytes);
	if (!format) {
		const converted = await (deps.convert ?? convertWithSips)(bytes);
		format = converted && sniff(converted);
		if (!converted || !format) return undefined;
		bytes = converted;
	}
	const path = join(deps.dir ?? tmpdir(), `pi-clipboard-${randomUUID()}.${format.ext}`);
	writeFileSync(path, bytes, { mode: 0o600 });
	return path;
}
