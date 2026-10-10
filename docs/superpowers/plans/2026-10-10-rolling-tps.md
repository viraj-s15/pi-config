# Rolling TPS Implementation Plan

> **For agentic workers:** Execute this small, tightly coupled change inline with test-driven-development; request read-only review before completion.

**Goal:** Replace live footer TPS with one memory-only smoothed response-rate number.

**Architecture:** Record the first non-empty answer-text delta and finalize a non-reasoning output rate at `message_end` for final answers without tool calls. Blend that rate into one closure variable and render it between turns; remove all live estimation and reset-timer state.

**Tech Stack:** TypeScript, installed Pi APIs, Node test runner with mocked Date/timers, jiti.

## Task 1: Failing regression tests

Create `agent/extensions/oxo-ui/tests/run.mjs` using the same installed-Pi package resolution as the `/btw` test runner. Create `tests/rolling-tps.test.ts` that registers the real extension into a minimal event/UI host, captures the real footer and drives assistant events using Node's fake clock.

- [ ] Assert rates 100, 20, 40 yield displayed averages 100, 60, 50, not 100, 20, 40.
- [ ] Assert streaming deltas leave the previous average unchanged.
- [ ] Assert `agent_end` plus 30 seconds idle does not clear the meter.
- [ ] Assert `avg t/s` label, invalid-response filtering, short-response filtering, user-message exclusion, per-response timing reset and session/reload reset.
- [ ] Run `node agent/extensions/oxo-ui/tests/run.mjs`; observe failures against the original live-TPS implementation.

## Task 2: Minimal footer changes

Modify only the TPS portions of `agent/extensions/oxo-ui/index.ts`.

- [ ] Replace live/reset/character-count state with `let averageTps: number | undefined;` and the existing first-delta timestamp.
- [ ] Render `averageTps` with the existing decimal formatting plus `avg t/s`.
- [ ] Remove idle-reset scheduling from agent lifecycle handlers.
- [ ] At assistant `message_start`, clear the timestamp. At the first non-empty `text_delta`, record `Date.now()` without updating the meter.
- [ ] At assistant `message_end`, accept only final `stop`/`length` messages without tool calls. Validate elapsed time and token breakdown; skip unreported reasoning when thinking content is present. Compute `responseTps = (output - reasoning) / elapsed`, then assign `averageTps === undefined ? responseTps : (averageTps + responseTps) / 2`; clear the timestamp.
- [ ] At `session_start`, clear both the average and pending timing.
- [ ] Run the new suite, the `/btw` suite, strict TypeScript checking and `git diff --check`.

## Task 3: Review and report

- [ ] Add a short README note explaining the memory-only rolling average and `/reload` reset.
- [ ] Request read-only review for formula, timing, idle retention and absence of persistence.
- [x] Rerun all checks and report completion. Do not commit or push unless requested.

## Execution result

Implemented all tasks. The original footer failed 10 of the 12 new tests; after the minimal change, all 12 pass. All 25 `/btw` regression tests also pass. Strict TypeScript checking, whitespace checking and the installed Pi extension-load smoke test pass. Read-only review found no blocking findings. No timing/state persistence was added. Changes load with `/reload`.

### Measurement correction

The user later observed inflated readings. Actual OpenAI usage showed a final reply with 392 output tokens including 217 hidden reasoning tokens, leaving 175 answer tokens. The prior meter counted total output over a stream interval that could omit reasoning time and also sampled tool-call responses. The corrected measurement excludes reasoning tokens and tool-call messages, starts at the first non-empty answer-text delta, and skips ambiguous/invalid token breakdowns. Ten new regression tests failed against the old measurement, including a 392/217-token case, and pass after the correction. The one-number rolling formula and memory-only storage remain unchanged.
