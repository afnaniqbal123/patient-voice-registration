import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CallLogDocument = CallLog & Document;

// Bonus: call transcript/summary storage, linked to the patient record when
// we can resolve one, so a reviewer can see what was actually said on a call.
@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'call_logs' })
export class CallLog {
  @Prop({ required: true, index: true })
  call_id: string;

  @Prop()
  patient_id?: string;

  @Prop()
  phone_number?: string;

  @Prop()
  summary?: string;

  @Prop({ type: [Object], default: [] })
  transcript?: Array<{ role: string; message: string }>;

  @Prop({ type: Object })
  raw_payload?: Record<string, any>;
}

export const CallLogSchema = SchemaFactory.createForClass(CallLog);
