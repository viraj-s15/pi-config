import { Container, MouseRegion, Spacer, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { commandProgram } from "./summaries.ts";
import { foldThinking, replyTimes, thinkingOf, thinkingRealMessage, unfoldAllThinking } from "./thinking-label.ts";

// v2 holds the state of this version. The unversioned key belonged to earlier versions of this file:
// the first only tracked parents and never patched render, the second patched render with a closure
// that a /reload cannot reach. Both can still be sitting on Container.prototype in a long-lived Pi.
const GROUPING = Symbol.for("pi-config.compact-tools.grouping.v2");
const LEGACY_GROUPING = Symbol.for("pi-config.compact-tools.grouping");
const OBSERVED_RESULT = Symbol.for("pi-config.compact-tools.observed-result");

/** Runtime-only fields used for display projection; Pi keeps these private in its declaration. */
interface ToolExecutionRuntimeAdapter {
	expanded: boolean;
	isPartial: boolean;
	result?: { isError?: boolean };
	toolCallId: string;
	toolName: string;
	args?: Record<string, unknown>;
	rendererState?: Record<PropertyKey, unknown>;
	ui?: { requestRender?: () => void };
}

interface AssistantRuntimeAdapter {
	lastMessage?: { content?: Array<{ type: string; text?: string; thinking?: string }>; stopReason?: string; timestamp?: number };
}

interface GroupingState {
	enabled: boolean;
	activeToolCallIds: Set<string>;
	/** Assistant replies of the run in progress (by message timestamp): their stretch stays live. */
	activeMessages?: Set<number>;
	/** Lines opened or closed by a click, keyed by the stretch's first row. */
	opened?: WeakMap<object, boolean>;
	requestRender?: () => void;
	/** The untouched Container.prototype.render underneath our wrapper. */
	original: Container["render"];
	/** The function installed on the prototype. It never changes, so /reload can find it again. */
	wrapper: Container["render"];
	/** Replaced on every load, so a /reload runs the new code instead of the first version's closure. */
	render: (this: Container, width: number) => string[];
}

function runtimeOf(row: ToolExecutionComponent): ToolExecutionRuntimeAdapter {
	return row as unknown as ToolExecutionRuntimeAdapter;
}

const TITLES: Record<string, string> = { bash: "Bash", read: "Read", edit: "Update", write: "Write", grep: "Search", find: "Find", ls: "List" };
const titleOf = (tool: string) => TITLES[tool] ?? tool.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const fg = (rgb: [number, number, number], text: string) => `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
const OK: [number, number, number] = [0x42, 0xbe, 0x65];
const ERR: [number, number, number] = [0xfa, 0x4d, 0x56];
const TEXT: [number, number, number] = [0xdd, 0xe1, 0xe6];
const DIM: [number, number, number] = [0x8d, 0x91, 0x99];

const RAIL = "\x1b[38;2;72;74;80m│\x1b[39m ";
const FAINT = "\x1b[2m";
/** Dim a rendered line, re-applying faint after any reset inside it. */
const faint = (line: string) => `${FAINT}${line.replace(/\x1b\[(?:0|22)?m/g, (reset) => reset + FAINT)}\x1b[22m`;

function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** One truncated line; MouseRegion supplies the click handling. */
class HeaderLine implements Component {
	constructor(private readonly build: () => string) {}
	render(width: number): string[] {
		return [truncateToWidth(this.build(), width)];
	}
	invalidate(): void {}
}

/** "Tests 228 passed 0 failed · rg ×2 · sed · Read ×3": recognised results first, then what ran. */
function describeTools(tools: ToolExecutionComponent[]): string {
	const highlights: string[] = [];
	const counts = new Map<string, number>();
	for (const tool of tools) {
		const runtime = runtimeOf(tool);
		const observed = runtime.rendererState?.[OBSERVED_RESULT];
		if (runtime.toolName === "bash" && typeof observed === "string" && observed) {
			if (!highlights.includes(observed)) highlights.push(observed);
			continue;
		}
		const command = runtime.args?.command;
		const program = runtime.toolName === "bash" && typeof command === "string" ? commandProgram(command) : undefined;
		const title = program ?? titleOf(runtime.toolName);
		counts.set(title, (counts.get(title) ?? 0) + 1);
	}
	return [...highlights, ...[...counts].map(([title, count]) => (count > 1 ? `${title} ×${count}` : title))].join(" · ");
}

/** "thought 42s" over every thinking row of the stretch, or just "thought" when no time is known. */
function describeThinking(rows: object[]): string {
	let has = false;
	let ms = 0;
	let known = false;
	for (const row of rows) {
		const thinking = thinkingOf(row);
		if (!thinking.has) continue;
		has = true;
		if (thinking.ms !== undefined) { ms += thinking.ms; known = true; }
	}
	if (!has) return "";
	if (!known) return "thought";
	const seconds = Math.max(1, Math.round(ms / 1000));
	return `thought ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`}`;
}

/**
 * One line standing in for a finished stretch of work: tool calls, thinking rows, and the thinking at
 * the top of the answer that follows (`answer`). Display-only; the chat keeps its real children.
 */
export class ToolGroupComponent extends Container {
	private readonly items: Component[];
	private readonly tools: ToolExecutionComponent[];
	private readonly header: MouseRegion;

	constructor(
		items: Component[],
		private readonly state: GroupingState,
		private readonly answer?: Component,
		/** The reply right after the run, thinking or not: the run's time runs until it is done. */
		private readonly reply?: Component,
	) {
		super();
		this.items = items;
		this.tools = items.filter((item): item is ToolExecutionComponent => item instanceof ToolExecutionComponent);
		this.header = new MouseRegion(
			new HeaderLine(() => {
				const count = this.tools.length;
				const failed = this.tools.filter((tool) => runtimeOf(tool).result?.isError === true).length;
				const replies = [...this.items.filter((item) => item instanceof AssistantMessageComponent), ...(this.answer ? [this.answer] : [])];
				const thought = describeThinking(replies);
				const arrow = ` ${fg(OK, this.expanded ? "▾" : "▸")}`;
				// Only thinking (before an answer): keep it short.
				if (!count && !this.items.some(isNote)) return `${arrow}${fg(DIM, ` ${thought || "thought"}`)}`;
				const parts: string[] = [];
				const worked = this.duration(this.reply && !replies.includes(this.reply) ? [...replies, this.reply] : replies);
				if (worked) parts.push(fg(TEXT, worked));
				if (count) parts.push(fg(DIM, `${count} tool call${count === 1 ? "" : "s"}`) + (failed ? ` ${fg(ERR, `(${failed} failed)`)}` : ""));
				const what = describeTools(this.tools);
				const rest = [thought, what].filter(Boolean).join(" · ");
				if (rest) parts.push(fg(DIM, rest));
				return `${arrow} ${parts.join(fg(DIM, " · "))}`;
			}),
			(event: TuiMouseEvent) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.state.opened!.set(this.key, !this.expanded);
				const ui = this.tools[0] ? runtimeOf(this.tools[0]).ui : undefined;
				if (ui?.requestRender) ui.requestRender.call(ui);
				else this.state.requestRender?.();
				return { handled: true, render: true };
			},
		);
	}

	/** "Worked for 1m 12s", or "Working for …" while the run is going; empty when no time is known. */
	private duration(replies: Component[]): string {
		const times = replies.map((reply) => replyTimes(reply));
		const starts = times.flatMap((t) => (t.start === undefined ? [] : [t.start]));
		if (!starts.length) return "";
		const start = Math.min(...starts);
		const live = starts.some((t) => this.state.activeMessages?.has(t)) || this.tools.some((tool) => runtimeOf(tool).isPartial || !runtimeOf(tool).result);
		if (live) return `Working for ${formatDuration(Date.now() - start)}`;
		const ends = times.flatMap((t) => (t.end === undefined ? [] : [t.end]));
		return ends.length ? `Worked for ${formatDuration(Math.max(...ends) - start)}` : "";
	}

	private get key(): object {
		return this.items.find((item) => !(item instanceof Spacer)) ?? this.answer ?? this;
	}

	/** Open only when clicked open. Ctrl+O shows tool output inside an open line, but never opens one. */
	get expanded(): boolean {
		return this.state.opened!.get(this.key) ?? false;
	}

	render(width: number): string[] {
		const header = this.header.render(width);
		if (!this.expanded) return header;
		// Opened: a quiet timeline behind a rail, so it never competes with the answer below it.
		const rows = this.items.flatMap((item) => item.render(Math.max(1, width - 2)));
		// The answer's own thinking stays folded; it closes the timeline instead of sitting above the answer.
		const answerThought = this.answer ? describeThinking([this.answer]) : "";
		if (answerThought) rows.push("", truncateToWidth(` \x1b[38;2;190;149;255m●\x1b[39m ${answerThought}`, Math.max(1, width - 2)));
		return [...header, ...rows.map((line) => RAIL + faint(line)), ""]; // a gap before the answer
	}

	handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.y === 0) {
			const result = this.header.handleMouse(event);
			if (!result || (!result.handled && !result.capture && !result.focus)) return undefined;
			return {
				...result,
				handled: true,
				target: {
					component: this.header,
					originX: event.screenX - event.x,
					originY: event.screenY - event.y,
					width: event.width,
					height: 1,
				},
			};
		}
		if (!this.expanded) return undefined;
		let y = event.y - 1;
		const width = Math.max(1, event.width - 2); // the rail takes two columns
		for (const item of this.items) {
			const height = item.render(width).length;
			if (y < height) return item.handleMouse?.({ ...event, x: event.x - 2, width, y, height }) as ReturnType<Container["handleMouse"]>;
			y -= height;
		}
		return undefined;
	}

	invalidate(): void {
		this.header.invalidate();
		for (const item of this.items) item.invalidate?.();
	}
}

