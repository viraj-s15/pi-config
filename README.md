# pi-config
Minimal Portable configuration for the [**pi-coding-agent**.](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

## Features
- **Subagents:** Includes `scout`, `planner`, `worker`, and `reviewer` agents via the pi agent extension
- **Web search Skill:** Via `searxng` for local web searching.

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
- `agent/settings.json`: Global settings (compaction, default models).
- `agent/agents/`: Subagent definitions.
- `agent/extensions/`: Custom extensions (e.g., subagent orchestration).
- `agent/skills/`: Agent skills and capabilities.
- `agent/prompts/`: Workflow templates (slash commands).
