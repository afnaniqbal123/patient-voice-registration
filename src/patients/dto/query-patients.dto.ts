import { IsOptional, IsString } from 'class-validator';

export class QueryPatientsDto {
  @IsOptional()
  @IsString()
  last_name?: string;

  @IsOptional()
  @IsString()
  date_of_birth?: string;

  @IsOptional()
  @IsString()
  phone_number?: string;
}
