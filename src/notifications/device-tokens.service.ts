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
    tokenType?: 'fcm' | 'voip';
  }) {
    // A push token is tied to an app INSTALL, not a user — the common
    // "log out, a different person logs into the same device" case can
    // hand this exact token string to a new userId without FCM ever
    // rotating it. `token` alone has its own unique index (schema.ts), so
    // a plain upsert keyed on {userId, token} would try to INSERT a new
    // doc while an old doc for the previous owner still holds that token
    // string — a duplicate-key error (E11000), uncaught, surfacing as an
    // unhandled 500 on every re-registration in that scenario. Correct
    // WhatsApp-like behavior: the token belongs to whoever is currently
    // logged in on that install, so reassign it — deleting any other
    // user's row for this exact token first makes that safe.
    await this.model.deleteMany({ token: input.token, userId: { $ne: input.userId } });
    await this.model.updateOne(
      { userId: input.userId, token: input.token },
      {
        $set: {
          platform: input.platform,
          deviceId: input.deviceId ?? null,
          active: true,
          tokenType: input.tokenType ?? 'fcm',
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

  // Logout/account-deletion cleanup for a whole device install — both its
  // fcm and voip rows, in case the client only has the deviceId left (e.g.
  // local storage was partly cleared) rather than every exact token value.
  async deactivateForDevice(input: { userId: string; deviceId: string }) {
    const result = await this.model.updateMany(
      { userId: input.userId, deviceId: input.deviceId },
      { $set: { active: false } },
    );
    return { ok: true, deactivated: (result as any).modifiedCount ?? 0 };
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
    // Exclude voip-only tokens (they can't be sent through FCM). `$ne` rather
    // than an exact 'fcm' match so documents written before `tokenType`
    // existed (field absent) still count as fcm-compatible.
    const rows = await this.model
      .find({ userId, active: true, tokenType: { $ne: 'voip' } })
      .select({ token: 1 });
    return rows.map((r) => String((r as any).token));
  }

  async listActiveVoipTokens(userId: string): Promise<string[]> {
    const rows = await this.model
      .find({ userId, active: true, tokenType: 'voip', platform: 'ios' })
      .select({ token: 1 });
    return rows.map((r) => String((r as any).token));
  }
}
