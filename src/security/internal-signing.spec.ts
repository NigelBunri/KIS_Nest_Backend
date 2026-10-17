/// <reference types="jest" />

import { verifyInternalSignature, signedInternalHeaders } from './internal-signing';

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

  // Regression: stableStringify previously collapsed a NESTED null to ''
  // instead of the JSON literal "null" (only a wholly-absent body should
  // ever collapse to ''), producing a canonical form Django's
  // canonical_body_hash (json.dumps(None) -> "null") could never match -
  // confirmed live in production: apps/statuses/views.py's
  // notify_status_discussion_event sends {"id": ..., "parent_id": null,
  // ...} for every top-level StatusComment, and every one of those calls
  // 401'd with signature_mismatch until this was fixed. This test
  // round-trips signedInternalHeaders -> verifyInternalSignature (the
  // same pair Django's sign_internal_request/verify_internal_request
  // exercise against each other) rather than hand-computing an HMAC, so
  // it fails the same way a real cross-service call would.
  it('round-trips a body containing a nested null field (e.g. a top-level comment reply)', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1700000000 * 1000);
    const body = { id: 'comment-1', parent_id: null, author: { id: 'user-1' } };

    const headers = signedInternalHeaders({
      method: 'POST',
      url: '/internal/status-discussions/status-1/broadcast',
      body,
      secret: 'shared-secret',
    });

    const result = verifyInternalSignature({
      method: 'POST',
      url: '/internal/status-discussions/status-1/broadcast',
      body,
      secret: 'shared-secret',
      headers: {
        'x-internal-timestamp': headers['X-Internal-Timestamp'],
        'x-internal-nonce': headers['X-Internal-Nonce'],
        'x-internal-signature': headers['X-Internal-Signature'],
      },
    });

    expect(result).toEqual({ ok: true, reason: 'ok' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
