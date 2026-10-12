# pi-config

My [Pi](https://pi.dev/) config for macOS, with a compact chat UI, subagents, and local web search.

## Prerequisites

- Node 22.19 or newer and Homebrew
- Ghostty (or another terminal with Kitty graphics for LaTeX images)
- A Nerd Font for the footer icons
- Colima and Docker for local web search

```bash
brew install node colima docker
brew install --cask ghostty font-jetbrains-mono-nerd-font
curl -fsSL https://pi.dev/install.sh | sh
```

Set the terminal font to JetBrains Mono Nerd Font.

## Clone and link

The loop below **replaces your existing extensions, skills, themes, and prompts folders**. Back them up first if you have your own.

```bash
git clone https://github.com/viraj-s15/pi-config.git ~/Documents/github/pi-config
REPO=~/Documents/github/pi-config
mkdir -p ~/.pi/agent "$REPO/prompts"

for d in extensions skills themes prompts; do
  rm -rf ~/.pi/agent/$d
  ln -s "$REPO/$d" ~/.pi/agent/$d
done
ln -sf "$REPO/models.json" ~/.pi/agent/models.json

# Keep existing settings. Pi rewrites this file, so don't symlink it.
cp -n "$REPO/settings.json" ~/.pi/agent/settings.json
```

The defaults are OpenAI `gpt-6.1-sol` at high effort, the `oxocarbon-grey` theme, and manual compaction. `models.json` sets a 900K context window for the configured GPT-6 and GPT-5.6 models.

## Third-party extensions

Pi installs these packages under `~/.pi/agent/npm/`. Their versions are pinned in `settings.json`. Run both commands after linking, even if you're keeping your existing settings:

```bash
pi install npm:@gotgenes/pi-anthropic-auth@3.4.2
pi install npm:@injaneity/pi-computer-use@0.5.1
```

| Package | Use | Setup |
| --- | --- | --- |
| [pi-anthropic-auth](https://www.npmjs.com/package/@gotgenes/pi-anthropic-auth) | Anthropic login integration | Run `/login` and choose Anthropic. |
| [pi-computer-use](https://github.com/injaneity/pi-computer-use) | Read and control desktop apps and browsers | Grant **Accessibility** and **Screen Recording** to `~/Applications/pi-computer-use.app` when setup asks. |

Start Pi after installing, or run `/reload` if it's already open. `/computer-use` shows the current configuration.

Computer use can control your real apps. Try it on something harmless first. Ask the agent to use `mode=semantic` to read UI text without screenshots; any screenshots it does take stay in the chat context.

For the default OpenAI model, run `/login` and choose OpenAI. Credentials stay on your machine; they aren't part of this repo.

## What's here

| Path | Contents |
| --- | --- |
| `extensions/` | The local UI and workflow extensions described below |
| `skills/` | Skills for coding, writing, and study |
| `themes/` | `oxocarbon-grey` and `catppuccin` |
| `prompts/` | Prompt templates; currently empty |
| `bin/` | Helpers, including `start-search-runtime` |
| `settings.json`, `models.json` | Default settings and model overrides |
| `tests/` | Shared test runner |

`extensions/herdr-agent-state.ts`, if present, is installed and managed by herdr. Git ignores it.

## Chat UI

### Tool activity

A run's thinking, tool calls, and intermediate notes fold into one clickable line above the answer:

```text
▸ Worked for 4m 10s · 14 tool calls · thought 42s · Tests 232 passed · rg ×2
```

Click to open a faint timeline. The answer stays visible at full brightness. While work is in progress, the line reads `Working for …`; the spinner above the input shows the current action. `Ctrl+O` expands tool output inside an open timeline but doesn't open a folded run. `/toolgroups off` shows every row.

Tool rows show test counts, Git results, and other results they recognize. Other shell commands keep their command preview. Thinking time is estimated from the reply's duration and how many tokens went into thinking. If that count is unknown, the row just says `thought`.

### Footer

The footer shows the directory, Git status, cache hit rate, **session cost**, average tokens/sec, context usage, and model. Tokens/sec includes thinking and tool arguments. It averages completed replies in memory, survives `/reload`, and resets when you start or resume a session.

### Messages and pastes

- Sent messages over 500 characters get a two-line preview with clickable **Show more / Show less**. The saved text and model input are unchanged.
- Left-click a sent message to copy it, edit and resend it, or fork from it. Edit and fork require an idle agent.
- `Ctrl+Shift+↑ / ↓` jumps between prompts and final answers.
- Pastes over 500 characters or 10 lines fold into a marker. Click to expand it in the editor; `Ctrl+Z` folds it back.
- Mouse controls need Pi's default fullscreen mode.

### Action palette

`Ctrl+Shift+K` or `/actions` searches commands, skills, and prompt templates. Enter inserts the selection into the editor; Enter again runs it. Selecting doesn't call a model.

Replacing a draft asks first. `/actions restore` recovers it until Pi exits.

## Rewind

`/rewind` restores files changed by the agent since a selected prompt, then rewinds the chat with that prompt in the editor. **Restore files only** leaves the chat alone. **Undo the last rewind** is available until Pi restarts.

- Requires a Git repo and only covers runs recorded after checkpoints loaded.
- Snapshots live under `~/.pi/agent/checkpoints`. Your repo's index and stash are untouched; `.gitignore` is respected.
- Files the agent never changed are left alone. Later manual edits to files it did change can be overwritten, so read the confirmation.
- Changes made through shell commands are covered too.

## Checks after edits

After `edit` or `write`, new errors in that file are added to the tool result:

| File | Check |
| --- | --- |
| TypeScript | Project-local `tsc`, using the nearest `tsconfig.json` |
| Python | `ruff` from the project's `.venv` or `PATH` |
| JSON | JSON parsing; comment-friendly config files are skipped |

Existing errors aren't reported again. Missing checkers and other file types are skipped. `/checks off` disables checking.

## Context and usage

- `/context` shows how much space instructions, tools, messages, and results take up, plus what's left. It lists the largest items. Each category is estimated, with the estimates adjusted to match Pi's measured total.
- `/usage` shows provider quotas and what saved messages from the last 30 days would have cost at API prices. It doesn't track your subscription bill. Forks aren't double-counted; subagent and `/btw` calls aren't included.
- Codex quota lookup uses `~/.codex/auth.json` and refreshes expired credentials. If access was revoked, run `codex login`. `CODEX_HOME` is respected. Antigravity quota uses the `agy` CLI.

## Subagents

Each subagent call defines its own task, prompt, tools, and model. There are no predefined roles. The default is `openai/gpt-6-luna` at high effort.

`/agents` or `Ctrl+Shift+A` opens the hub for this Pi process:

- Enter opens a live transcript; arrows and PgUp/PgDn scroll.
- `x` stops the selected agent and leaves the others running.
- Esc goes back or closes the hub.

## Notifications

Pi sends a macOS notification when it finishes, fails, or needs input, **only when the terminal has reported that it's unfocused**. Aborted runs are silent. Notifications contain the project name and a fixed status, never your prompt or tool output.

`/notify on|off|status` controls them. Delivery also depends on macOS permissions. If focus is unknown, Pi assumes you're still looking at it.

## Images

Copy an image and press **Ctrl+V** in Pi. The editor shows a removable image chip; sending the message attaches the image itself. Existing image paths, including dragged files, work too.

- Click a chip for file details, or **×** to remove it. Removal is undoable.
- `Ctrl+Shift+I` opens the attachment chooser. `/attachments` lists draft images.
- Up to 8 images per message, each at most 32 MB. Files must exist and contain supported image data.
- Images stay in the session and are resent on later turns. Large screenshots add up.

### Cmd+V in Ghostty

Ghostty can't paste an image through its normal text paste. Add these lines to its config (Ghostty 1.3+), then press `Cmd+Shift+,` to reload:

```text
keybind = super+v=paste_from_clipboard
keybind = chain=text:\x1b[200~\x1b[201~
```

The empty bracketed paste lets `image-paste` detect an image-only clipboard. Text pastes still work normally. If other terminal apps print `^[[200~^[[201~`, remove the bindings and use Ctrl+V in Pi instead.

### LaTeX

```bash
npm install --prefix ~/Documents/github/pi-config/extensions/latex-images
```

LaTeX images need Kitty graphics; otherwise math stays as text. `/latex off` disables it for the session; `PI_LATEX_IMAGES=0` disables it at startup.

## Local web search

```bash
REPO=~/Documents/github/pi-config
mkdir -p ~/.pi/agent/searxng ~/.pi/agent/startup-logs

cat > ~/.pi/agent/searxng/settings.yml <<YML
use_default_settings: true
search:
  formats:
    - html
    - json
server:
  secret_key: $(openssl rand -hex 32)
  limiter: false
  public_instance: false
YML

colima start
docker --context colima run -d --name pi-searxng --restart unless-stopped \
  -p 127.0.0.1:8888:8080 \
  -v ~/.pi/agent/searxng/settings.yml:/etc/searxng/settings.yml \
  searxng/searxng

curl -s "http://127.0.0.1:8888/search?q=test&format=json" | head -c 200
```

Set `SEARXNG_URL` to use another server. If `pi-searxng` already exists, use `docker --context colima start pi-searxng` instead of `docker run`.

### Start search at login

```bash
REPO=~/Documents/github/pi-config
chmod +x "$REPO/bin/start-search-runtime"
mkdir -p ~/Library/LaunchAgents

cat > ~/Library/LaunchAgents/com.veer.pi-search-startup.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.veer.pi-search-startup</string>
  <key>ProgramArguments</key><array><string>$REPO/bin/start-search-runtime</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$HOME/.pi/agent/startup-logs/startup.log</string>
  <key>StandardErrorPath</key><string>$HOME/.pi/agent/startup-logs/startup-error.log</string>
</dict>
</plist>
PLIST

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.veer.pi-search-startup.plist
```

## Commands

| Command / key | Use |
| --- | --- |
| `/reload` | Reload extensions; restart Pi after changes to shared runtime or prototype wrappers |
| `/btw <question>` | Side question, no tools or chat-history changes; bare `/btw` reopens it. [Details](extensions/btw/README.md) |
| `/agents` · `Ctrl+Shift+A` | Watch or stop subagents |
| `/rewind` | Restore agent changes and optionally rewind chat |
| `/checks on\|off` | Toggle checks after edits |
| `/context` | Context breakdown |
| `/usage` | Quotas and estimated 30-day API costs |
| `/computer-use` | Third-party computer-use configuration |
| `/actions` · `Ctrl+Shift+K` | Action palette; `/actions restore` recovers a draft |
| `/todos` | List todos; files live in `.pi/todos/` |
| `/todo-widget expand\|collapse\|on\|off` · `Ctrl+Shift+E` | Toggle the todo widget; only shows todos touched in this session or still in progress |
| `/attachments` · `Ctrl+Shift+I` | Inspect or remove draft images |
| `/notify on\|off\|status` | Background notifications |
| `/sessions` | Switch project sessions |
| `/compact` | Compact manually; auto-compaction is off |
| `/oxo` | Toggle the input box and footer |
| `/verbs on\|off` | Toggle the working line |
| `/bullets on\|off` | Toggle compact tool rows |
| `/toolgroups on\|off` | Toggle folded runs |
| `/userbar on\|off` | Toggle the blue message bar |
| `/userfold on\|off` | Toggle long-message folding |
| `/latex on\|off` | Toggle LaTeX images |

## Tests

```bash
node tests/run.mjs          # all tests
node tests/run.mjs btw      # one extension
```

Tests use Node's test runner and Pi's managed packages, with mocked providers. Set `PI_MANAGED_INSTALL_ROOT` if Pi is installed outside `~/.pi/agent/install`.
