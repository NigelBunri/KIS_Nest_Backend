import { Module } from '@nestjs/common';
import { PresenceService } from './presence.service';

@Module({
  providers: [PresenceService],
  exports: [PresenceService], // ✅ required so other modules can inject it
})
export class PresenceModule {}
