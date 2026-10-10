import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { BtwExchange } from "./thread.ts";

const SIDE_INSTRUCTIONS = `Answer the user's side question using the conversation above. This is /btw, an independent side conversation, not a continuation of the main task. You have no tool access: do not read files, run commands, search, or claim to have performed any new action. Answer directly from the existing context, and say when it does not contain the information needed. Your question and answer will not enter the main conversation.`;

/** Snapshot the active Pi projection, not raw entries or the live streaming assistant. */
export function buildBtwContext(
  messages: AgentMessage[],
  systemPrompt: string,
  exchanges: readonly BtwExchange[],
  question: string,
): Context {
  const snapshot = convertToLlm(structuredClone(messages)).filter(message =>
    message.role !== "system" && !(message.role === "assistant" && message.stopReason === "pending"),
  );
  // /btw can run between an assistant's parallel tool calls and their results.
  // Replay only completed pairs so providers never receive dangling tool calls/results.
  const results = new Set(snapshot.filter(m => m.role === "toolResult").map(m => m.toolCallId));
  const calls = new Set<string>();
  for (const message of snapshot) {
    if (message.role !== "assistant") continue;
    message.content = message.content.filter(block => {
      if (block.type !== "toolCall") return true;
      if (!results.has(block.id)) return false;
      calls.add(block.id);
      return true;
    });
  }
  const contextMessages: Message[] = snapshot.filter(message =>
    message.role === "toolResult" ? calls.has(message.toolCallId) :
      message.role !== "assistant" || message.content.length > 0,
  ).map((message): Message => {
    // Some providers require tool declarations when replaying native tool-use
    // blocks. /btw has no tools, so keep their information as labelled text.
    if (message.role === "toolResult") {
      return { role: "user", timestamp: message.timestamp, content: [
        { type: "text", text: `Tool result: ${message.toolName} (${message.toolCallId})${message.isError ? " [error]" : ""}` },
        ...message.content,
      ] };
    }
    if (message.role === "assistant") {
      return { ...message, stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
        content: message.content.map(block => block.type === "toolCall" ? {
          type: "text", text: `Tool call: ${block.name} (${block.id})\nArguments: ${JSON.stringify(block.arguments)}`,
        } : block),
      };
    }
    return message;
  });
  const timestamp = Date.now();
  for (const exchange of exchanges.slice(-20)) {
    contextMessages.push({ role: "user", content: exchange.question, timestamp });
    // Replay side answers as user-provided context rather than fabricating provider
    // response IDs, signatures or usage. This also works after switching models.
    contextMessages.push({ role: "user", content: `Previous /btw answer:\n${exchange.answer}`, timestamp });
  }
  contextMessages.push({ role: "system", content: SIDE_INSTRUCTIONS, timestamp });
  contextMessages.push({ role: "user", content: question, timestamp });
  // The current effective prompt replaces historical prompt checkpoints. No
  // toolsAdded/toolsRemoved survive, and tools is explicitly empty.
  return { systemPrompt, messages: contextMessages, tools: [] };
}
