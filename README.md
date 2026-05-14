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
