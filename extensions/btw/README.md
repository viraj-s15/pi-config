# `/btw`

Ask a side question without adding the question or answer to the main chat:

```text
/btw which config file did you read earlier?
/btw why did we choose that approach?
```

The answer streams into a temporary Markdown overlay. It uses the current model, thinking level, system prompt and active conversation context, including earlier tool results. It works while the main agent is busy without interrupting it; the reply still being written is not included.

Side questions have **no tools**. They cannot read new files, run commands, edit anything or search the web. Historical tool calls and results are replayed as labelled text, with any result images preserved, so the model can use what the main agent already gathered without exposing executable tools.

## Controls

| Key | Action |
| --- | --- |
| Escape, Enter, Space, Ctrl+C | Dismiss; if still generating, cancel only the side request |
| Up / Down | Scroll the answer |
| PageUp / PageDown | Scroll a page |
| Tab / Shift+Tab | Next / previous side answer |
| `]` / `[` or Shift+Right / Shift+Left | Next / previous side answer |
| `c` | Copy the displayed answer as raw Markdown |
| `x` | Clear the side thread and dismiss |

Run `/btw` with no question to reopen the latest answer. If there is no answer yet, it shows usage instructions. Ask another `/btw <question>` to follow up after dismissing the overlay.

The newest 20 successful side exchanges stay in memory and are included in later side questions. Neither the exchanges nor their usage are written to the main session file or transcript. They disappear when you clear them, change sessions, navigate the conversation tree, reload extensions or exit Pi. This is a separate model request and uses your provider's quota and normal billing.

The command requires interactive terminal mode. There is no fork command or fork action.

## Load and test

This repository's `extensions/` is already linked to `~/.pi/agent/extensions/`. Run `/reload` in Pi to load the command.

From the repository root:

```sh
node tests/run.mjs btw
```

Run `node tests/run.mjs` for all suites. See the [repository testing instructions](../../README.md#tests) for runtime requirements. Automated tests do not make paid provider requests.
