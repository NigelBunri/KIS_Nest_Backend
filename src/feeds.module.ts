import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { AuthModule } from './auth/auth.module'
import { HttpAuthGuard } from './auth/http-auth.guard'
import { BroadcastModule } from './broadcast.module'
import { MessagesModule } from './chat/features/messages/messages.module'
import { FeedsController } from './feeds.controller'
import { FeedsService } from './feeds.service'
import { FeedPost, FeedPostSchema } from './feed-post.schema'

@Module({
  imports: [
    AuthModule,
    BroadcastModule,
    MessagesModule,
    MongooseModule.forFeature([{ name: FeedPost.name, schema: FeedPostSchema }]),
  ],
  controllers: [FeedsController],
  providers: [FeedsService, HttpAuthGuard],
})
export class FeedsModule {}
