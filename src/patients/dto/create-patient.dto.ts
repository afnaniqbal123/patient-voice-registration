import {
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Sex } from '../patient.schema';
import { US_STATE_ABBREVIATIONS } from '../../common/us-states';
import { IsValidDateOfBirth } from '../validators/date-of-birth.validator';

const NAME_PATTERN = /^[A-Za-z]+([-' ][A-Za-z]+)*$/;

const normalizeDigits = ({ value }: { value: any }) =>
  typeof value === 'string' ? value.replace(/\D/g, '') : value;

export class CreatePatientDto {
  @IsString()
  @Matches(NAME_PATTERN, {
    message: 'first_name must be alphabetic and may include hyphens/apostrophes',
  })
  @Length(1, 50)
  first_name: string;

  @IsString()
  @Matches(NAME_PATTERN, {
    message: 'last_name must be alphabetic and may include hyphens/apostrophes',
  })
  @Length(1, 50)
  last_name: string;

  @IsValidDateOfBirth()
  date_of_birth: string;

  @IsEnum(Sex, { message: 'sex must be one of: Male, Female, Other, Decline to Answer' })
  sex: Sex;

  @Transform(normalizeDigits)
  @Matches(/^\d{10}$/, { message: 'phone_number must be a valid U.S. 10-digit phone number' })
  phone_number: string;

  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  email?: string;

  @IsString()
  @IsNotEmpty()
  address_line_1: string;

  @IsOptional()
  @IsString()
  address_line_2?: string;

  @IsString()
  @Length(1, 100)
  city: string;

  @IsIn(US_STATE_ABBREVIATIONS, { message: 'state must be a valid 2-letter U.S. state abbreviation' })
  state: string;

  @Matches(/^\d{5}(-\d{4})?$/, { message: 'zip_code must be a 5-digit or ZIP+4 U.S. format' })
  zip_code: string;

  @IsOptional()
  @IsString()
  insurance_provider?: string;

  @IsOptional()
  @IsString()
  insurance_member_id?: string;

  @IsOptional()
  @IsString()
  preferred_language?: string;

  @IsOptional()
  @IsString()
  emergency_contact_name?: string;

  @IsOptional()
  @Transform(normalizeDigits)
  @Matches(/^\d{10}$/, { message: 'emergency_contact_phone must be a valid U.S. 10-digit phone number' })
  emergency_contact_phone?: string;
}
