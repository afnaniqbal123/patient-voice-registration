import { PartialType } from '@nestjs/mapped-types';
import { CreatePatientDto } from './create-patient.dto';

// Partial updates allowed per spec — every field becomes optional, but any
// field that IS provided still runs through the same validators as create.
export class UpdatePatientDto extends PartialType(CreatePatientDto) {}
