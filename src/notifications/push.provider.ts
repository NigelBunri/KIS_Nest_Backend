export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export type PushSendResult = {
  delivered: number;
  /** Permanently invalid tokens (unregistered/malformed) — safe to deactivate. */
  failedTokens: string[];
  /** Failed for a reason that may resolve on its own (rate limit, transient
   * 5xx, etc.) — NOT deactivated, eligible for one bounded retry. */
  transientTokens?: string[];
};

export interface PushProvider {
  send(tokens: string[], msg: PushMessage): Promise<PushSendResult>;
}

// Compile-safe default. Also the "obvious operational signal" for a
// misconfigured/missing FCM credential (see createFcmProvider) — this
// silently returning delivered:0 for every send is why
// NotificationsService.onModuleInit logs at error level when this class is
// active, and why /health exposes fcm_configured so it isn't just a log line
// nobody is watching.
export class DummyPushProvider implements PushProvider {
  async send(tokens: string[], msg: PushMessage) {
    return { delivered: 0, failedTokens: [], transientTokens: [] };
  }
}
