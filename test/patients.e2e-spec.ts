import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongooseModule } from '@nestjs/mongoose';
import { PatientsModule } from '../src/patients/patients.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from '../src/common/response-envelope.interceptor';

describe('Patients API (e2e)', () => {
  let app: INestApplication;
  let mongod: MongoMemoryServer;
  let createdPatientId: string;

  const validPatient = {
    first_name: 'Jane',
    last_name: 'Doe',
    date_of_birth: '05/14/1990',
    sex: 'Female',
    phone_number: '(202) 555-0101',
    address_line_1: '123 Main St',
    city: 'Springfield',
    state: 'IL',
    zip_code: '62704',
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), PatientsModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, errorHttpStatusCode: 422 }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await mongod.stop();
  });

  it('POST /patients creates a patient and normalizes phone digits', async () => {
    const res = await request(app.getHttpServer()).post('/patients').send(validPatient).expect(201);
    expect(res.body.error).toBeNull();
    expect(res.body.data.patient_id).toBeDefined();
    expect(res.body.data.phone_number).toBe('2025550101');
    createdPatientId = res.body.data.patient_id;
  });

  it('POST /patients rejects an invalid (future) date of birth', async () => {
    const res = await request(app.getHttpServer())
      .post('/patients')
      .send({ ...validPatient, phone_number: '2025550102', date_of_birth: '01/01/2099' })
      .expect(422);
    expect(res.body.data).toBeNull();
    expect(res.body.error).toBeDefined();
  });

  it('POST /patients rejects a malformed phone number', async () => {
    await request(app.getHttpServer())
      .post('/patients')
      .send({ ...validPatient, phone_number: '123' })
      .expect(422);
  });

  it('GET /patients/:id retrieves the created patient', async () => {
    const res = await request(app.getHttpServer()).get(`/patients/${createdPatientId}`).expect(200);
    expect(res.body.data.first_name).toBe('Jane');
  });

  it('GET /patients?last_name= filters results', async () => {
    const res = await request(app.getHttpServer()).get('/patients?last_name=Doe').expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('GET /patients/:id 404s for an unknown id', async () => {
    await request(app.getHttpServer()).get('/patients/does-not-exist').expect(404);
  });

  it('PUT /patients/:id applies a partial update', async () => {
    const res = await request(app.getHttpServer())
      .put(`/patients/${createdPatientId}`)
      .send({ city: 'Chicago' })
      .expect(200);
    expect(res.body.data.city).toBe('Chicago');
  });

  it('DELETE /patients/:id soft-deletes (record no longer listed, but not hard-deleted)', async () => {
    await request(app.getHttpServer()).delete(`/patients/${createdPatientId}`).expect(200);
    await request(app.getHttpServer()).get(`/patients/${createdPatientId}`).expect(404);
  });
});
