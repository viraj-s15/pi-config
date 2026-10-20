import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnthropicUsage, parseAntigravityUsage, parseCodexUsage } from "../quota.ts";

const DAY = 86400;

test("Anthropic keeps quota labels, clamps utilization, and declares nominal durations", () => {
	const { wins } = parseAnthropicUsage({
		five_hour: { utilization: 120, resets_at: "2026-01-02T03:04:05Z" },
		seven_day: { utilization: -5 },
		seven_day_opus: { utilization: 50 },
		seven_day_sonnet: { utilization: 25 },
		opaque_cap: { limit_dollars: 100, used_dollars: 120, utilization: 110 },
		invalid: { utilization: Infinity },
	});
	assert.deepEqual(wins.map(w => [w.label, w.used, w.durationSeconds]), [
		["5h", 100, 5 * 3600], ["7d", 0, 7 * DAY], ["7d Opus", 50, 7 * DAY],
		["7d Sonnet", 25, 7 * DAY], ["Spend cap", 100, undefined],
	]);
	assert.equal(wins[0]!.resetsAt, Date.parse("2026-01-02T03:04:05Z"));
	assert.equal(wins[4]!.note, "$120.00 / $100");
	assert.equal(parseAnthropicUsage({ five_hour: { utilization: 1, resets_at: "invalid" } }).wins[0]!.resetsAt, undefined);
});

test("Codex uses epoch-second reset bounds, declared durations, labels and plan/credits", () => {
	const now = 1_800_000_000_000;
	const { plan, wins, extra } = parseCodexUsage({
		plan_type: "pro",
		credits: { has_credits: true, balance: 12 },
		rate_limit: {
			primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: now / 1000 + 3600 },
			secondary_window: { used_percent: 50, limit_window_seconds: 14 * DAY, reset_after_seconds: 90 },
		},
	}, now);
	assert.equal(plan, "pro");
	assert.deepEqual(wins.map(w => [w.label, w.durationSeconds, w.resetsAt]), [
		["5h", 18000, now + 3600_000], ["14d", 14 * DAY, now + 90_000],
	]);
	assert.deepEqual(extra, ["credits balance: 12"]);
});

test("Codex never guesses a weekly duration and rejects invalid reset values", () => {
	const { wins } = parseCodexUsage({ rate_limit: {
		primary_window: { used_percent: 3, reset_at: -1, reset_after_seconds: -1 },
		secondary_window: { used_percent: 4, limit_window_seconds: 0, reset_at: Infinity, reset_after_seconds: NaN },
	} }, 1000);
	assert.deepEqual(wins.map(w => [w.label, w.durationSeconds, w.resetsAt]), [
		["5h", undefined, undefined], ["7d", undefined, undefined],
	]);
});

test("Antigravity parses data groups, weekly metadata and only valid buckets", () => {
	const { wins } = parseAntigravityUsage({ command: { data: { groups: [{ name: "Claude and Gemini Models", buckets: [
		{ window: "weekly", remaining_fraction: 0.25, reset_time: "2026-06-01T00:00:00Z" },
		{ window: "hourly", remaining_fraction: -0.5, reset_time: "bad" },
		{ window: "weekly", remaining_fraction: 0.5 },
		{ window: "weekly", remaining_fraction: NaN },
	] }] } } });
	assert.deepEqual(wins, [
		{ label: "Claude/Gemini 7d", used: 75, resetsAt: Date.parse("2026-06-01T00:00:00Z"), durationSeconds: 7 * DAY },
		{ label: "Claude/Gemini hourly", used: 100, resetsAt: undefined },
		{ label: "Claude/Gemini 7d", used: 50, resetsAt: undefined, durationSeconds: 7 * DAY },
	]);
});

test("all providers reject payloads with no valid quota windows", () => {
	assert.throws(() => parseAnthropicUsage({}), { message: "no quota windows returned" });
	assert.throws(() => parseCodexUsage({}), { message: "no quota windows returned" });
	assert.throws(() => parseAntigravityUsage({ command: { data: { groups: [] } } }), { message: "no quota windows returned" });
});
