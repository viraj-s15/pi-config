import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface BtwExchange {
  question: string;
  answer: string;
  status: "streaming" | "done" | "error" | "cancelled";
  error?: string;
}

interface BtwRequest {
  registry: Pick<ModelRegistry, "streamSimple">;
  model: Model<Api>;
  context: Context;
  question: string;
  reasoning?: SimpleStreamOptions["reasoning"];
}

/** All side-conversation state stays here in RAM, never in a Pi session entry. */
export class BtwThread {
  exchanges: BtwExchange[] = [];
  current: BtwExchange | undefined;
  private controller: AbortController | undefined;

  get busy(): boolean { return this.controller !== undefined; }

  cancel(): void {
    this.controller?.abort();
    if (this.current?.status === "streaming") this.current.status = "cancelled";
  }

  clear(): void {
    this.cancel();
    // Detach cancelled requests so their eventual completion cannot change a
    // freshly opened session's state, even if the provider ignores cancellation.
    this.controller = undefined;
    this.current = undefined;
    this.exchanges = [];
  }

  async ask(request: BtwRequest, onUpdate: () => void): Promise<void> {
    if (this.busy) throw new Error("A /btw question is already running");
    const controller = new AbortController();
    this.controller = controller;
    const exchange: BtwExchange = { question: request.question, answer: "", status: "streaming" };
    this.current = exchange;
    const active = () => this.controller === controller && !controller.signal.aborted;
    try {
      const stream = request.registry.streamSimple(request.model, request.context, {
        signal: controller.signal,
        reasoning: request.reasoning,
      });
      for await (const event of stream) {
        if (!active()) break;
        if (event.type === "text_delta") {
          exchange.answer += event.delta;
          onUpdate();
        }
      }
      if (!active()) return;
      const response = await stream.result();
      if (!active()) return;
      if (response.stopReason === "aborted") {
        exchange.status = "cancelled";
      } else if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "The provider could not answer this side question");
      } else if (response.stopReason === "deferred") {
        throw new Error("This provider deferred the response; /btw requires a streamed answer");
      } else {
        exchange.answer = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        if (response.content.some(block => block.type === "toolCall") || response.stopReason === "toolUse") {
          exchange.answer += "\n\n/btw has no tool access; nothing was executed.";
        }
        if (!exchange.answer.trim()) throw new Error("The provider returned an empty answer");
        if (response.stopReason === "length") exchange.answer += "\n\n[Answer stopped at the model's output limit.]";
        exchange.status = "done";
        this.exchanges.push(exchange);
        if (this.exchanges.length > 20) this.exchanges.shift();
      }
    } catch (error) {
      if (active()) {
        exchange.status = "error";
        exchange.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
        onUpdate();
      }
    }
  }
}
