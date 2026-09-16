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
          arguments:
            typeof tc.arguments === 'string'
              ? safeJsonParse(tc.arguments)
              : tc.arguments || safeJsonParse(tc.function?.arguments) || {},
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

function safeJsonParse(value: any) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
