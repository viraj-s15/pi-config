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
| [checkpoints](extensions/checkpoints) | Undo agent changes in Git repos with `/rewind`; later manual edits may be overwritten. |
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
| [usage](extensions/usage) | Show provider quotas and estimated API costs with `/usage`. |
| [user-bar](extensions/user-bar) | Style sent messages, fold long ones, and add copy/edit/fork actions. |
| [working-verbs](extensions/working-verbs) | Show the agent's current activity above the input. |
| [pi-anthropic-auth](https://www.npmjs.com/package/@gotgenes/pi-anthropic-auth) | Add Anthropic login support. |
| [pi-computer-use](https://github.com/injaneity/pi-computer-use) | Read and control desktop apps and browsers; configure with `/computer-use`. |

## Notes

- Defaults: OpenAI `gpt-6.1-sol`, high effort, `oxocarbon-grey`, and manual compaction. See `settings.json` and `models.json`.
- Todos live in `~/.pi/agent/todos/<project-name>-<path-hash>/`, outside your repo. Git subdirectories share one store. `PI_TODO_PATH` overrides it; old `.pi/todos/` files are copied once and left as backups.
- `/reload` loads extension changes. Restart Pi after changes to shared runtime or prototype wrappers.
- Images and screenshots stay in chat context and are resent on later turns.

## Optional setup

For web search, run a [SearXNG server](https://docs.searxng.org/admin/installation.html) with JSON results enabled. The default URL is `http://127.0.0.1:8888`; set `SEARXNG_URL` to change it. `bin/start-search-runtime` starts an existing Colima and `pi-searxng` container setup.

For `Cmd+V` image paste in Ghostty 1.3+, add these bindings and reload Ghostty with `Cmd+Shift+,`:

```text
keybind = super+v=paste_from_clipboard
keybind = chain=text:\x1b[200~\x1b[201~
```

## Tests

Run `node tests/run.mjs`, or `node tests/run.mjs todos` for one extension. Provider calls are mocked.
