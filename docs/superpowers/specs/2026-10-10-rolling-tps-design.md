# In-memory rolling footer TPS

The user approved a simple smoothed number, not a persisted or exact chat-wide average.

- Keep one optional `averageTps` number in the `oxo-ui` extension's closure.
- First valid completed assistant response sets that number to its output-token rate. Later responses apply `(averageTps + responseTps) / 2`.
- Use provider-reported output tokens divided by seconds from the first streamed delta to response completion. Tool execution, pre-token waiting and idle time are excluded.
- Keep the existing 0.3-second minimum sampling duration. Ignore responses without streamed output, zero/non-finite token counts and errored/aborted responses.
- Remove live character-based estimates and the ten-second idle reset timer. The displayed value changes only after a valid assistant response finishes.
- Label the existing footer segment `avg t/s`; display `0` before the first valid sample.
- Reset the average and pending response timing on session start. Reload/exiting discards closure state naturally. No files, session entries, response counts or timing history.
- Leave editor styling, git status, quota/cache/cost displays, commands and `/btw` unchanged.

Verify the actual registered event handlers and rendered footer with a fake clock: initialization, successive blends, unchanged streaming value, idle retention, invalid responses, session/reload reset and no persistence. Run the existing `/btw` tests as a regression check.
