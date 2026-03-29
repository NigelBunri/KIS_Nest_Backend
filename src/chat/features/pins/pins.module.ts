import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PinsService } from './pins.service';
import { Pin, PinSchema } from './pin.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Pin.name, schema: PinSchema }])],
  providers: [PinsService],
  exports: [PinsService],
})
export class PinsModule {}
