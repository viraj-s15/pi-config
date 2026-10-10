---
name: searxng-search
description: Use this skill to search the web using the local SearXNG server on port 8080.
---

# SearXNG Search Skill

This skill allows the agent to perform web searches using a local SearXNG instance.

## Usage

When the user asks to search the web or find information from the internet:
1. Identify the search query.
2. Use Pi's `web_search` tool with the query. If the tool is unavailable, run the search script using Pi's `bash` tool:
   ```bash
   node ~/.pi/agent/skills/searxng-search/scripts/search.mjs "your search query"
   ```
3. Process and summarize the results for the user.
4. Fetch relevant source pages with the available shell tools when more detail is needed. Cite the source URLs.

## Configuration

- **Server:** http://127.0.0.1:8888 (override with the `SEARXNG_URL` environment variable)
- **Format:** JSON
