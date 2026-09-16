import { Module } from '@nestjs/common';
import { LlmProxyController } from './llm-proxy.controller';

@Module({
  controllers: [LlmProxyController],
})
export class LlmProxyModule {}
