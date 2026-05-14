/// <reference types="jest" />

import { verifyInternalSignature } from './internal-signing';

describe('internal signing', () => {
  it('verifies Django-compatible canonical JSON bodies with string fields', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1700000000 * 1000);

    const result = verifyInternalSignature({
      method: 'POST',
      url: '/internal/conversations/created',
      body: { conversationId: 'c-1', userIds: ['u-1', 'u-2'] },
      secret: 'shared-secret',
      headers: {
        'x-internal-timestamp': '1700000000',
        'x-internal-nonce': 'abc123',
        'x-internal-signature':
          '46c6d68bac4499f64d8e099815b49104806adea5a57bfd3edfa38b19ca992bb2',
      },
    });

    expect(result).toEqual({ ok: true, reason: 'ok' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
