// src/chat/chat.module.ts

import { Module, OnModuleInit } from '@nestjs/common'
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
import { CallsService } from './features/calls/calls.service'
import { SearchModule } from './features/search/search.module'
import { CallsController } from './features/calls/calls.controller'
import { BroadcastsController } from './features/broadcasts/broadcasts.controller'
import { BroadcastCommentsController } from './features/broadcasts/broadcast-comments.controller'
import { BroadcastConversationsService } from './features/broadcasts/broadcast-conversation.service'
import { E2eeController } from './features/e2ee/e2ee.controller'

// ✅ Notifications
import { NotificationsModule } from '../notifications/notifications.module'
import { NotificationsService } from '../notifications/notifications.service'

// ✅ Optional compact call history
import { CallStateModule } from './features/calls/call-state.module'

import { ScheduledMessagesModule } from './features/scheduled-messages/scheduled-messages.module'
import { SfuModule } from '../realtime/sfu/sfu.module'

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
    ScheduledMessagesModule,
    SfuModule,
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
export class ChatModule implements OnModuleInit {
  constructor(
    private readonly callsService: CallsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // CallsService.setNotificationsService is a lazy-injection setter (avoids a
  // circular module dependency between CallsModule and NotificationsModule).
  // ChatModule already imports both, so it's the natural place to wire them
  // together — without this, CallsService's 30s stale-call cleanup sweep can
  // never send missed-call pushes (only the live call.end socket path could).
  onModuleInit() {
    this.callsService.setNotificationsService(this.notificationsService)
  }
}
