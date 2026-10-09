# pi-config
Minimal Portable configuration for the [**pi-coding-agent**.](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

## Features
- **Subagents:** Includes `scout`, `planner`, `worker`, and `reviewer` agents via the pi agent extension
- **Web search Skill:** Via `searxng` for local web searching.
- **ask_user tool:** Structured question/clarification helper (from `ask-user` extension)
- **Todos tool:** File-backed task tracking via `/todos` UI and `todo` tool
- **Sessions command:** `/sessions` for quick project session switching

## Installation

To use this configuration on a new system:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/viraj-s15/pi-config.git ~/pi-config-tmp
   ```

2. **Copy to your global pi directory:**
   ```bash
   mkdir -p ~/.pi/agent
   cp -r ~/pi-config-tmp/agent/* ~/.pi/agent/
   rm -rf ~/pi-config-tmp
   ```

3. **Restart your pi session.**

## Structure
- `agent/settings.json`: Global settings (theme and compaction/model defaults).
- `agent/agents/`: Subagent definitions.
- `agent/extensions/`: Custom extensions (e.g., subagent orchestration, ask-user, todos, sessions).
- `agent/skills/`: Agent skills and capabilities.
- `agent/themes/`: Custom themes (including `catppuccin`).
- `agent/prompts/`: Workflow templates (slash commands).

## Local Pi 1.1 setup

- The resource folders are linked from `~/.pi/agent/` into this checkout, so repository edits apply directly.
- Existing OpenAI authentication and session history are retained. The default provider is native Anthropic; log in with `/login anthropic`.
- The installed `settings.json` excludes other skill directories and explicitly allows the 18 skills in this repository.
- All subagent roles use `openai/gpt-6-luna` with the 900K Pi context preset. The subagent tool enforces this model for project agents too.
- The local SearXNG backend runs as the Docker container `pi-searxng` on `127.0.0.1:8888`. Start it with `docker start pi-searxng` if it is stopped.
- Set `SEARXNG_URL` to use another search server. The search helper has a 15-second timeout.
- Run `/reload` in an existing Pi session after editing these resources.
- `@gotgenes/pi-anthropic-auth@3.4.2` wraps Pi's native Anthropic transport for OAuth subscription requests. Claude Code bridge is removed; Pi owns the agent loop, tools, and compaction.
- Pi's OpenAI presets retain a 900K context limit and compact at about 200K. Anthropic models also compact around 200K, or near their limit when the model's window is smaller.
- The three custom workflow prompt templates are archived and prompt-template discovery is disabled.
- The `web_search` tool uses local SearXNG directly. The macOS login task `com.veer.pi-search-startup` starts Colima, waits for Docker, and starts the search container.
