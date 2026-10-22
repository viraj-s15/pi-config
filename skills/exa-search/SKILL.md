---
name: exa-search
description: Search the web for current information, documentation, and research using the hosted Exa API, without a local search server.
---

# Exa web search

1. Use Pi's `web_search` tool with a focused query. It uses Exa Auto search with relevant page highlights and returns source URLs.
2. If the tool is unavailable, run the script relative to this skill directory:
   ```bash
   node scripts/search.mjs "your search query"
   ```
3. Summarize the evidence and cite the source URLs. Fetch specific source pages when more detail is needed.
4. If authentication or quota fails, report it. Do not repeatedly retry or start a local search server.

The key comes from `EXA_API_KEY`, or the private file `~/.pi/agent/secrets/exa-api-key` (`PI_CODING_AGENT_DIR` overrides the agent directory). Never read, print, or ask the user to paste the key into chat. To save it locally, have the user run `python3 ~/Documents/github/pi-config/bin/setup-exa-key.py` in their own terminal.

For implementing or changing Exa API integrations, consult the upstream `build-with-exa` skill. It is not required for ordinary searches.
