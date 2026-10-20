# pi-config

My [Pi](https://pi.dev/) config for macOS.

## Install

Requires Homebrew and Node 22.19+. Ghostty and a Nerd Font are recommended.

```bash
brew install node
brew install --cask ghostty font-jetbrains-mono-nerd-font
curl -fsSL https://pi.dev/install.sh | sh

git clone https://github.com/viraj-s15/pi-config.git ~/Documents/github/pi-config
REPO=~/Documents/github/pi-config
mkdir -p ~/.pi/agent "$REPO/prompts"

# Replaces these folders. Back up your existing config first.
for d in extensions skills themes prompts; do
  rm -rf ~/.pi/agent/$d
  ln -s "$REPO/$d" ~/.pi/agent/$d
done
ln -sf "$REPO/models.json" ~/.pi/agent/models.json

# Keep existing settings; don't symlink this file.
cp -n "$REPO/settings.json" ~/.pi/agent/settings.json

npm install --prefix "$REPO/extensions/latex-images"
pi install npm:@gotgenes/pi-anthropic-auth@3.4.2
pi install npm:@injaneity/pi-computer-use@0.5.1
pi
```

Set your terminal font to JetBrains Mono Nerd Font. Run `/login` in Pi and choose OpenAI or Anthropic. Credentials stay on your machine.

Computer use needs Accessibility and Screen Recording permissions for `~/Applications/pi-computer-use.app`. It can control your real apps, so test it somewhere harmless. Use `mode=semantic` when screenshots aren't needed.

## Extensions

| Extension | What it does |
| --- | --- |
| [actions](extensions/actions) | Search commands, skills, and prompts with `/actions` or `Ctrl+Shift+K`. |
| [ask-user](extensions/ask-user) | Let the agent ask questions with selectable answers. |
| [btw](extensions/btw) | Ask a side question with `/btw` without changing the main chat. |
| [checkpoints](extensions/checkpoints) | Expand per-turn diffs, inspect net session changes with `/diff`, or undo changes with `/rewind`; later manual edits may be overwritten. |
| [compact-tools](extensions/compact-tools) | Fold thinking and tool calls while keeping all regular text visible. |
| [context](extensions/context) | Show a context-usage breakdown with `/context`. |
| [edit-check](extensions/edit-check) | Report new TypeScript, Python, and JSON errors after edits when checkers are available. |
| [image-paste](extensions/image-paste) | Paste clipboard images with `Ctrl+V`; inspect them with `/attachments`. |
| [latex-images](extensions/latex-images) | Render math as images in terminals with Kitty graphics. |
| [notifications](extensions/notifications) | Send macOS notifications when Pi needs attention while you're away. |
| [oxo-ui](extensions/oxo-ui) | Style the input and footer with cost, context usage, and tokens/sec. |
| [paste-fold](extensions/paste-fold) | Collapse long pastes in the editor without changing their text. |
| [searxng](extensions/searxng) | Search the web through a local SearXNG server. |
| [sessions](extensions/sessions) | Switch project sessions with `/sessions`. |
| [subagent](extensions/subagent) | Run subagents; watch or stop them with `/agents` or `Ctrl+Shift+A`. |
| [todo-widget](extensions/todo-widget) | Show live todo progress; expand it with `Ctrl+Shift+E`. |
| [todos](extensions/todos) | Manage project tasks with `/todos` and the agent's `todo` tool. |
| [usage](extensions/usage) | Show quota bars, API-equivalent cost since each weekly reset, and 30-day spend with `/usage`; `d` toggles details. |
| [user-bar](extensions/user-bar) | Style sent messages, fold long ones, and add copy/edit/fork actions. |
| [working-verbs](extensions/working-verbs) | Show the agent's current activity above the input. |
| [pi-anthropic-auth](https://www.npmjs.com/package/@gotgenes/pi-anthropic-auth) | Add Anthropic login support. |
| [pi-computer-use](https://github.com/injaneity/pi-computer-use) | Read and control desktop apps and browsers; configure with `/computer-use`. |

## Notes

- Defaults: OpenAI `gpt-6.1-sol`, high effort, `oxocarbon-grey`, and manual compaction. See `settings.json` and `models.json`.
- Todos live in `~/.pi/agent/todos/<project-name>-<path-hash>/`, outside your repo. Git subdirectories share one store. `PI_TODO_PATH` overrides it; old `.pi/todos/` files are copied once and left as backups.
- `/reload` loads extension changes. Restart Pi after changes to shared runtime or prototype wrappers.
- Changed turns get a collapsed **Changes** row. Click to expand, then click a filename to show its patch; `Ctrl+O` also expands entries. `/diff` opens a read-only net session diff, and `/diff last` shows the latest completed turn (including an empty diff for a no-change turn). In the panel: arrows or `j`/`k` scroll, `n`/`p` or Tab/Shift-Tab select a file, Enter toggles its patch, `a` toggles all, and Esc closes. Snapshots respect `.gitignore`, include new/deleted and binary files, and persist across resume/reload. Initial dirty work is the baseline, not attributed to the agent. Changes made concurrently by you or external processes cannot be distinguished from the agent's changes; session diffs cover only paths changed during recorded turns. Very large patches have explicit display limits. Regular terminal mode uses `/diff last` as the keyboard alternative to clicking.
- Images and screenshots stay in chat context and are resent on later turns.

## Optional setup

### Semble code search

Install or update [Semble](https://github.com/MinishLab/semble) and its upstream Pi integration:

```bash
node "$REPO/bin/setup-semble.mjs"
```

Requires `uv` (`brew install uv` if needed). The command upgrades `semble[mcp]`, runs `semble install --agent pi --type mcp --yes`, then reapplies this config's Pi defaults. It updates the version pin, so rerun this same command for upgrades. Plain `semble install` alone rewrites its MCP entry and removes our extra settings.

Pi 1.3.0 has native MCP support; no separate MCP or agents extension is needed. Setup adds `search` and `find_related` as direct tools in `~/.pi/agent/mcp.json`, and a managed preference section in `~/.pi/agent/AGENTS.md`, preserving other servers and instructions. Run `/reload`, then `/mcp` to inspect the connection.

Each repo is indexed on its first search, not during setup. Later searches reuse the cache and incrementally update changed files. Defaults are five results with ten-line snippets, no indexing worker pool, single-thread numerical/tokenizer settings, a five-minute request timeout, and eviction of idle in-memory indexes after two minutes. These thread settings reduce CPU concurrency; they are not a hard OS CPU quota. Disk indexes remain cached. MCP freshness checks have a build-time cooldown, so use live reads or the documented CLI fallback when checking immediately changed code. `rg` remains available for exhaustive literal/reference searches. `find_related` is similarity search, not an exhaustive call graph.

To remove Semble's MCP entry, run `semble uninstall --agent pi --type mcp --yes`. Remove the `pi-config:semble` marked section from `~/.pi/agent/AGENTS.md` separately if you no longer want the guidance.

### Web search

For web search, run a [SearXNG server](https://docs.searxng.org/admin/installation.html) with JSON results enabled. The default URL is `http://127.0.0.1:8888`; set `SEARXNG_URL` to change it. `bin/start-search-runtime` starts an existing Colima and `pi-searxng` container setup.

For `Cmd+V` image paste in Ghostty 1.3+, add these bindings and reload Ghostty with `Cmd+Shift+,`:

```text
keybind = super+v=paste_from_clipboard
keybind = chain=text:\x1b[200~\x1b[201~
```

## Tests

Run `node tests/run.mjs`, or `node tests/run.mjs todos` for one extension. Provider calls are mocked.
