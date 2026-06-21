// src/realtime/sfu/sfu.module.ts
import { Module } from '@nestjs/common'
import { SfuService } from './sfu.service'

@Module({
  providers: [SfuService],
  exports: [SfuService],
})
export class SfuModule {}
