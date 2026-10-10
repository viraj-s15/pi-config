import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { BtwExchange } from "./thread.ts";

const SIDE_INSTRUCTIONS = `Answer the user's side question using the conversation above. This is /btw, an independent side conversation, not a continuation of the main task. You have no tool access: do not read files, run commands, search, or claim to have performed any new action. Answer directly from the existing context, and say when it does not contain the information needed. Your question and answer will not enter the main conversation.`;

/** Snapshot model-visible data, excluding session-only details and in-progress output. */
export function buildBtwContext(
  messages: AgentMessage[],
  systemPrompt: string,
  exchanges: readonly BtwExchange[],
  question: string,
): Context {
  const snapshot = convertToLlm(messages.filter(message =>
    message.role !== "system" && !(message.role === "assistant" && message.stopReason === "pending"),
  ));
  const results = new Set(snapshot.filter(m => m.role === "toolResult").map(m => m.toolCallId));
  const calls = new Set<string>();
  const projected: Message[] = [];

  for (const message of snapshot) {
    if (message.role === "user") {
      projected.push({ role: "user", content: message.content, timestamp: message.timestamp });
    } else if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const block of message.content) {
        if (block.type !== "toolCall") {
          content.push(block);
        } else if (results.has(block.id)) {
          calls.add(block.id);
          // Native tool-use blocks require tool declarations on some providers.
          // Label completed calls as history; omit calls whose results are pending.
          content.push({ type: "text", text: `Tool call: ${block.name} (${block.id})\nArguments: ${JSON.stringify(block.arguments)}` });
        }
      }
      if (content.length) projected.push({
        role: "assistant", content, api: message.api, provider: message.provider, model: message.model,
        responseId: message.responseId, responseModel: message.responseModel,
        providerThinkingLevel: message.providerThinkingLevel, thinkingLevel: message.thinkingLevel,
        usage: message.usage, stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
        timestamp: message.timestamp,
      });
    } else if (message.role === "toolResult" && calls.has(message.toolCallId)) {
      projected.push({ role: "user", timestamp: message.timestamp, content: [
        { type: "text", text: `Tool result: ${message.toolName} (${message.toolCallId})${message.isError ? " [error]" : ""}` },
        ...message.content,
      ] });
    }
  }

  // Clone only the projected request: no tool details, system schemas or unused
  // argument objects. Nested content and usage must still be mutation-isolated.
  const contextMessages = structuredClone(projected);
  const timestamp = Date.now();
  for (const exchange of exchanges.slice(-20)) {
    contextMessages.push({ role: "user", content: exchange.question, timestamp });
    // Explicit context avoids inventing provider response IDs or thinking signatures.
    contextMessages.push({ role: "user", content: `Previous /btw answer:\n${exchange.answer}`, timestamp });
  }
  contextMessages.push({ role: "system", content: SIDE_INSTRUCTIONS, timestamp });
  contextMessages.push({ role: "user", content: question, timestamp });
  return { systemPrompt, messages: contextMessages, tools: [] };
}
