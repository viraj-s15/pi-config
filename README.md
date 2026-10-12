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

- `extensions/`: oxo-ui (input box and footer), working-verbs (spinner with a random verb and what the agent is doing), compact-tools (one-line tool bullets), user-bar (blue bar and collapsible sent messages), btw (side questions), image-paste (attach pasted images), paste-fold (collapse big pastes, click to expand), todos, todo-widget, subagent, usage, latex-images, searxng, sessions, ask-user, notifications (background alerts), actions (searchable command palette), checkpoints (/rewind files and chat), edit-check (tell the agent about errors its edits cause), context (/context breakdown)
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

- `avg t/s` is an in-memory rolling average, updated after each reply as `(previous average + latest reply TPS) / 2`. A reply's rate is all of its output tokens (thinking, answer and tool arguments) over the whole reply, from the moment the provider starts responding to the end. Rates based on when the answer text arrives read several times too fast, because providers think silently or in bursts and often deliver the answer in one spurt (Opus showed 467 t/s). This measure can only err low, by the second or so the provider spends reading the prompt. Replies under 200 output tokens or under a second, and failed or aborted ones, add no sample. On this Opus session, whole replies came out at about 70 to 105 t/s. It shows `–` until the first sample of a session and stays visible between turns. `/reload` keeps it (held in process memory). A new, resumed or forked session starts over, and nothing is written to disk.

## Tool activity

`compact-tools` shows an operation and its observed result on one compact row. Recognized test commands show reported pass/fail counts; Git commands show commit/push details; read, edit, write, and search calls summarize recognizable results. Unknown or complex shell commands keep their original command preview rather than getting a guessed label. Click a tool row or use `Ctrl+O` to see the full command and output.

Each run of **work folds into one line above the answer**, e.g. `▸ Worked for 4m 10s · 14 tool calls (1 failed) · thought 42s · Tests 232 passed 0 failed · rg ×2 · Read ×3`. The work is everything before the answer: thinking, tool calls, and the notes the agent writes along the way ("Now the README:"). Only the answer stays at full brightness. The line gives the run's time (from the first reply to the end of the answer), counts the calls (failures in red), adds up the thinking time, then lists recognised results and what ran: the program for shell commands (plumbing like `cd`, `cat` and `head` is skipped), the tool name otherwise. While the agent works it reads `Working for 1m 04s` and keeps counting; the working line above the input says what is happening now. A reply that only thought before answering reads `▸ thought 2s`. Click the line (`▾`) to open the run as a faint timeline behind a rail, in order, notes included; inside it `Ctrl+O` shows tool output, but it never opens a line. `/toolgroups off` shows every row again. A hidden-thinking row reads `● thinking…` while the model thinks, then `● thought 14s` once the reply is done: the reply's time, split by its share of thinking tokens (just `● thought` when that split is unknown). Click it to read the thinking. Mouse clicks need fullscreen mode.

## Rewind

Before and after every agent run, `checkpoints` snapshots the project's files into a separate git store under `~/.pi/agent/checkpoints` (your repo, index and stash are never touched; `.gitignore` is respected). `/rewind` lists your prompts, newest first, with how many files rewinding to each would restore. Pick one and the files the agent changed from that prompt on go back to how they were before it, then the chat rewinds to that prompt with its text in the editor ("Restore files only" leaves the chat alone). Only files the agent's runs changed are restored, so your own edits elsewhere stay; if you also edited one of those files afterwards, the confirmation says so. `/rewind` offers "Undo the last rewind" until Pi restarts. It needs the project to be in a git repository and covers changes made by any tool, including shell commands.

## Errors after edits

When the agent edits or writes a file, `edit-check` checks it and adds any new errors to the tool result, so the agent fixes them in the same turn. Errors that were already there are not listed. TypeScript uses the project's own `tsc` (nearest `tsconfig.json`, `node_modules/.bin/tsc`, incremental, run in the background so Pi stays responsive); Python uses `ruff` from the project's `.venv` or `PATH`; `.json` files are parsed. Other files, and projects without those tools, are not checked. `/checks off` turns it off.

