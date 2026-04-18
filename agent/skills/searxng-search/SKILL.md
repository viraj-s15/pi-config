---
name: searxng-search
description: Use this skill to search the web using the local SearXNG server on port 8080.
---

# SearXNG Search Skill

This skill allows the agent to perform web searches using a local SearXNG instance.

## Usage

When the user asks to search the web or find information from the internet:
1. Identify the search query.
2. Run the search script using `run_shell_command`:
   ```bash
   node ~/.pi/agent/skills/searxng-search/scripts/search.mjs "your search query"
   ```
3. Process and summarize the results for the user.
4. If the results include relevant URLs, you can use `web_fetch` to extract more details from specific pages if needed.

## Configuration

- **Server:** http://localhost:8080
- **Format:** JSON
