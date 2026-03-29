// src/chat/chat.module.ts

import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { HttpModule } from '@nestjs/axios' // ✅ required for HttpService

import { AuthModule } from '../auth/auth.module'
import { WsAuthGuard } from '../auth/ws-auth.guard'
import { HttpAuthGuard } from '../auth/http-auth.guard'

import { Message, MessageSchema } from './features/messages/schemas/message.schema'
import {
  ConversationKey,
  ConversationKeySchema,
} from './features/e2ee/schemas/conversation-key.schema'
import {
  BroadcastConversation,
  BroadcastConversationSchema,
} from './features/broadcasts/broadcast-conversation.schema'

import { MessagesService } from './features/messages/messages.service'
import { ReactionsService } from './features/reactions/reactions.service'
import { ReceiptsService } from './features/receipts/receipts.service'
import { SyncService } from './features/sync/sync.service'
import { PresenceService } from './features/presence/presence.service'
import { E2eeKeysService } from './features/e2ee/e2ee-keys.service'

import { DjangoConversationClient } from './integrations/django/django-conversation.client'
import { DjangoSeqClient } from './integrations/django/django-seq.client'

import { RateLimitService } from './infra/rate-limit/rate-limit.service'

import { ChatGateway } from '../realtime/chat.gateway'
import { RealtimeInternalController } from '../realtime/internal.controller'
import { InternalAuthGuard } from '../auth/internal-auth.guard'

// Batch B modules
import { ThreadsModule } from './features/threads/threads.module'
import { PinsModule } from './features/pins/pins.module'
import { PinsController } from './features/pins/pins.controller'
import { StarsModule } from './features/stars/stars.module'
import { ModerationModule } from './features/moderation/moderation.module'
import { ModerationController } from './features/moderation/moderation.controller'
import { CallsModule } from './features/calls/calls.module'
import { SearchModule } from './features/search/search.module'
import { CallsController } from './features/calls/calls.controller'
import { BroadcastsController } from './features/broadcasts/broadcasts.controller'
import { BroadcastCommentsController } from './features/broadcasts/broadcast-comments.controller'
import { BroadcastConversationsService } from './features/broadcasts/broadcast-conversation.service'
import { E2eeController } from './features/e2ee/e2ee.controller'

// ✅ Notifications
import { NotificationsModule } from '../notifications/notifications.module'

// ✅ Optional compact call history
import { CallStateModule } from './features/calls/call-state.module'

@Module({
  imports: [
    AuthModule,

    // ✅ makes HttpService available for DjangoConversationClient/DjangoSeqClient
    HttpModule,

    // shared Message model
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: ConversationKey.name, schema: ConversationKeySchema },
      { name: BroadcastConversation.name, schema: BroadcastConversationSchema },
    ]),

    ThreadsModule,
    PinsModule,
    StarsModule,
    ModerationModule,
    CallsModule,
    SearchModule,

    NotificationsModule,
    CallStateModule,
  ],
  controllers: [
    ModerationController,
    CallsController,
    PinsController,
    BroadcastsController,
    BroadcastCommentsController,
    E2eeController,
    RealtimeInternalController,
  ],
  providers: [
    ChatGateway,
    WsAuthGuard,
    InternalAuthGuard,
    HttpAuthGuard,

    // Batch A services
    MessagesService,
    ReactionsService,
    ReceiptsService,
    SyncService,
    PresenceService,
    BroadcastConversationsService,

    // Django integrations + infra
    DjangoConversationClient,
    DjangoSeqClient,
    RateLimitService,
    E2eeKeysService,
  ],
  exports: [ChatGateway],
})
export class ChatModule {}
