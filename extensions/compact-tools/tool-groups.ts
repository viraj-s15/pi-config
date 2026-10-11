import { Container, MouseRegion, Spacer, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

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
	rendererState?: Record<PropertyKey, unknown>;
	ui?: { requestRender?: () => void };
}

interface AssistantRuntimeAdapter {
	lastMessage?: { content?: Array<{ type: string; text?: string }>; stopReason?: string };
}

interface GroupingState {
	enabled: boolean;
	activeToolCallIds: Set<string>;
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

/** "Tests 228 passed 0 failed · Git commit abc1234 · Bash ×2 · Read ×3": what happened, in order of interest. */
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
		const title = titleOf(runtime.toolName);
		counts.set(title, (counts.get(title) ?? 0) + 1);
	}
	return [...highlights, ...[...counts].map(([title, count]) => (count > 1 ? `${title} ×${count}` : title))].join(" · ");
}

/** A display-only view; the chat Container always retains its original children. */
export class ToolGroupComponent extends Container {
	private readonly items: Component[];
	private readonly tools: ToolExecutionComponent[];
	private readonly header: MouseRegion;

	/** `items` are the tool rows plus the thinking rows and spacers between them, in their original order. */
	constructor(items: Component[]) {
		super();
		this.items = items;
		this.tools = items.filter((item): item is ToolExecutionComponent => item instanceof ToolExecutionComponent);
		this.header = new MouseRegion(
			new HeaderLine(() => {
				const what = describeTools(this.tools);
				return ` ${fg(OK, "●")} ${fg(TEXT, `${this.tools.length} successful tools`)}${what ? fg(DIM, ` · ${what}`) : ""}${fg(DIM, ` · click to ${this.expanded ? "collapse" : "expand"}`)}`;
			}),
			(event: TuiMouseEvent) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true, render: true };
			},
		);
	}

	private get expanded(): boolean {
		return this.tools.some((row) => runtimeOf(row).expanded);
	}

	setExpanded(expanded: boolean): void {
		for (const row of this.tools) row.setExpanded(expanded);
		const ui = runtimeOf(this.tools[0]!).ui;
		ui?.requestRender?.call(ui);
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

function isCompletedSuccess(component: Component, state: GroupingState): component is ToolExecutionComponent {
	if (!(component instanceof ToolExecutionComponent)) return false;
	const runtime = runtimeOf(component);
	const ui = runtime.ui;
	const requestRender = ui?.requestRender;
	if (requestRender) state.requestRender = () => requestRender.call(ui);
	return !runtime.isPartial && runtime.result?.isError === false && !state.activeToolCallIds.has(runtime.toolCallId);
}

/** Rows that carry no message of their own: spacing, and assistant turns that only thought or called tools. */
function isTransparent(component: Component): boolean {
	if (component instanceof Spacer) return true;
	if (!(component instanceof AssistantMessageComponent)) return false;
	const message = (component as unknown as AssistantRuntimeAdapter).lastMessage;
	if (!message || !Array.isArray(message.content)) return false;
	if (message.stopReason === "error" || message.stopReason === "aborted") return false;
	return !message.content.some((block) => block.type === "text" && String(block.text ?? "").trim());
}

function projectGroups(children: Component[], state: GroupingState): Component[] {
	const projected: Component[] = [];
	let floor = 0; // children before this index already belong to an earlier group
	for (let i = 0; i < children.length;) {
		if (!isCompletedSuccess(children[i]!, state)) {
			projected.push(children[i++]!);
			continue;
		}
		// Extend the run over thinking rows and spacers, but only ever end it on a tool row.
		let last = i;
		let tools = 1;
		for (let k = i + 1; k < children.length; k++) {
			const child = children[k]!;
			if (isCompletedSuccess(child, state)) { last = k; tools++; }
			else if (!isTransparent(child)) break;
		}
		if (tools < 2) {
			projected.push(children[i++]!);
			continue;
		}
		// A thinking row or spacer just above the first tool belongs to the same stretch of work.
		let first = i;
		while (first > floor && isTransparent(children[first - 1]!)) first--;
		projected.length -= i - first;
		projected.push(new ToolGroupComponent(children.slice(first, last + 1)));
		i = floor = last + 1;
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
	current.render = function (this: Container, width: number) {
		if (!current.enabled || !this.children.some((child) => isCompletedSuccess(child, current))) {
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
		setEnabled(enabled) { current.enabled = enabled; },
		beginRun() { current.activeToolCallIds.clear(); },
		toolStart(toolCallId) { current.activeToolCallIds.add(toolCallId); },
		settle() {
			current.activeToolCallIds.clear();
			current.requestRender?.();
		},
		reset() {
			current.activeToolCallIds.clear();
			current.requestRender?.();
		},
	};
}
