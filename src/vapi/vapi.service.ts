import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PatientsService } from '../patients/patients.service';
import { CreatePatientDto } from '../patients/dto/create-patient.dto';
import { UpdatePatientDto } from '../patients/dto/update-patient.dto';
import { CallLog, CallLogDocument } from '../call-logs/call-log.schema';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
}

/**
 * Bridges Vapi's function-calling webhook to the same PatientsService used
 * by the public REST API, so the voice agent and the HTTP API can never
 * drift into two different sources of truth. All inputs still pass through
 * the CreatePatientDto/UpdatePatientDto validators — the LLM is not trusted
 * to have already sanitized anything.
 */
@Injectable()
export class VapiService {
  private readonly logger = new Logger(VapiService.name);

  constructor(
    private readonly patientsService: PatientsService,
    @InjectModel(CallLog.name) private readonly callLogModel: Model<CallLogDocument>,
  ) {}

  async handleToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      results.push({
        toolCallId: call.id,
        result: await this.dispatch(call.name, call.arguments || {}),
      });
    }
    return results;
  }

  private async dispatch(name: string, args: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case 'lookup_patient_by_phone':
          return await this.lookupPatientByPhone(args);
        case 'create_patient':
          return await this.createPatient(args);
        case 'update_patient':
          return await this.updatePatient(args);
        case 'propose_appointment':
          return this.proposeAppointment();
        default:
          return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
      }
    } catch (err: any) {
      this.logger.error(`Tool call "${name}" failed: ${err.message}`, err.stack);
      return JSON.stringify({ ok: false, error: err.message || 'Internal error' });
    }
  }

  private async lookupPatientByPhone(args: Record<string, any>): Promise<string> {
    const patient = await this.patientsService.findByPhoneNumber(args.phone_number);
    if (!patient) {
      return JSON.stringify({ ok: true, found: false });
    }
    return JSON.stringify({
      ok: true,
      found: true,
      patient_id: patient.patient_id,
      first_name: patient.first_name,
      last_name: patient.last_name,
      date_of_birth: patient.date_of_birth,
    });
  }

  private async createPatient(args: Record<string, any>): Promise<string> {
    const dto = plainToInstance(CreatePatientDto, args);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: false });
    if (errors.length > 0) {
      return JSON.stringify({ ok: false, error: 'validation_failed', details: flattenErrors(errors) });
    }
    const patient = await this.patientsService.create(dto);
    return JSON.stringify({
      ok: true,
      patient_id: patient.patient_id,
      first_name: patient.first_name,
      last_name: patient.last_name,
    });
  }

  private async updatePatient(args: Record<string, any>): Promise<string> {
    const { patient_id, ...fields } = args;
    if (!patient_id) {
      return JSON.stringify({ ok: false, error: 'patient_id is required' });
    }
    const dto = plainToInstance(UpdatePatientDto, fields);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: false, skipMissingProperties: true });
    if (errors.length > 0) {
      return JSON.stringify({ ok: false, error: 'validation_failed', details: flattenErrors(errors) });
    }
    const patient = await this.patientsService.update(patient_id, dto);
    return JSON.stringify({ ok: true, patient_id: patient.patient_id });
  }

  // Bonus: mock appointment scheduling — no real calendar backend, just a
  // plausible next-business-day slot so the agent can offer it after
  // registration, per the assessment's optional bonus list.
  private proposeAppointment(): string {
    const slot = nextBusinessDayAt(10);
    return JSON.stringify({
      ok: true,
      appointment_time: slot.toISOString(),
      display: slot.toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    });
  }

  async logCall(payload: {
    call_id: string;
    patient_id?: string;
    phone_number?: string;
    summary?: string;
    transcript?: Array<{ role: string; message: string }>;
    raw_payload?: Record<string, any>;
  }): Promise<void> {
    this.logger.log(
      `Call ${payload.call_id} ended. Summary: ${payload.summary || '(none)'}. Patient: ${payload.patient_id || 'unresolved'}`,
    );
    await this.callLogModel.findOneAndUpdate(
      { call_id: payload.call_id },
      { $set: payload },
      { upsert: true, new: true },
    );
  }
}

function flattenErrors(errors: any[]): string[] {
  return errors.flatMap((e) => Object.values(e.constraints || {}));
}

function nextBusinessDayAt(hour: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }
  date.setHours(hour, 0, 0, 0);
  return date;
}
