// Sends silent PushKit VoIP pushes via direct APNs (HTTP/2, token-based auth).
// This is a SEPARATE delivery path from fcm.provider.ts: FCM cannot deliver to
// an iOS VoIP token — Apple requires these go straight to APNs on the
// `<bundleId>.voip` topic, with no `aps.alert` (the native PKPushRegistryDelegate
// on the client reports the call to CallKit itself; an OS-rendered alert would
// be redundant and isn't supported for VoIP pushes anyway).
//
// Mirrors the graceful-degradation pattern in fcm.provider.ts: if key material
// isn't configured, createApnsVoipProvider() returns null and callers fall
// back to FCM-only delivery instead of throwing.

import * as apn from '@parse/node-apn';

export interface ApnsVoipSendResult {
  delivered: number;
  failedTokens: string[];
}

export interface ApnsVoipProvider {
  sendVoip(tokens: string[], data: Record<string, string>): Promise<ApnsVoipSendResult>;
}

// APNs response reasons that mean the token is permanently invalid and
// should be deactivated (mirrors STALE_ERROR_CODES in fcm.provider.ts).
const STALE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

function resolveKey(): string | Buffer | null {
  const b64 = process.env.APNS_KEY_BASE64;
  if (b64) {
    try {
      return Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
  }
  const path = process.env.APNS_KEY_PATH;
  return path || null;
}

class ApnsVoipPushProvider implements ApnsVoipProvider {
  constructor(private readonly provider: apn.Provider, private readonly topic: string) {}

  async sendVoip(tokens: string[], data: Record<string, string>): Promise<ApnsVoipSendResult> {
    const notification = new apn.Notification();
    notification.topic = this.topic;
    notification.pushType = 'voip';
    // VoIP payloads are data-only — no aps.alert/sound/badge.
    notification.payload = data;

    const result = await this.provider.send(notification, tokens);
    const failedTokens = result.failed
      .filter((f) => f.response?.reason && STALE_REASONS.has(f.response.reason))
      .map((f) => f.device);

    return { delivered: result.sent.length, failedTokens };
  }
}

export function createApnsVoipProvider(): ApnsVoipProvider | null {
  const key = resolveKey();
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!key || !keyId || !teamId || !bundleId) return null;

  const topic = process.env.APNS_VOIP_TOPIC || `${bundleId}.voip`;
  const production = process.env.APNS_PRODUCTION === 'true';

  try {
    const provider = new apn.Provider({
      token: { key, keyId, teamId },
      production,
    });
    return new ApnsVoipPushProvider(provider, topic);
  } catch {
    return null;
  }
}
