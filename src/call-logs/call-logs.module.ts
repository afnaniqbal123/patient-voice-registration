import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallLog, CallLogSchema } from './call-log.schema';
import { CallLogsController } from './call-logs.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: CallLog.name, schema: CallLogSchema }])],
  controllers: [CallLogsController],
})
export class CallLogsModule {}