function captureRender(component: ToolExecutionComponent, state: GroupingState): void {
	const ui = runtimeOf(component).ui;
	const requestRender = ui?.requestRender;
	if (requestRender) state.requestRender = () => requestRender.call(ui);
}

const assistantMessage = (component: Component) =>
	component instanceof AssistantMessageComponent ? (component as unknown as AssistantRuntimeAdapter).lastMessage : undefined;
const hasText = (message: AssistantRuntimeAdapter["lastMessage"]) =>
	!!message?.content?.some((block) => block.type === "text" && String(block.text ?? "").trim());

/** A reply with text that also called tools: a note along the way ("Now the README:"), not an answer. */
function isNote(component: Component): boolean {
	const message = assistantMessage(component);
	return hasText(message) && !!message?.content?.some((block) => block.type === "toolCall");
}

/** Work: tool rows, thinking, notes, and spacing between them. Answers and errors are not. */
function isWork(component: Component): boolean {
	if (component instanceof ToolExecutionComponent || component instanceof Spacer) return true;
	const message = assistantMessage(component);
	if (!message || !Array.isArray(message.content)) return false;
	if (message.stopReason === "error" || message.stopReason === "aborted") return false; // keep the error in view
	return !hasText(message) || isNote(component);
}

/** An answer whose first content is thinking: that thinking row can fold into the line above it. */
function thinkingAnswer(component: Component | undefined): Component | undefined {
	if (!component) return undefined;
	const content = (thinkingRealMessage(component) ?? assistantMessage(component))?.content;
	if (!content || !hasText({ content })) return undefined;
	const first = content.find((block) => (block.type === "text" && String(block.text ?? "").trim()) || block.type === "thinking");
	return first?.type === "thinking" ? component : undefined;
}

