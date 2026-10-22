import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchWeb } from "./client.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: "Search the web through Exa for current information, documentation, and research. Returns source URLs and relevant page highlights.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params, signal) {
      const data = await searchWeb(params, { signal });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        details: { provider: "exa", resultCount: data.results.length },
      };
    },
  });
}
