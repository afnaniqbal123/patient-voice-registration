import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { PatientsModule } from './patients/patients.module';
import { VapiModule } from './vapi/vapi.module';
import { CallLogsModule } from './call-logs/call-logs.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(
      process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/patient_registration',
    ),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'dashboard'),
      serveRoot: '/dashboard',
    }),
    PatientsModule,
    VapiModule,
    CallLogsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
