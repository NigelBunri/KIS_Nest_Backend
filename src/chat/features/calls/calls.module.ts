import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallsService } from './calls.service';
import { CallSession, CallSessionSchema } from './schemas/call-session.schema';

// CallsController is registered directly on ChatModule (which already
// provides DjangoConversationClient/RateLimitService for it), not here —
// this module only owns CallsService's persistence layer.
@Module({
  imports: [
    MongooseModule.forFeature([{ name: CallSession.name, schema: CallSessionSchema }]),
  ],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
