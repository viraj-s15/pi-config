import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { installThinkingLabels } from "../thinking-label.ts";

initTheme("dark", false);
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
const START = 1_700_000_000_000;

const reply = (content: any[], usage: { output: number; reasoning?: number } = { output: 1000 }, timestamp = START) => ({
	role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "m", stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
	usage: { input: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 }, ...usage }, timestamp,
}) as any;
const THINK = { type: "thinking", thinking: "planning" };
const CALL = { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } };
const TEXT = { type: "text", text: "Here is the answer." };

/** The label line of a hidden-thinking row, as the user sees it. */
const label = (component: AssistantMessageComponent) => strip(component.render(80).join("\n")).split("\n").map((l) => l.trim()).find((l) => l.startsWith("●")) ?? "";

test("a finished thinking step says how long it took, from its share of the reply", () => {
	const labels = installThinkingLabels();
	try {
		labels.setEnabled(true);
		const message = reply([THINK, CALL], { output: 1000, reasoning: 700 });
		labels.recordEnd(message, START + 20_000);
		assert.equal(label(new AssistantMessageComponent(message, true, undefined, "PI DEFAULT")), "● thought 14s");
	} finally { labels.setEnabled(false); }
});

test("a reply that only thought takes the whole reply time when no breakdown is reported", () => {
	const labels = installThinkingLabels();
	try {
		labels.setEnabled(true);
		const message = reply([THINK], { output: 300 });
		labels.recordEnd(message, START + 9_400);
		assert.equal(label(new AssistantMessageComponent(message, true)), "● thought 9s");
	} finally { labels.setEnabled(false); }
});

test("without a breakdown or an end time it just says thought, never a made-up number", () => {
	const labels = installThinkingLabels();
	try {
		labels.setEnabled(true);
		const mixed = reply([THINK, TEXT], { output: 800 }, START + 1);
		labels.recordEnd(mixed, START + 1 + 10_000);
		assert.equal(label(new AssistantMessageComponent(mixed, true)), "● thought");
		const unknownEnd = reply([THINK, CALL], { output: 1000, reasoning: 500 }, START + 2);
		assert.equal(label(new AssistantMessageComponent(unknownEnd, true)), "● thought");
	} finally { labels.setEnabled(false); }
});

test("long thinking reads in minutes", () => {
	const labels = installThinkingLabels();
	try {
		labels.setEnabled(true);
		const message = reply([THINK], { output: 2000, reasoning: 2000 }, START + 3);
		labels.recordEnd(message, START + 3 + 65_000);
		assert.equal(label(new AssistantMessageComponent(message, true)), "● thought 1m 05s");
	} finally { labels.setEnabled(false); }
});

test("while streaming it is thinking…, and just thought once the answer or a tool call has begun", () => {
	const labels = installThinkingLabels();
	try {
		labels.setEnabled(true);
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(reply([THINK], { output: 0 }, START + 4), true);
		assert.equal(label(component), "● thinking…");
		component.updateContent(reply([THINK, TEXT], { output: 0 }, START + 4), true);
		assert.equal(label(component), "● thought");
	} finally { labels.setEnabled(false); }
});

test("saved chats get their times from the session file", () => {
	const labels = installThinkingLabels();
	try {
		labels.setEnabled(true);
		const message = reply([THINK, CALL], { output: 1000, reasoning: 500 }, START + 5);
		labels.indexSession([
			{ type: "message", timestamp: new Date(START + 5 + 30_000).toISOString(), message },
			{ type: "message", timestamp: "not a date", message: reply([THINK], { output: 10 }, START + 6) },
			{ type: "custom", timestamp: new Date(START).toISOString() },
		]);
		assert.equal(label(new AssistantMessageComponent(message, true)), "● thought 15s");
	} finally { labels.setEnabled(false); }
});

test("switched off, Pi's own label is used", () => {
	const labels = installThinkingLabels();
	labels.setEnabled(false);
	const message = reply([THINK], { output: 300 }, START + 7);
	labels.recordEnd(message, START + 7 + 5_000);
	assert.match(strip(new AssistantMessageComponent(message, true, undefined, "PI DEFAULT").render(80).join("\n")), /PI DEFAULT/);
});

test("reloading installs one wrapper, and the newest code is the one that runs", () => {
	const proto = AssistantMessageComponent.prototype as any;
	installThinkingLabels();
	const wrapper = proto.updateContent;
	const labels = installThinkingLabels();
	try {
		assert.equal(proto.updateContent, wrapper, "not wrapped a second time");
		labels.setEnabled(true);
		const message = reply([THINK], { output: 300 }, START + 8);
		labels.recordEnd(message, START + 8 + 3_000);
		assert.equal(label(new AssistantMessageComponent(message, true)), "● thought 3s");
	} finally { labels.setEnabled(false); }
});

test("visible thinking is untouched: the label only replaces the hidden-thinking line", () => {
	const labels = installThinkingLabels();
	try {
		labels.setEnabled(true);
		const message = reply([THINK], { output: 300 }, START + 9);
		const text = strip(new AssistantMessageComponent(message, false).render(80).join("\n"));
		assert.match(text, /planning/);
		assert.doesNotMatch(text, /thought/);
	} finally { labels.setEnabled(false); }
});
