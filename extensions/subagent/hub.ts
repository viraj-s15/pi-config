/**
 * Every subagent this Pi process has run: status, transcript, usage and what it is doing now.
 * Kept on globalThis so subagents started before a /reload still show up after it.
 */

import { createActivity } from "../working-verbs/activity.ts";

export type AgentStatus = "running" | "done" | "failed" | "stopped";

export interface LiveAgent {
	id: number;
	label: string;
	task: string;
	model: string;
	cwd: string;
	startedAt: number;
	endedAt?: number;
	status: AgentStatus;
	/** Shared with the subagent tool's own result, so both see the same transcript and usage. */
	messages: any[];
	usage: { input: number; output: number; cost: number; turns: number };
	/** Set by the runner: ends the subagent's process. */
	stop?: () => void;
}

type NewAgent = Pick<LiveAgent, "label" | "task" | "model" | "cwd" | "messages" | "usage">;

export interface Hub {
	add(agent: NewAgent): LiveAgent;
	/** Feed one event from the subagent's JSON stream. */
	event(agent: LiveAgent, event: any): void;
	finish(agent: LiveAgent, status: Exclude<AgentStatus, "running">): void;
	stop(agent: LiveAgent): void;
	/** Running ones first, then the most recent finished ones. */
	list(): LiveAgent[];
	activity(agent: LiveAgent): string;
	changed(): void;
	subscribe(listener: () => void): () => void;
	clear(): void;
}

const KEY = Symbol.for("pi-config.subagent.hub");
const KEEP_FINISHED = 20;

function createHub(): Hub {
	const agents: LiveAgent[] = [];
	const activities = new WeakMap<LiveAgent, ReturnType<typeof createActivity>>();
	const listeners = new Set<() => void>();
	let next = 1;
	const changed = () => {
		for (const listener of [...listeners]) listener();
	};
	const prune = () => {
		const finished = agents.filter((a) => a.status !== "running").sort((a, b) => b.id - a.id);
		for (const old of finished.slice(KEEP_FINISHED)) agents.splice(agents.indexOf(old), 1);
	};

	return {
		add(spec) {
			const agent: LiveAgent = { ...spec, id: next++, startedAt: Date.now(), status: "running" };
			const activity = createActivity(spec.cwd);
			activity.start();
			activities.set(agent, activity);
			agents.push(agent);
			prune();
			changed();
			return agent;
		},
		event(agent, event) {
			const activity = activities.get(agent);
			if (!activity || !event) return;
			if (event.type === "message_start" && event.message?.role === "assistant") activity.replyStart();
			else if (event.type === "message_update") {
				const e = event.assistantMessageEvent ?? {};
				const block = e.contentIndex === undefined ? undefined : e.partial?.content?.[e.contentIndex];
				activity.delta(e.type, e.delta ?? "", block?.type === "toolCall" ? block.name : undefined);
			} else if (event.type === "tool_execution_start") activity.toolStart(event.toolCallId, event.toolName, event.args ?? {});
			else if (event.type === "tool_execution_end") activity.toolEnd(event.toolCallId);
			else return;
			changed();
		},
		finish(agent, status) {
			if (agent.status === "running") agent.status = status;
			agent.endedAt ??= Date.now();
			prune();
			changed();
		},
		stop(agent) {
			if (agent.status !== "running") return;
			agent.status = "stopped";
			agent.stop?.();
			changed();
		},
		list() {
			const running = agents.filter((a) => a.status === "running").sort((a, b) => b.id - a.id);
			const finished = agents.filter((a) => a.status !== "running").sort((a, b) => b.id - a.id);
			return [...running, ...finished];
		},
		activity(agent) {
			return activities.get(agent)?.label() ?? "";
		},
		changed,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		clear() {
			agents.length = 0;
			changed();
		},
	};
}

export function getHub(): Hub {
	const g = globalThis as Record<PropertyKey, unknown>;
	return (g[KEY] ??= createHub()) as Hub;
}