function projectGroups(children: Component[], state: GroupingState): Component[] {
	const projected: Component[] = [];
	const answers = new Set<Component>(); // answers whose thinking is folded into a line this render
	for (const child of children) if (child instanceof ToolExecutionComponent) captureRender(child, state);
	const fold = (items: Component[], answer?: Component, reply?: Component) => {
		const group = new ToolGroupComponent(items, state, answer, reply);
		if (answer) answers.add(answer);
		projected.push(group);
	};
	for (let i = 0; i < children.length;) {
		if (!isWork(children[i]!)) {
			// An answer straight after a user message still folds its thinking into a line of its own.
			const answer = thinkingAnswer(children[i]);
			if (answer) fold([], answer);
			projected.push(children[i++]!);
			continue;
		}
		let end = i;
		while (end < children.length && isWork(children[end]!)) end++;
		// Spacing at either edge stays outside the line.
		let first = i;
		while (first < end && children[first] instanceof Spacer) projected.push(children[first++]!);
		let last = end;
		while (last > first && children[last - 1] instanceof Spacer) last--;
		const items = children.slice(first, last);
		const answer = thinkingAnswer(children[end]);
		const next = children[end];
		const reply = next && assistantMessage(next) && !isWork(next) ? next : undefined;
		if (items.length > 0 || answer) fold(items, answer, reply);
		projected.push(...children.slice(last, end));
		if (answer) projected.push(children[end]!);
		i = answer ? end + 1 : end;
	}
	for (const child of children) {
		if (child instanceof AssistantMessageComponent) foldThinking(child, answers.has(child));
	}
	return projected;
}

