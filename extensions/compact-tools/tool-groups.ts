import { Container, MouseRegion, Spacer, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { commandProgram } from "./summaries.ts";
import { foldThinking, thinkingOf, thinkingRealMessage, unfoldAllThinking } from "./thinking-label.ts";

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

	constructor(items: Component[], private readonly state: GroupingState, private readonly answer?: Component) {
		super();
		this.items = items;
		this.tools = items.filter((item): item is ToolExecutionComponent => item instanceof ToolExecutionComponent);
		this.header = new MouseRegion(
			new HeaderLine(() => {
				const count = this.tools.length;
				const failed = this.tools.filter((tool) => runtimeOf(tool).result?.isError === true).length;
				const parts: string[] = [];
				const thought = describeThinking([...this.items.filter((item) => item instanceof AssistantMessageComponent), ...(this.answer ? [this.answer] : [])]);
				if (thought) parts.push(thought);
				const what = describeTools(this.tools);
				if (what) parts.push(what);
				let line = ` ${fg(OK, this.expanded ? "▾" : "▸")}`;
				if (count) line += ` ${fg(TEXT, `${count} tool call${count === 1 ? "" : "s"}`)}`;
				if (failed) line += ` ${fg(ERR, `(${failed} failed)`)}`;
				if (parts.length) line += fg(DIM, `${count ? " · " : " "}${parts.join(" · ")}`);
				return line;
			}),
			(event: TuiMouseEvent) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.state.opened!.set(this.items[0]!, !this.expanded);
				const ui = this.tools[0] ? runtimeOf(this.tools[0]).ui : undefined;
				ui?.requestRender?.call(ui);
				return { handled: true, render: true };
			},
		);
	}

	/** Open if clicked open, or (until clicked) if Ctrl+O expanded its tools. */
	get expanded(): boolean {
		return this.state.opened!.get(this.items[0]!) ?? this.tools.some((row) => runtimeOf(row).expanded);
	}

	render(width: number): string[] {
		const header = this.header.render(width);
		return this.expanded ? [...header, ...this.items.flatMap((item) => item.render(width))] : header;
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
		for (const item of this.items) {
			const height = item.render(event.width).length;
			if (y < height) return item.handleMouse?.({ ...event, y, height }) as ReturnType<Container["handleMouse"]>;
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

/** Work: tool rows, assistant replies that only thought or called tools, and spacing between them. */
function isWork(component: Component): boolean {
	if (component instanceof ToolExecutionComponent || component instanceof Spacer) return true;
	const message = assistantMessage(component);
	if (!message || !Array.isArray(message.content)) return false;
	if (message.stopReason === "error" || message.stopReason === "aborted") return false; // keep the error in view
	return !hasText(message);
}

/** Still happening: a running tool, or anything from the run in progress. */
function isLive(component: Component, state: GroupingState): boolean {
	if (component instanceof ToolExecutionComponent) {
		const runtime = runtimeOf(component);
		return runtime.isPartial || !runtime.result || state.activeToolCallIds.has(runtime.toolCallId);
	}
	const timestamp = assistantMessage(component)?.timestamp;
	return timestamp !== undefined && !!state.activeMessages?.has(timestamp);
}

/** An answer whose first content is thinking: that thinking row can fold into the line above it. */
function thinkingAnswer(component: Component | undefined, state: GroupingState): Component | undefined {
	if (!component || isLive(component, state)) return undefined;
	const content = (thinkingRealMessage(component) ?? assistantMessage(component))?.content;
	if (!content || !hasText({ content })) return undefined;
	const first = content.find((block) => (block.type === "text" && String(block.text ?? "").trim()) || block.type === "thinking");
	return first?.type === "thinking" ? component : undefined;
}

function projectGroups(children: Component[], state: GroupingState): Component[] {
	const projected: Component[] = [];
	const answers = new Set<Component>(); // answers whose thinking is folded into a line this render
	for (const child of children) if (child instanceof ToolExecutionComponent) captureRender(child, state);
	for (let i = 0; i < children.length;) {
		if (!isWork(children[i]!)) {
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
		const rows = items.filter((item) => !(item instanceof Spacer));
		const answer = thinkingAnswer(children[end], state);
		const live = items.some((item) => isLive(item, state));
		if (!live && rows.length > 0 && rows.length + (answer ? 1 : 0) >= 2) {
			const group = new ToolGroupComponent(items, state, answer);
			if (answer && !group.expanded) answers.add(answer);
			projected.push(group);
		} else {
			projected.push(...items);
		}
		projected.push(...children.slice(last, end));
		i = end;
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
		if (!current.enabled || !this.children.some((child) => child instanceof ToolExecutionComponent || isWork(child) && !(child instanceof Spacer))) {
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
