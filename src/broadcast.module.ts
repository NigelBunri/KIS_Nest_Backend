// ARCHIVED/LEGACY (2026-10-04): feature-flagged off everywhere (FF_BROADCAST_CORE / FF_FEEDS_BROADCAST unset
// in every .env*/docker-compose.yml), unreachable at runtime, untouched since its single creation
// commit ~6 months ago. BLOCKED from deletion: feeds.module.ts/feeds.controller.ts hard-depend on
// this module at compile time (see src/ARCHIVED_LEGACY_BROADCAST.md for the full writeup).
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { AuthModule } from './auth/auth.module'
import { HttpAuthGuard } from './auth/http-auth.guard'
import { ChatModule } from './chat/chat.module'
import { BroadcastController } from './broadcast.controller'
import { BroadcastItem, BroadcastItemSchema } from './broadcast-item.schema'
import { BroadcastReaction, BroadcastReactionSchema } from './broadcast-reaction.schema'
import { BroadcastReactionsService } from './broadcast-reactions.service'
import { BroadcastService } from './broadcast.service'
import { FeatureFlagGuard } from './feature-flag.guard'
import { ScopesGuard } from './scopes.guard'

@Module({
  imports: [
    AuthModule,
    ChatModule,
    MongooseModule.forFeature([
      { name: BroadcastItem.name, schema: BroadcastItemSchema },
      { name: BroadcastReaction.name, schema: BroadcastReactionSchema },
    ]),
  ],
  controllers: [BroadcastController],
  providers: [FeatureFlagGuard, ScopesGuard, BroadcastService, BroadcastReactionsService, HttpAuthGuard],
  exports: [FeatureFlagGuard, ScopesGuard, BroadcastService],
})
export class BroadcastModule {}