## Context

`/context` shows what fills the context window: a stacked bar and a legend for the system prompt, project instructions (AGENTS.md), the skills list, tool definitions, your messages, the agent's text and tool calls, tool results and summaries, plus free space, then the biggest single items (`read src/big.ts`, `bash npm test`). Pi only knows the total, so each part is estimated from its text and fitted to it; earlier thinking is not resent, so it is not counted.

## Subagent hub

`/agents` or `Ctrl+Shift+A` lists the subagents this Pi has run: running ones first with what each is doing now (`Running npm test`), then recent finished ones with time, tokens and cost. Enter opens a live transcript (↑↓ and PgUp/PgDn scroll); `x` stops the selected subagent. A stopped subagent returns "Stopped by the user" to the agent while its parallel siblings keep going.

## Background notifications

`notifications` sends a macOS desktop notification when Pi finishes, fails, or needs input from a blocking dialog, **only after the terminal reports that it is unfocused**. It waits for the final settled outcome, not each tool or intermediate retry; aborted runs are silent. Notification text contains only the project name and a fixed status, not your prompts or command output.

- `/notify on|off|status` controls notifications for the current runtime.
- Unknown focus is treated as focused. Fullscreen Pi enables terminal focus reports; actual delivery also depends on macOS notification permissions and settings.
- Tests mock delivery and verify the notification process arguments; they do not produce desktop notifications or make provider requests.

## Action palette

Open `/actions` or press **Ctrl+Shift+K** to search extension commands, skills, prompt templates, and common built-in actions. Use arrows to select, Enter to put the slash command in the editor, then Enter again to run it. Escape cancels without touching the draft. Opening and selecting in the palette does not call a model.

