/**
 * image-paste: images you paste or drop are attached to the message you send.
 *
 * 1. Attaching. Pi's Ctrl+V (and drag-and-drop) only types an image's file path into the editor.
 *    When you press Enter, image paths in the message become real attachments, the way Claude Code
 *    and Codex do it:
 *
 *      "what is wrong here? /var/folders/.../pi-clipboard-ab12.png"
 *        -> text "what is wrong here? [image 1: pi-clipboard-ab12.png]" + the image as base64
 *
 * 2. Cmd+V. A terminal cannot paste an image, so Cmd+V on an image-only clipboard sends nothing.
 *    Ghostty can be told to follow every Cmd+V with an empty bracketed paste (see the README).
 *    When one arrives and the clipboard holds only an image, it is saved and its path is inserted
 *    into the editor, exactly like Ctrl+V does. If the clipboard has text, the normal paste
 *    already happened and the empty paste is ignored.
 *
 * The original bytes are attached; Pi then shrinks them to the active model's limits (and honours
 * the images.autoResize setting). Attachments are stored in the session and resent with every
 * later turn, so very large screenshots add up. Only existing files that really are images are
 * attached. Messages from rpc or other extensions are left alone.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachImagePaths } from "./attach.ts";
import { EMPTY_PASTE, type SaveDeps, saveClipboardImage } from "./clipboard.ts";

// /reload re-runs this file in the same process: keep one listener, not one per reload.
const LISTENER = Symbol.for("pi-config.image-paste.listener");
const shared = globalThis as { [LISTENER]?: () => void };

export function createImagePaste(deps: SaveDeps = {}) {
	return function (pi: ExtensionAPI) {
		pi.on("input", async (event, ctx) => {
			if (event.source !== "interactive") return { action: "continue" };
			const existing = event.images ?? [];
			const result = await attachImagePaths(event.text, { firstNumber: existing.length + 1 });
			if (ctx.hasUI) for (const warning of result.warnings) ctx.ui.notify(warning, "warning");
			if (!result.images.length) return { action: "continue" };
			return { action: "transform", text: result.text, images: [...existing, ...result.images] };
		});

		pi.on("session_start", (_event, ctx) => {
			shared[LISTENER]?.();
			shared[LISTENER] = undefined;
			if (!ctx.hasUI) return;
			shared[LISTENER] = ctx.ui.onTerminalInput((data) => {
				if (data !== EMPTY_PASTE) return undefined;
				void (async () => {
					try {
						const path = await saveClipboardImage(deps);
						if (!path) return;
						const text = ctx.ui.getEditorText();
						ctx.ui.pasteToEditor(`${text && !/\s$/.test(text) ? " " : ""}${path} `);
					} catch (error) {
						ctx.ui.notify(`could not read the clipboard: ${error instanceof Error ? error.message : error}`, "error");
					}
				})();
				return { consume: true };
			});
		});
	};
}

export default createImagePaste();
