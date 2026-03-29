import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallsService } from './calls.service';
import { CallSession, CallSessionSchema } from './schemas/call-session.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CallSession.name, schema: CallSessionSchema }]),
  ],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
