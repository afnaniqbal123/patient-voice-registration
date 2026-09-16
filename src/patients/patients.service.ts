import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Patient, PatientDocument } from './patient.schema';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { QueryPatientsDto } from './dto/query-patients.dto';

@Injectable()
export class PatientsService {
  private readonly logger = new Logger(PatientsService.name);

  constructor(
    @InjectModel(Patient.name) private readonly patientModel: Model<PatientDocument>,
  ) {}

  async create(dto: CreatePatientDto): Promise<PatientDocument> {
    const created = new this.patientModel(dto);
    const saved = await created.save();
    this.logger.log(`Created patient ${saved.patient_id} (${saved.first_name} ${saved.last_name})`);
    return saved;
  }

  async findAll(query: QueryPatientsDto): Promise<PatientDocument[]> {
    const filter: Record<string, any> = { deleted_at: null };
    if (query.last_name) {
      filter.last_name = new RegExp(`^${escapeRegex(query.last_name)}$`, 'i');
    }
    if (query.date_of_birth) {
      filter.date_of_birth = query.date_of_birth;
    }
    if (query.phone_number) {
      filter.phone_number = query.phone_number.replace(/\D/g, '');
    }
    return this.patientModel.find(filter).sort({ created_at: -1 }).exec();
  }

  async findOne(patientId: string): Promise<PatientDocument> {
    const patient = await this.patientModel.findOne({ patient_id: patientId, deleted_at: null }).exec();
    if (!patient) {
      throw new NotFoundException(`Patient ${patientId} not found`);
    }
    return patient;
  }

  async findByPhoneNumber(phoneNumber: string): Promise<PatientDocument | null> {
    const digits = phoneNumber.replace(/\D/g, '');
    if (digits.length !== 10) {
      throw new UnprocessableEntityException('phone_number must be a valid U.S. 10-digit phone number');
    }
    return this.patientModel.findOne({ phone_number: digits, deleted_at: null }).exec();
  }

  async update(patientId: string, dto: UpdatePatientDto): Promise<PatientDocument> {
    const patient = await this.findOne(patientId);
    Object.assign(patient, dto);
    const saved = await patient.save();
    this.logger.log(`Updated patient ${saved.patient_id}`);
    return saved;
  }

  async softDelete(patientId: string): Promise<PatientDocument> {
    const patient = await this.findOne(patientId);
    patient.deleted_at = new Date();
    const saved = await patient.save();
    this.logger.log(`Soft-deleted patient ${saved.patient_id}`);
    return saved;
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
