import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PinsService } from './pins.service';
import { Pin, PinSchema } from './pin.schema';
import { Message, MessageSchema } from '../messages/schemas/message.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Pin.name, schema: PinSchema },
      // Needed so setPinned() can verify the message actually belongs to
      // the conversation being pinned in, rather than trusting the
      // client-submitted pair blindly.
      { name: Message.name, schema: MessageSchema },
    ]),
  ],
  providers: [PinsService],
  exports: [PinsService],
})
export class PinsModule {}
