import { Controller, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { ThoughtSignatureCache } from './thought-signature-cache.service';

const GEMINI_OPENAI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Only forward fields Google's OpenAI-compatible endpoint actually
// recognizes. Real OpenAI silently ignores fields it doesn't know about;
// Google's compat layer hard-rejects the whole request with a 400 instead
// (confirmed: sending `metadata`, which Vapi's custom-llm client attaches
// to every request for its own call tracing, gets
// `Invalid JSON payload received. Unknown name "metadata": Cannot find field.`).
// That single incompatibility is what this whole proxy exists to route
// around — an allowlist (not a denylist) so any other tracking field a
// future Vapi release adds gets dropped the same way, instead of breaking
// every call again.
const ALLOWED_FIELDS = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stream',
  'stop',
  'n',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'response_format',
  'parallel_tool_calls',
]);

/**
 * OpenAI-compatible chat completions endpoint that Vapi's `custom-llm`
 * model provider calls mid-conversation. Sits between Vapi and Google's own
 * OpenAI-compatible Gemini endpoint for two reasons: sanitizing the
 * request (ALLOWED_FIELDS above), and threading Gemini's `thought_signature`
 * requirement across turns (see ThoughtSignatureCache) — Vapi's generic
 * OpenAI client does neither on its own. The real Gemini key lives only
 * here as a server env var; Vapi authenticates to this endpoint with a
 * separate shared secret (VAPI_SERVER_SECRET), so the Gemini key is never
 * handed to Vapi.
 */
@Controller('llm')
export class LlmProxyController {
  constructor(
    private readonly config: ConfigService,
    private readonly signatureCache: ThoughtSignatureCache,
  ) {}

  @Post('chat/completions')
  async chatCompletions(@Req() req: Request, @Res() res: Response): Promise<void> {
    const expectedSecret = this.config.get<string>('VAPI_SERVER_SECRET');
    const authHeader = req.headers['authorization'];
    const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const bearer = token?.replace(/^Bearer\s+/i, '');
    if (expectedSecret && bearer !== expectedSecret) {
      throw new UnauthorizedException('Invalid proxy credential');
    }

    const geminiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!geminiKey) {
      res.status(500).json({ error: { message: 'GEMINI_API_KEY is not configured on the server' } });
      return;
    }

    const incoming = (req.body ?? {}) as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(incoming)) {
      if (ALLOWED_FIELDS.has(key)) filtered[key] = incoming[key];
    }

    if (Array.isArray(filtered.messages)) {
      this.injectThoughtSignatures(filtered.messages as any[]);
    }

    const upstream = await fetch(GEMINI_OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${geminiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(filtered),
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);

    if (!upstream.body) {
      res.end();
      return;
    }

    if (filtered.stream) {
      await this.pipeStreamingResponse(upstream.body as any, res);
    } else {
      await this.pipeJsonResponse(upstream, res);
    }
  }

  // Re-attaches a previously-seen thought_signature to any assistant
  // tool_calls entry that doesn't already carry one — this is what Vapi's
  // replayed history is missing, since it has no concept of the field.
  private injectThoughtSignatures(messages: any[]): void {
    for (const msg of messages) {
      if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
      for (const toolCall of msg.tool_calls) {
        const existing = toolCall?.extra_content?.google?.thought_signature;
        if (existing || !toolCall?.id) continue;
        const cached = this.signatureCache.get(toolCall.id);
        if (cached) {
          toolCall.extra_content = {
            ...(toolCall.extra_content || {}),
            google: { ...(toolCall.extra_content?.google || {}), thought_signature: cached },
          };
        }
      }
    }
  }

  private captureThoughtSignatures(toolCalls: any[] | undefined): void {
    if (!Array.isArray(toolCalls)) return;
    for (const toolCall of toolCalls) {
      const sig = toolCall?.extra_content?.google?.thought_signature;
      if (sig && toolCall?.id) this.signatureCache.set(toolCall.id, sig);
    }
  }

  private async pipeJsonResponse(upstream: globalThis.Response, res: Response): Promise<void> {
    const text = await upstream.text();
    try {
      const parsed = JSON.parse(text);
      for (const choice of parsed.choices ?? []) {
        this.captureThoughtSignatures(choice?.message?.tool_calls);
      }
    } catch {
      // Not JSON (e.g. an upstream error body in an unexpected shape) —
      // still forward it verbatim below, just skip signature capture.
    }
    res.send(text);
  }

  // Forwards every raw byte to the client immediately and unmodified
  // (preserving real-time streaming for the voice call), while separately
  // parsing complete SSE events out of the same bytes to capture any
  // thought_signature Gemini attaches to a streamed tool call. Tool-call
  // deltas can arrive split across chunks by `index`, so signature and id
  // are accumulated per-index and only committed to the cache once both
  // are known.
  private async pipeStreamingResponse(body: ReadableStream<Uint8Array>, res: Response): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const idByIndex = new Map<number, string>();
    const signatureByIndex = new Map<number, string>();
    let buffer = '';

    const commit = (index: number) => {
      const id = idByIndex.get(index);
      const sig = signatureByIndex.get(index);
      if (id && sig) this.signatureCache.set(id, sig);
    };

    const processEvent = (rawEvent: string) => {
      const line = rawEvent.split('\n').find((l) => l.startsWith('data:'));
      if (!line) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const toolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
      if (!Array.isArray(toolCalls)) return;
      for (const tc of toolCalls) {
        const index = tc.index ?? 0;
        if (tc.id) idByIndex.set(index, tc.id);
        const sig = tc.extra_content?.google?.thought_signature;
        if (sig) signatureByIndex.set(index, sig);
        commit(index);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        processEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    if (buffer) processEvent(buffer);
    res.end();
  }
}
