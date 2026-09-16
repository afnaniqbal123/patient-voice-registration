import { Controller, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Readable } from 'stream';

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
 * OpenAI-compatible Gemini endpoint purely to sanitize the request — see
 * ALLOWED_FIELDS above. The real Gemini API key lives only here as a server
 * env var; Vapi authenticates to this endpoint with a separate shared
 * secret (VAPI_SERVER_SECRET), so the Gemini key is never handed to Vapi.
 */
@Controller('llm')
export class LlmProxyController {
  constructor(private readonly config: ConfigService) {}

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
    Readable.fromWeb(upstream.body as any).pipe(res);
  }
}
