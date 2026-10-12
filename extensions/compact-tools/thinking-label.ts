import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

/**
 * Hidden-thinking rows say what happened: "● thinking…" while the model thinks, "● thought" once the
 * answer or a tool call has begun, and "● thought 14s" when the reply is done.
 *
 * Pi keeps one label for every row, so this sets each row's label as Pi rebuilds it. Messages carry no
 * timing of their own: a reply's start is message.timestamp, its end is recorded live at message_end
 * (extensions see it before the row is redrawn) or read from the session file for saved chats. A reply
 * that also wrote text or tool arguments only gets its thinking share of that time, by token count.
 */

// Reload-safe: the wrapper on the prototype stays, each load swaps in its own state and code.
const KEY = Symbol.for("pi-config.compact-tools.thinking-label");
const PURPLE = "\x1b[38;2;190;149;255m";

interface Message {
	role?: string;
	timestamp?: number;
	content?: Array<{ type: string; text?: string; thinking?: string }>;
	usage?: { output?: number; reasoning?: number };
}

interface State {
	enabled: boolean;
	ends: Map<number, number>; // message.timestamp -> when the reply finished
	original: (this: any, message: Message, isStreaming?: boolean) => void;
	wrapper: (this: any, message: Message, isStreaming?: boolean) => void;
	label: (message: Message, streaming: boolean) => string | undefined;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function thinkingMs(message: Message, ends: Map<number, number>): number | undefined {
	const start = message.timestamp;
	const end = start === undefined ? undefined : ends.get(start);
	if (start === undefined || end === undefined || !(end > start)) return undefined;
	const duration = end - start;
	const output = message.usage?.output;
	const reasoning = message.usage?.reasoning;
	if (Number.isFinite(output) && Number.isFinite(reasoning) && output! > 0 && reasoning! > 0 && reasoning! <= output!) {
		return duration * (reasoning! / output!);
	}
	const onlyThought = (message.content ?? []).every((block) => block.type === "thinking");
	return onlyThought ? duration : undefined; // otherwise the split is unknown: no number rather than a wrong one
}

function labelFor(ends: Map<number, number>) {
	return (message: Message, streaming: boolean): string | undefined => {
		const content = message.content ?? [];
		const thinkingAt = content.findIndex((block) => block.type === "thinking");
		if (thinkingAt < 0) return undefined;
		const dot = `${PURPLE}●\x1b[39m`;
		const movedOn = content.slice(thinkingAt + 1).some((block) => block.type === "toolCall" || (block.type === "text" && block.text?.trim()));
		if (streaming) return movedOn ? `${dot} thought` : `${dot} thinking…`;
		const ms = thinkingMs(message, ends);
		return ms === undefined ? `${dot} thought` : `${dot} thought ${formatDuration(ms)}`;
	};
}

export function installThinkingLabels(): {
	setEnabled(enabled: boolean): void;
	/** Rebuild reply end times from a session's entries (startup, resume, reload). */
	indexSession(entries: ReadonlyArray<any>): void;
	/** A live reply just finished. */
	recordEnd(message: Message, now?: number): void;
} {
	const proto = AssistantMessageComponent.prototype as any;
	let state = proto[KEY] as State | undefined;
	if (!state || proto.updateContent !== state.wrapper) {
		const previous = state;
		state = {
			enabled: previous?.enabled ?? false,
			ends: previous?.ends ?? new Map(),
			original: proto.updateContent,
			wrapper: undefined as never,
			label: undefined as never,
		};
		const current = state;
		state.wrapper = function (this: any, message: Message, isStreaming?: boolean) {
			const streaming = isStreaming ?? this.isStreaming ?? false;
			if (current.enabled && message) {
				const label = current.label(message, streaming);
				if (label) this.hiddenThinkingLabel = label;
			}
			return current.original.call(this, message, isStreaming);
		};
		proto.updateContent = state.wrapper;
		proto[KEY] = state;
	}
	const current = state;
	current.label = labelFor(current.ends);

	return {
		setEnabled(enabled) { current.enabled = enabled; },
		indexSession(entries) {
			current.ends.clear();
			for (const entry of entries) {
				const message = entry?.type === "message" ? entry.message as Message : undefined;
				if (message?.role !== "assistant" || typeof message.timestamp !== "number") continue;
				const end = Date.parse(entry.timestamp);
				if (Number.isFinite(end)) current.ends.set(message.timestamp, end);
			}
		},
		recordEnd(message, now = Date.now()) {
			if (typeof message.timestamp === "number") current.ends.set(message.timestamp, now);
		},
	};
}
