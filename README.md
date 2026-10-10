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

- `extensions/`: oxo-ui (input box and footer), working-verbs (spinner), compact-tools (one-line tool bullets), user-bar (blue bar on your messages), btw (side questions), todos, todo-widget, subagent, usage, latex-images, searxng, sessions, ask-user
- `skills/`: all skills in the repo
- `themes/`: `oxocarbon-grey` and `catppuccin`
- `models.json`: 900K context for the OpenAI GPT-6 and GPT-5.6 models
- Subagents have no predefined roles. Each call defines its own prompt, tools and model. The default is `openai/gpt-6-luna` at high effort.
- `settings.json`: OpenAI GPT-6.1 Sol (900K) at high effort, auto-compaction off, `oxocarbon-grey` theme
- Footer `avg t/s`: an in-memory rolling average, updated after each final answer as `(previous average + latest answer TPS) / 2`. It counts non-reasoning output tokens from the first answer-text delta to completion, excluding tool-call responses. It stays visible between turns; changing sessions or `/reload` resets it. Nothing is saved.

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

- `/usage` also reads Codex quota from `~/.codex/auth.json` (Codex CLI login) and Antigravity quota from the `agy` CLI.
- Todo files are written to `.pi/todos/` in each project.

## Commands

- `/reload`: reload extensions after editing them
- `/btw <question>`: answer a side question with the current model and chat context, without adding it to chat history (no tools; works while the agent is busy). Bare `/btw` reopens the last answer. [Controls and details](extensions/btw/README.md).
- `/oxo`: toggle the custom input box and footer
- `/verbs on|off`: Claude Code style spinner with random verbs
- `/userbar on|off`: bold text with a blue left bar on your sent messages instead of a grey block
- `/bullets on|off`: one-line tool bullets instead of boxed blocks (`Ctrl+O` expands a row, `/reload` redraws old rows)
- `/usage`: quota windows for each provider
- `/todos`: list todos
- `/todo-widget [expand|collapse|on|off]`: todo line above the input (`Ctrl+Shift+E` expands it)
- `/latex on|off`: LaTeX image rendering
- `/sessions`: switch project sessions
- `/compact`: compact manually (auto-compaction is off)
