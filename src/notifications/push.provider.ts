export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export interface PushProvider {
  send(tokens: string[], msg: PushMessage): Promise<{ delivered: number }>;
}

// Compile-safe default
export class DummyPushProvider implements PushProvider {
  async send(tokens: string[], msg: PushMessage) {
    return { delivered: 0 };
  }
}
