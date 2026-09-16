import { Injectable } from '@nestjs/common';

/**
 * Gemini's OpenAI-compatible endpoint requires every function-call message
 * replayed back to it to carry the `thought_signature` Gemini itself
 * attached to that call (an opaque reasoning-continuity token, nested at
 * tool_calls[i].extra_content.google.thought_signature) — otherwise it
 * rejects the request with "Function call is missing a thought_signature."
 * Vapi's custom-llm client has no idea this Gemini-specific field exists,
 * so it never echoes it back on the next turn. This process-local cache
 * (keyed by tool_call id, which Vapi does preserve) is what lets the proxy
 * re-inject the signature Gemini asked for, without Vapi needing to know
 * anything about it. Bounded so a long-running server can't leak memory
 * across many calls.
 */
@Injectable()
export class ThoughtSignatureCache {
  private readonly cache = new Map<string, string>();
  private readonly maxEntries = 1000;

  get(toolCallId: string): string | undefined {
    return this.cache.get(toolCallId);
  }

  set(toolCallId: string, signature: string): void {
    if (!this.cache.has(toolCallId) && this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(toolCallId, signature);
  }
}
