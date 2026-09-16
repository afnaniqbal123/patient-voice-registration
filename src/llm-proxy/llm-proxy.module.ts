import { Module } from '@nestjs/common';
import { LlmProxyController } from './llm-proxy.controller';
import { ThoughtSignatureCache } from './thought-signature-cache.service';

@Module({
  controllers: [LlmProxyController],
  providers: [ThoughtSignatureCache],
})
export class LlmProxyModule {}
