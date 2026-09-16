import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CallLog, CallLogDocument } from './call-log.schema';
import { ResponseEnvelopeInterceptor } from '../common/response-envelope.interceptor';

// Read-only endpoint backing the dashboard's "recent calls" view (bonus:
// call transcript/summary storage).
@UseInterceptors(ResponseEnvelopeInterceptor)
@Controller('call-logs')
export class CallLogsController {
  constructor(@InjectModel(CallLog.name) private readonly callLogModel: Model<CallLogDocument>) {}

  @Get()
  async findAll(@Query('patient_id') patientId?: string) {
    const filter = patientId ? { patient_id: patientId } : {};
    return this.callLogModel.find(filter).sort({ created_at: -1 }).limit(50).exec();
  }
}