/**
 * Install one reload-safe render projection on the real Pi Container prototype. Nothing about the chat is
 * retained: groups are derived from the live children on every render, and only the current run's tool-call
 * ids are tracked. The wrapper on the prototype is permanent; each load swaps in its own `render`.
 */
export function installToolGrouping(): {
	setEnabled(enabled: boolean): void;
	beginRun(): void;
	messageStart(timestamp: number): void;
	toolStart(toolCallId: string): void;
	settle(): void;
	reset(): void;
} {
	const prototype = Container.prototype as unknown as Record<PropertyKey, any>;
	let state = prototype[GROUPING] as GroupingState | undefined;

	// An older version's wrapper may still be the render function. Put the real one back before wrapping.
	const legacy = prototype[LEGACY_GROUPING] as { originalRender?: unknown } | undefined;
	if (legacy) {
		if (typeof legacy.originalRender === "function" && prototype.render !== state?.wrapper) {
			prototype.render = legacy.originalRender;
		}
		delete prototype[LEGACY_GROUPING];
	}

	if (!state || typeof state.wrapper !== "function") {
		state = { enabled: true, activeToolCallIds: new Set(), original: prototype.render, wrapper: undefined as never, render: undefined as never };
		prototype[GROUPING] = state;
	}
	const current = state;
	current.activeMessages ??= new Set();
	current.opened ??= new WeakMap();
	current.render = function (this: Container, width: number) {
		if (!current.enabled || !this.children.some((child) => (isWork(child) && !(child instanceof Spacer)) || thinkingAnswer(child))) {
			return current.original.call(this, width);
		}
		const originalChildren = this.children;
		this.children = projectGroups(originalChildren, current);
		try {
			return current.original.call(this, width);
		} finally {
			this.children = originalChildren;
		}
	};
	if (prototype.render !== current.wrapper) {
		current.original = prototype.render;
		current.wrapper = function (this: Container, width: number) {
			return current.render.call(this, width);
		};
		prototype.render = current.wrapper;
	}

	return {
		setEnabled(enabled) {
			current.enabled = enabled;
			if (!enabled) unfoldAllThinking();
		},
		beginRun() {
			current.activeToolCallIds.clear();
			current.activeMessages!.clear();
		},
		messageStart(timestamp) { current.activeMessages!.add(timestamp); },
		toolStart(toolCallId) { current.activeToolCallIds.add(toolCallId); },
		settle() {
			current.activeToolCallIds.clear();
			current.activeMessages!.clear();
			current.requestRender?.();
		},
		reset() {
			current.activeToolCallIds.clear();
			current.activeMessages!.clear();
			current.requestRender?.();
		},
	};
}
