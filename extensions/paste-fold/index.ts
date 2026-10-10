/**
 * paste-fold: big pastes collapse in the editor until you click them.
 *
 *   > review this: [paste #1 2314 chars]      <- click the marker and the full text appears in place
 *
 * Pi already folds pastes of more than 10 lines or 1000 characters into a `[paste #N ...]` marker
 * (the full text is still what you send). This lowers the character limit to 500 and lets you
 * click a marker to expand it. Clicks only reach Pi in fullscreen mode (the default `tuiMode`);
 * in regular mode the terminal keeps the mouse. Expanding can be undone with Ctrl+Z.
 *
 * It wraps two methods of Pi's Editor, so it leans on Pi's marker bookkeeping (`pastes`,
 * `pasteCounter`, numbering that closes the gap when a marker goes away). If those internals
 * change shape, the wrappers hand everything back to Pi's original behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";

const LIMIT = 500; // collapse pastes longer than this many characters
const PI_LINE_LIMIT = 10; // Pi's own rules, which keep applying
const PI_CHAR_LIMIT = 1000;
const MARKER = /\[paste #(\d+)( (?:\+\d+ lines|\d+ chars))?\]/g;

// /reload re-runs this file in the same process, so keep Pi's untouched methods from the first load.
const KEY = Symbol.for("pi-config.paste-fold");
const shared = globalThis as { [KEY]?: { handlePaste: Function; handleMouse: Function } };
const proto = Editor.prototype as any;

/** The text Pi would insert for a paste: control characters stripped, line endings normalized. */
function cleaned(editor: any, raw: string): string | undefined {
	if (typeof editor.normalizeText !== "function") return undefined;
	// Some terminals re-encode control bytes in a paste as CSI-u sequences; Pi decodes them first.
	const decoded = raw.replace(/\x1b\[(\d+);5u/g, (match, code) => {
		const cp = Number(code);
		if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
		if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
		return match;
	});
	return editor.normalizeText(decoded).split("").filter((c: string) => c === "\n" || c.charCodeAt(0) >= 32).join("");
}

const hasEditorInternals = (e: any) =>
	e.pastes instanceof Map &&
	typeof e.pasteCounter === "number" &&
	typeof e.pushUndoSnapshot === "function" &&
	typeof e.insertTextAtCursorInternal === "function" &&
	typeof e.setCursorCol === "function" &&
	Array.isArray(e.state?.lines);

/** Fold a paste Pi would have inserted as plain text, using Pi's marker format. */
function fold(editor: any, text: string) {
	editor.cancelAutocomplete?.();
	editor.exitHistoryBrowsing?.();
	editor.lastAction = null;
	editor.pushUndoSnapshot();
	editor.pasteCounter++;
	const id = editor.pasteCounter;
	editor.pastes.set(id, text);
	editor.insertTextAtCursorInternal(`[paste #${id} ${text.length} chars]`);
}

/** Replace the marker under the cursor with its text, and close the numbering gap like Pi does on delete. */
function expandAtCursor(editor: any): boolean {
	const lineIndex: number = editor.state.cursorLine;
	const line: string = editor.state.lines[lineIndex] ?? "";
	const col: number = editor.state.cursorCol;
	for (const match of line.matchAll(MARKER)) {
		const start = match.index!;
		const end = start + match[0].length;
		const id = Number(match[1]);
		if (col < start || col >= end || !editor.pastes.has(id)) continue;

		const content: string = editor.pastes.get(id);
		editor.pushUndoSnapshot();
		editor.pastes.delete(id);
		editor.pasteCounter--;
		for (const higher of [...editor.pastes.keys()].filter((k: number) => k > id).sort((a: number, b: number) => a - b)) {
			editor.pastes.set(higher - 1, editor.pastes.get(higher));
			editor.pastes.delete(higher);
		}
		const renumber = (s: string) =>
			s.replace(MARKER, (full, n, suffix) => (Number(n) > id ? `[paste #${Number(n) - 1}${suffix ?? ""}]` : full));
		const before = renumber(line.slice(0, start));
		editor.state.lines = editor.state.lines.map((l: string, i: number) => (i === lineIndex ? before + renumber(line.slice(end)) : renumber(l)));
		editor.state.cursorLine = lineIndex;
		editor.setCursorCol(before.length);
		editor.insertTextAtCursorInternal(content); // multi-line aware, moves the cursor, fires onChange
		editor.invalidate?.();
		return true;
	}
	return false;
}

export default function (_pi: ExtensionAPI) {
	if (typeof proto.handlePaste !== "function" || typeof proto.handleMouse !== "function") return;
	const original = (shared[KEY] ??= { handlePaste: proto.handlePaste, handleMouse: proto.handleMouse });

	proto.handlePaste = function (this: any, pasted: string) {
		if (hasEditorInternals(this)) {
			const text = cleaned(this, pasted);
			// Only the gap Pi leaves: Pi already folds long and tall pastes, and short ones stay inline.
			if (text && text.length > LIMIT && text.length <= PI_CHAR_LIMIT && text.split("\n").length <= PI_LINE_LIMIT) {
				fold(this, text);
				return;
			}
		}
		return original.handlePaste.call(this, pasted);
	};

	proto.handleMouse = function (this: any, event: any) {
		const result = original.handleMouse.call(this, event);
		// Pi turns a click into a cursor position and treats a marker as one unit, so a click on a
		// marker leaves the cursor at its start. Rows 1..N are the text; row 0 is the border.
		if (
			event?.type === "click" &&
			event.button === "left" &&
			hasEditorInternals(this) &&
			event.y >= 1 &&
			event.y <= this.renderedVisibleLineCount
		) {
			expandAtCursor(this);
		}
		return result;
	};
}