If you already have a draft, the palette asks before replacing it and saves it in process memory. `/actions restore` (or the palette's restore item) recovers it; restoring over a different draft also asks first and keeps that draft recoverable. The backup survives `/reload`, not process exit. Ctrl+Shift+P remains Pi's existing reverse model-cycle shortcut.

## Big pastes

Pi folds a large paste into a marker such as `[paste #1 2314 chars]` and still sends the full text. It does this for more than 10 lines or 1000 characters. `paste-fold` lowers the character limit to **500** and lets you **click a marker to expand it** in place, with the cursor left after the text. `Ctrl+Z` folds it back.

- Clicks only reach Pi in fullscreen mode, which is Pi's default (`tuiMode`). In regular mode the terminal keeps the mouse, so markers stay folded, but they are still sent in full.
- Only a left click on the marker counts. Moving the cursor onto it with the keyboard, or clicking the text around it, does nothing.
- It wraps two methods of Pi's editor and relies on its marker numbering, so a Pi update that changes those internals makes it fall back to Pi's own behavior. The tests run against Pi's real editor and will show it.
- This marker behavior is editor-only. Sent messages have their own compact preview, described below.

### Long messages in the chat

`user-bar` shows sent user messages over **500 characters** as two rendered preview lines plus a **▸ Show more · N characters** row. Left-click **Show more** to expand the full message, then **▾ Show less** to collapse it again. It applies to typed and pasted text, including messages already in a resumed chat; messages that fit in two lines stay inline.

- The blue bar stays on both preview and expanded messages. `/userbar off` disables the accent without disabling folding.
- Only the display changes. The saved message, Markdown content, attachments, and text sent to the model remain intact. Assistant replies are untouched.
- Mouse toggles need fullscreen mode. `/userfold off` shows all user messages in full without a mouse; `/userfold on` restores folding.
- Expansion is per rendered message, not saved to disk. A transcript rebuild (such as `/reload` or switching sessions) starts the new message components collapsed again.

### Your messages: click and jump

Left-click the text of any message you sent to get a menu:

- **Copy text** copies it to the clipboard.
- **Edit and resend** goes back to just before that message and puts it in the editor, like picking it in `/tree`. The later conversation stays in the session tree.
- **Fork into a new session** starts a new session file from just before it, with the message in the editor, like `/fork`.

Edit and fork wait until the agent is idle. **Ctrl+Shift+↑ / ↓** jumps the transcript to the previous or next message (yours and the agent's final answers); this is Pi's own key, which the blue bar used to break.

### Working line

While the agent runs, the line above the input keeps the Claude Code style random verb and adds what is happening right now: `✻ Flibbertigibbeting… (1m 04s) · Running npm test`. Other steps read `Thinking`, `Reading src/a.ts`, `Searching for "TODO"`, `Preparing an edit`, `Writing the answer`, `Running 3 tools` or `Waiting for the model`. The verb changes with every model turn; the time is the whole run's.

## Image paste

Pi's `Ctrl+V` saves a clipboard image to a temp file and inserts its path into the editor. With `oxo-ui` enabled, supported image paths are displayed as **`[Image 1 · filename.png ×]`** chips instead of long paths. `image-paste` turns the original image paths in a message you send into real attachments, so the model receives the picture and not just a filename.

- Click a chip to inspect its filename, resolved path, size, and filename-based type; this is file information, not a thumbnail viewer. Click **×** to remove it. Removal is undoable.
- **Ctrl+Shift+I** opens a keyboard chooser to inspect or remove images from your current draft. `/attachments <draft text>` also opens it and returns that text to the editor; bare `/attachments` reports any image paths available in the current draft.
- Chips are display-only. Original paths, surrounding text, large-paste contents, and actual image bytes are preserved for submission. Arrow navigation treats paths as atomic chips; wrapping and Unicode filenames are supported. The attachment handler still verifies actual image bytes before sending.
- With `/oxo` disabled, the default editor shows raw paths again, but attachment submission and the keyboard chooser still work.

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

## Commands

- `/reload`: reload extensions after editing them
- `/btw <question>`: answer a side question with the current model and chat context, without adding it to chat history (no tools; works while the agent is busy). Bare `/btw` reopens the last answer. [Controls and details](extensions/btw/README.md).
- `/oxo`: toggle the custom input box and footer
- `/verbs on|off`: spinner with a random verb, the run time and what the agent is doing
- `/userbar on|off`: bold text with a blue left bar on your sent messages instead of a grey block
- `/bullets on|off`: operation/result tool summaries instead of boxed blocks (`Ctrl+O` expands original commands and output)
- `/toolgroups on|off`: fold each run's thinking, tool calls and notes into one "Worked for" line above the answer
- `/notify on|off|status`: focus-aware background notifications
- `/actions`: searchable command palette (`Ctrl+Shift+K`); `/actions restore` recovers a replaced draft
- `/attachments`: draft image inspection/removal (`Ctrl+Shift+I` keeps the current draft)
- `/usage`: quota windows for each provider, plus an API cost section: what the last 30 days of messages would have cost at API prices, summed across all saved sessions. It shows one stacked bar for each provider's share (OpenAI blue, Anthropic orange), a value multiple against your plan price (`PLANS` in `extensions/usage/index.ts`, currently $20 each), and a 30-day stacked column chart (rolling 24-hour buckets, oldest first). It is a rolling window, not tied to a billing cycle. Forked sessions are not double-counted. Subagent and `/btw` calls are not saved in sessions, so they are not included.
- `/todos`: list todos
- `/todo-widget [expand|collapse|on|off]`: todo line above the input (`Ctrl+Shift+E` expands it). It shows todos in progress, plus open or done ones touched during this session, so leftovers from earlier work don't linger
- `/latex on|off`: LaTeX image rendering
- `/sessions`: switch project sessions
- `/compact`: compact manually (auto-compaction is off)
- `/rewind`: put back the files the agent changed since one of your prompts and rewind the chat
- `/checks on|off`: report new errors after the agent's edits
- `/context`: what fills the context window
- `/agents`: subagent hub (`Ctrl+Shift+A`)
