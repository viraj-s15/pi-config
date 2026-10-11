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

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachImagePaths } from "./attach.ts";
import { findImagePathSpans, removeImagePathAt } from "./chips.ts";
import { EMPTY_PASTE, type SaveDeps, saveClipboardImage } from "./clipboard.ts";

// /reload re-runs this file in the same process: keep one listener, not one per reload.
const LISTENER = Symbol.for("pi-config.image-paste.listener");
const shared = globalThis as { [LISTENER]?: () => void };

function inspectImagePath(path: string): string {
	const resolved = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	const type = /\.png$/i.test(resolved) ? "image/png" : /\.jpe?g$/i.test(resolved) ? "image/jpeg" : /\.gif$/i.test(resolved) ? "image/gif" : "image/webp";
	let details = "file not found";
	try {
		const info = statSync(resolved);
		details = info.isFile() ? `${(info.size / 1024).toFixed(1)} KB · ${type}` : "not a regular file";
	} catch {}
	return `${basename(resolved)}\n${resolved}\n${details}`;
}

export function createImagePaste(deps: SaveDeps = {}) {
	return function (pi: ExtensionAPI) {
		const manageAttachments = async (args: string, ctx: ExtensionContext) => {
				if (ctx.mode && ctx.mode !== "tui") return;
				const editorDraft = ctx.ui.getEditorText();
				const draft = editorDraft || args;
				// Slash commands are submitted after Pi clears the editor. Explicit arguments are
				// restored as an unsent draft; the shortcut operates on an existing draft directly.
				if (!editorDraft && args) ctx.ui.setEditorText(draft);
				const spans = findImagePathSpans(draft);
				if (!spans.length) {
					ctx.ui.notify("No image paths in the current draft.", "info");
					return;
				}
				const actions = spans.flatMap((span) => [
					{ label: `Inspect ${span.path}`, span, action: "inspect" as const },
					{ label: `Remove ${span.path}`, span, action: "remove" as const },
				]);
				const selected = await ctx.ui.select("/attachments", actions.map((item) => item.label));
				const choice = actions.find((item) => item.label === selected);
				if (!choice) return;
				if (choice.action === "inspect") {
					ctx.ui.notify(inspectImagePath(choice.span.path), "info");
					return;
				}
				ctx.ui.setEditorText(removeImagePathAt(draft, choice.span.start));
				ctx.ui.notify("Image path removed from the draft. Editor undo restores it.", "info");
		};
		pi.registerCommand("attachments", {
			description: "Inspect or remove draft image paths (Ctrl+Shift+I keeps the current draft)",
			handler: manageAttachments,
		});
		pi.registerShortcut("ctrl+shift+i", {
			description: "Inspect or remove image attachments in the current draft",
			handler: ctx => manageAttachments("", ctx),
		});

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
