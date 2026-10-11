# Focus-aware notifications

Load this directory as a Pi extension. In interactive TUI mode, the extension watches terminal focus reports (CSI `I` / `O`) without consuming input and notifies only when an explicit focus-out report has been observed. Unknown focus is treated as focused. RPC, JSON, and print modes do not send notifications.

It reports one settled completion or failure per agent run, and one `Input needed` notification for each blocking Pi UI prompt (`ui_prompt_start`) during an active run. Prompts started while focused remain pending; if the terminal loses focus before the prompt ends, they are notified then. Prompts outside active runs, such as the user-invoked `/actions` chooser, are ignored. Aborted runs are silent, including when the settled event says aborted after an earlier completed outcome. Tool errors and intermediate retries do not trigger notifications; the final `agent_before_settle` outcome is used with the actual `agent_settled.aborted` flag.

macOS uses `osascript` via `execFile` with separate arguments. Other TTYs may receive OSC 777 as a terminal notification. Messages contain only the project directory name and a fixed status, never prompt, tool arguments, or output. Missing/failed notification backends are ignored.

Use `/notify on`, `/notify off`, or `/notify status` to control the extension at runtime. Focus reporting depends on terminal support; fullscreen Pi enables terminal focus reporting where supported. This extension does not attempt to enable terminal reporting itself.

Tests use an injected notification transport and do not invoke desktop notifications.
