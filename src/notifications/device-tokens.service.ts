import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DeviceToken, DeviceTokenDocument } from './schemas/device-token.schema';

@Injectable()
export class DeviceTokensService {
  private readonly logger = new Logger(DeviceTokensService.name);

  constructor(
    @InjectModel(DeviceToken.name) private readonly model: Model<DeviceTokenDocument>,
  ) {}

  async upsert(input: {
    userId: string;
    platform: 'android' | 'ios' | 'web';
    token: string;
    deviceId?: string;
  }) {
    await this.model.updateOne(
      { userId: input.userId, token: input.token },
      {
        $set: {
          platform: input.platform,
          deviceId: input.deviceId ?? null,
          active: true,
        },
        $setOnInsert: { userId: input.userId, token: input.token },
      },
      { upsert: true },
    );
    return { ok: true };
  }

  async deactivate(input: { userId: string; token: string }) {
    await this.model.updateOne(
      { userId: input.userId, token: input.token },
      { $set: { active: false } },
    );
    return { ok: true };
  }

  async bulkDeactivate(tokens: string[]): Promise<number> {
    if (!tokens.length) return 0;
    const result = await this.model.updateMany(
      { token: { $in: tokens } },
      { $set: { active: false } },
    );
    const count = (result as any).modifiedCount ?? 0;
    if (count > 0) {
      this.logger.log(`Deactivated ${count} stale push token(s).`);
    }
    return count;
  }

  async listActiveTokens(userId: string): Promise<string[]> {
    const rows = await this.model.find({ userId, active: true }).select({ token: 1 });
    return rows.map((r) => String((r as any).token));
  }
}
