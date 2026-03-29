import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ThreadsService } from './threads.service';
import { Thread, ThreadSchema } from './thread.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Thread.name, schema: ThreadSchema }])],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
