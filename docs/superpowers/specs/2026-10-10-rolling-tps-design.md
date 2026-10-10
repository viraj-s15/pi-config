# In-memory rolling footer TPS

The user approved a simple smoothed number, not a persisted or exact chat-wide average.

- Keep one optional `averageTps` number in the `oxo-ui` extension's closure.
- First valid final answer sets that number to its answer-token rate. Later answers apply `(averageTps + responseTps) / 2`.
- Use provider-reported `output - reasoning` tokens divided by seconds from the first non-empty answer `text_delta` to response completion. Reasoning summaries, tool-argument deltas, tool execution, pre-token waiting and idle time are excluded from timing.
- Sample only `stop` or `length` responses without any tool calls. Keep the 0.3-second minimum sampling duration. Ignore missing answer text, zero/non-finite counts, invalid reasoning breakdowns and errored/aborted responses. If thinking content exists without a reported reasoning-token breakdown, omit that sample rather than treating thinking tokens as answer tokens. Otherwise a missing reasoning count is treated as zero.
- Remove live character-based estimates and the ten-second idle reset timer. The displayed value changes only after a valid final answer finishes.
- Label the existing footer segment `avg t/s`; display `0` before the first valid sample.
- Reset the average and pending response timing on session start. Reload/exiting discards closure state naturally. No files, session entries, response counts or timing history.
- Leave editor styling, git status, quota/cache/cost displays, commands and `/btw` unchanged.

Verify the actual registered event handlers and rendered footer with a fake clock: initialization, successive blends, unchanged streaming value, idle retention, invalid responses, session/reload reset and no persistence. Run the existing `/btw` tests as a regression check.
