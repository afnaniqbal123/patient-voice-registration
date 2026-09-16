import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

export enum Sex {
  MALE = 'Male',
  FEMALE = 'Female',
  OTHER = 'Other',
  DECLINE_TO_ANSWER = 'Decline to Answer',
}

export type PatientDocument = Patient & Document;

@Schema({ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'patients' })
export class Patient {
  @Prop({ type: String, default: () => uuidv4(), unique: true, index: true })
  patient_id: string;

  @Prop({ required: true, trim: true, maxlength: 50 })
  first_name: string;

  @Prop({ required: true, trim: true, maxlength: 50 })
  last_name: string;

  @Prop({ required: true })
  date_of_birth: string; // stored as MM/DD/YYYY per spec

  @Prop({ required: true, enum: Sex })
  sex: Sex;

  @Prop({ required: true, index: true })
  phone_number: string; // normalized to 10 digits

  @Prop()
  email?: string;

  @Prop({ required: true })
  address_line_1: string;

  @Prop()
  address_line_2?: string;

  @Prop({ required: true, maxlength: 100 })
  city: string;

  @Prop({ required: true })
  state: string;

  @Prop({ required: true })
  zip_code: string;

  @Prop()
  insurance_provider?: string;

  @Prop()
  insurance_member_id?: string;

  @Prop({ default: 'English' })
  preferred_language?: string;

  @Prop()
  emergency_contact_name?: string;

  @Prop()
  emergency_contact_phone?: string;

  @Prop({ type: Date, default: null })
  deleted_at?: Date | null;

  created_at?: Date;
  updated_at?: Date;
}

export const PatientSchema = SchemaFactory.createForClass(Patient);

PatientSchema.index({ last_name: 1 });
PatientSchema.index({ date_of_birth: 1 });
