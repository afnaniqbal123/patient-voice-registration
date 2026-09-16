import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PatientsModule } from '../patients/patients.module';
import { VapiController } from './vapi.controller';
import { VapiService } from './vapi.service';
import { CallLog, CallLogSchema } from '../call-logs/call-log.schema';

@Module({
  imports: [PatientsModule, MongooseModule.forFeature([{ name: CallLog.name, schema: CallLogSchema }])],
  controllers: [VapiController],
  providers: [VapiService],
})
export class VapiModule {}
