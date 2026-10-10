# pi-config

Config for the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) on macOS.

## Prerequisites

- Homebrew
- Ghostty (or another terminal with Kitty graphics, needed for LaTeX images)
- A Nerd Font set as the terminal font (the footer uses its icons)
- Node 22.19 or newer
- Colima and Docker (local web search)

```bash
brew install node colima docker
brew install --cask ghostty font-jetbrains-mono-nerd-font
```

## Install pi

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

## Clone and link

```bash
git clone https://github.com/viraj-s15/pi-config.git ~/Documents/github/pi-config
REPO=~/Documents/github/pi-config
mkdir -p ~/.pi/agent

# Git does not track empty directories; ensure the optional prompts folder exists.
mkdir -p "$REPO/prompts"

# removes any existing copies of these folders
for d in extensions skills themes prompts; do
  rm -rf ~/.pi/agent/$d
  ln -s "$REPO/$d" ~/.pi/agent/$d
done
ln -sf "$REPO/models.json" ~/.pi/agent/models.json

# settings are copied, not linked, because pi rewrites them. Skipped if you already have one.
cp -n "$REPO/settings.json" ~/.pi/agent/settings.json
```

- `extensions/`: oxo-ui (input box and footer), working-verbs (spinner), compact-tools (one-line tool bullets), user-bar (blue bar on your messages), btw (side questions), image-paste (attach pasted images), paste-fold (collapse big pastes, click to expand), todos, todo-widget, subagent, usage, latex-images, searxng, sessions, ask-user
- `skills/`: all skills in the repo
- `prompts/`: prompt templates (empty for now)
- `bin/`: helper scripts, e.g. `start-search-runtime` for local web search
- `tests/`: the shared test runner (see [Tests](#tests))
- `themes/`: `oxocarbon-grey` and `catppuccin`
- `models.json`: 900K context for the OpenAI GPT-6 and GPT-5.6 models
- Subagents have no predefined roles. Each call defines its own prompt, tools and model. The default is `openai/gpt-6-luna` at high effort.
- `settings.json`: OpenAI GPT-6.1 Sol (900K) at high effort, auto-compaction off, `oxocarbon-grey` theme

## Footer

The `oxo-ui` footer shows the directory and git status, cache hit rate, cost, `avg t/s`, context usage and the model.

- `avg t/s` is an in-memory rolling average, updated after each final answer as `(previous average + latest answer TPS) / 2`. It counts non-reasoning output tokens over the time the answer text took to arrive (first to last text chunk), and ignores tool-call responses. An answer only counts if its text streamed for at least a second with no single pause taking up more than half of that window. Some answers arrive in one burst (Sonnet 5.5 with thinking does this) and would otherwise report thousands of t/s, so they are skipped. Checked against OpenRouter's median for Claude Sonnet 5.5 (about 111 t/s): the footer read 109 to 110 on live answers. It shows `–` until the first final answer of a session, and stays visible between turns. `/reload` keeps it (held in process memory). A new, resumed or forked session starts over, and nothing is written to disk. Turns that end in tool calls add no sample, so a long run of tool use leaves it unchanged.

## Big pastes

Pi folds a large paste into a marker such as `[paste #1 2314 chars]` and still sends the full text. It does this for more than 10 lines or 1000 characters. `paste-fold` lowers the character limit to **500** and lets you **click a marker to expand it** in place, with the cursor left after the text. `Ctrl+Z` folds it back.

- Clicks only reach Pi in fullscreen mode, which is Pi's default (`tuiMode`). In regular mode the terminal keeps the mouse, so markers stay folded, but they are still sent in full.
- Only a left click on the marker counts. Moving the cursor onto it with the keyboard, or clicking the text around it, does nothing.
- It wraps two methods of Pi's editor and relies on its marker numbering, so a Pi update that changes those internals makes it fall back to Pi's own behavior. The tests run against Pi's real editor and will show it.
- This is the editor only. Once you send the message, the transcript shows the full text as before.

## Image paste

Pi's `Ctrl+V` saves a clipboard image to a temp file and types its path into the editor. `image-paste` turns image paths in a message you send into real attachments, so the model receives the picture and not just a filename.

- Copy a screenshot (`Cmd+Ctrl+Shift+4` copies to the clipboard), press `Ctrl+V`, type your question and press Enter. Dragging a file into the terminal or typing a path works too, including `~/` paths, quoted paths and paths with spaces.
- The message shows `[image 1: name.png]` where the path was. Only files that exist and really are images (checked by their bytes, not the extension) are attached. Anything else stays as typed. At most 8 images per message, and nothing over 32 MB.
- The original bytes are attached and Pi shrinks them to the active model's limits (the `images.autoResize` setting applies). Attachments are saved in the session and sent again with every later turn, so large screenshots add up.
- It only acts on text you type. rpc and extension-sent messages are untouched. The temporary screenshot thumbnail on macOS disappears after a few seconds, so paste from the clipboard when you can.

### Cmd+V in Ghostty

A terminal cannot paste an image, so in Ghostty `Cmd+V` on an image-only clipboard sends nothing. These two lines make `Cmd+V` follow its normal paste with an empty bracketed paste (needs Ghostty 1.3 or newer, then `Cmd+Shift+,` to reload):

```
keybind = super+v=paste_from_clipboard
keybind = chain=text:\x1b[200~\x1b[201~
```

`image-paste` reacts to that empty paste: if the clipboard holds only an image, it is saved and its path inserted, like `Ctrl+V`. If the clipboard has text, the normal paste already happened and the empty one is ignored. Claude Code treats the same signal the same way. Terminal apps that do not turn on bracketed paste may print `^[[200~^[[201~` after a paste, so remove the two lines if you see that. Without them, `Ctrl+V` still works.

## LaTeX images

```bash
npm install --prefix ~/Documents/github/pi-config/extensions/latex-images
```

- Needs a terminal with Kitty graphics. Elsewhere it falls back to plain text math.
- `/latex off` turns it off. `PI_LATEX_IMAGES=0` disables it at startup.

## Logins

```bash
pi install npm:@gotgenes/pi-anthropic-auth@3.4.2
pi
```

Then run `/login` inside pi and pick OpenAI (the default model). Pick Anthropic too if you want Claude.

## Local web search (SearXNG)

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

- Set `SEARXNG_URL` to use a different SearXNG server.

### Start it at login

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

## Optional

- `/usage` also reads Codex quota and Antigravity quota (from the `agy` CLI). It uses the Codex CLI login in `~/.codex/auth.json` and refreshes it automatically when it expires, so you do not need to run `codex` yourself. If the login was revoked, it asks you to run `codex login`. `CODEX_HOME` is respected.
- Todo files are written to `.pi/todos/` in each project.

## Tests

From the repository root:

```sh
node tests/run.mjs         # all tests
node tests/run.mjs btw     # side-question tests only
node tests/run.mjs oxo-ui  # footer tests only
node tests/run.mjs usage   # Codex login refresh tests only
```

Tests use Node's test runner and the packages from Pi's managed installation; no additional install is needed. Set `PI_MANAGED_INSTALL_ROOT` if Pi is installed somewhere other than `~/.pi/agent/install`.

The footer tests include a synthetic OpenAI Responses event sequence passed through Pi's actual adapter. This checks normalization and token accounting without a paid request; it is not a live-provider speed benchmark.

## Commands

- `/reload`: reload extensions after editing them
- `/btw <question>`: answer a side question with the current model and chat context, without adding it to chat history (no tools; works while the agent is busy). Bare `/btw` reopens the last answer. [Controls and details](extensions/btw/README.md).
- `/oxo`: toggle the custom input box and footer
- `/verbs on|off`: Claude Code style spinner with random verbs
- `/userbar on|off`: bold text with a blue left bar on your sent messages instead of a grey block
- `/bullets on|off`: one-line tool bullets instead of boxed blocks (`Ctrl+O` expands a row, `/reload` redraws old rows)
- `/usage`: quota windows for each provider, plus an API cost section: what the last 30 days of messages would have cost at API prices, summed across all saved sessions. It shows one stacked bar for each provider's share (OpenAI blue, Anthropic orange), a value multiple against your plan price (`PLANS` in `extensions/usage/index.ts`, currently $20 each), and a 30-day stacked column chart (rolling 24-hour buckets, oldest first). It is a rolling window, not tied to a billing cycle. Forked sessions are not double-counted. Subagent and `/btw` calls are not saved in sessions, so they are not included.
- `/todos`: list todos
- `/todo-widget [expand|collapse|on|off]`: todo line above the input (`Ctrl+Shift+E` expands it)
- `/latex on|off`: LaTeX image rendering
- `/sessions`: switch project sessions
- `/compact`: compact manually (auto-compaction is off)
