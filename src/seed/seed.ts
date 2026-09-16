import 'reflect-metadata';
import mongoose from 'mongoose';
import { Patient, PatientSchema, Sex } from '../patients/patient.schema';

const SEED_PATIENTS = [
  {
    first_name: 'Jane',
    last_name: 'Doe',
    date_of_birth: '05/14/1990',
    sex: Sex.FEMALE,
    phone_number: '2025550101',
    email: 'jane.doe@example.com',
    address_line_1: '123 Main St',
    city: 'Springfield',
    state: 'IL',
    zip_code: '62704',
    insurance_provider: 'BlueCross BlueShield',
    insurance_member_id: 'BCB123456',
    preferred_language: 'English',
  },
  {
    first_name: 'Carlos',
    last_name: 'Rivera',
    date_of_birth: '11/02/1985',
    sex: Sex.MALE,
    phone_number: '3105550199',
    address_line_1: '456 Oak Ave',
    address_line_2: 'Apt 3B',
    city: 'Los Angeles',
    state: 'CA',
    zip_code: '90001',
    preferred_language: 'Spanish',
    emergency_contact_name: 'Maria Rivera',
    emergency_contact_phone: '3105550100',
  },
];

async function seed() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/patient_registration';
  await mongoose.connect(uri);
  const PatientModel = mongoose.model(Patient.name, PatientSchema);

  for (const seedPatient of SEED_PATIENTS) {
    const exists = await PatientModel.findOne({ phone_number: seedPatient.phone_number });
    if (exists) {
      console.log(`Skipping ${seedPatient.first_name} ${seedPatient.last_name} — already seeded`);
      continue;
    }
    const created = await PatientModel.create(seedPatient);
    console.log(`Seeded ${created.first_name} ${created.last_name} (${created.patient_id})`);
  }

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
