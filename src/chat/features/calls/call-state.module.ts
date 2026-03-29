import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallStateService } from './call-state.service';
import { CallState, CallStateSchema } from './schemas/call-state.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: CallState.name, schema: CallStateSchema }])],
  providers: [CallStateService],
  exports: [CallStateService],
})
export class CallStateModule {}
