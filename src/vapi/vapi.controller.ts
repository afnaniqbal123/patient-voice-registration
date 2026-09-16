import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VapiService } from './vapi.service';

/**
 * Single webhook endpoint for everything Vapi sends: mid-call tool/function
 * calls (create/lookup/update patient) and the end-of-call report (used for
 * the observability/transcript-logging requirement). Vapi multiplexes all
 * of these through one configurable serverUrl, distinguished by message.type.
 */
@Controller('vapi')
export class VapiController {
  constructor(
    private readonly vapiService: VapiService,
    private readonly config: ConfigService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Body() body: any, @Headers('x-vapi-secret') secret: string) {
    const expected = this.config.get<string>('VAPI_SERVER_SECRET');
    if (expected && secret !== expected) {
      throw new UnauthorizedException('Invalid Vapi server secret');
    }

    const message = body?.message;
    if (!message) {
      return { received: true };
    }

    switch (message.type) {
      case 'tool-calls': {
        const toolCallList = message.toolCallList || message.toolCalls || [];
        const normalized = toolCallList.map((tc: any) => ({
          id: tc.id,
          name: tc.name || tc.function?.name,
          arguments: parseArguments(tc.arguments ?? tc.function?.arguments),
        }));
        const results = await this.vapiService.handleToolCalls(normalized);
        return { results };
      }

      case 'end-of-call-report': {
        const call = message.call || {};
        const artifact = message.artifact || {};
        await this.vapiService.logCall({
          call_id: call.id || message.call?.id || 'unknown',
          phone_number: call.customer?.number,
          summary: message.summary || artifact.summary,
          transcript: (artifact.messages || []).map((m: any) => ({
            role: m.role,
            message: m.message,
          })),
          raw_payload: message,
        });
        return { received: true };
      }

      default:
        return { received: true };
    }
  }
}

// Vapi's tool-call arguments arrive as a JSON string in some payload shapes
// and as an already-parsed object in others. Blindly JSON.parse()-ing an
// object throws, and a naive fallback silently swallowed that into `{}` —
// losing the real arguments entirely and crashing downstream on an
// undefined field (e.g. phone_number.replace(...) in PatientsService).
// This handles both shapes explicitly instead of guessing.
function parseArguments(value: any): Record<string, any> {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') return value;
  return {};
}
