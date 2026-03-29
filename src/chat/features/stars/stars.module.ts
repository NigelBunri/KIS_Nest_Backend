import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StarsService } from './stars.service';
import { Star, StarSchema } from './star.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Star.name, schema: StarSchema }])],
  providers: [StarsService],
  exports: [StarsService],
})
export class StarsModule {}
