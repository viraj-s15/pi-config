import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: "Search the web through the user's local SearXNG server. Use for current information and research; results include source URLs.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params, signal) {
      const url = new URL("/search", process.env.SEARXNG_URL || "http://127.0.0.1:8888");
      url.searchParams.set("q", params.query);
      url.searchParams.set("format", "json");
      const timeout = AbortSignal.timeout(15000);
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
      const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
      if (!Array.isArray(data.results)) throw new Error("SearXNG returned an invalid results payload");
      const results = data.results.slice(0, params.limit ?? 5).map(result => ({
        title: result.title ?? "",
        url: result.url ?? "",
        snippet: (result.content ?? "").replace(/<[^>]*>/g, ""),
      }));
      return { content: [{ type: "text", text: JSON.stringify({ query: params.query, results }, null, 2) }], details: { resultCount: results.length } };
    },
  });
}
