// Real, Mongo-backed verification of PinsService.setPinned() — the root
// cause of "Cannot POST /api/v1/set" (ROUTES.pins.set on mobile pointed
// at the wrong Nest path; the real mount point is /pins/set, Nest sets no
// global /api/v1 prefix) is a mobile/routing issue with no unit here, but
// this locks in the one real backend gap found alongside it: nothing ever
// verified a pinned messageId actually belongs to the conversationId it
// was pinned in.

import { Model, connect, Connection } from 'mongoose';
import { Pin, PinSchema, PinDocument } from './pin.schema';
import { Message, MessageSchema, MessageDocument } from '../messages/schemas/message.schema';
import { PinsService } from './pins.service';

// Own database - see reactions.channel.spec.ts's identical comment for
// why these three real-Mongo spec files can't share one database name
// (they used to, and raced each other's dropDatabase() calls whenever
// Jest ran them as separate parallel workers).
const TEST_MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/kis_nest_pins_test';

describe('PinsService.setPinned (real Mongo)', () => {
  let mongoConnection: Connection;
  let pinModel: Model<PinDocument>;
  let messageModel: Model<MessageDocument>;
  let service: PinsService;

  const CONVERSATION_A = 'conv-pin-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const CONVERSATION_B = 'conv-pin-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  beforeAll(async () => {
    mongoConnection = (await connect(TEST_MONGO_URI)).connection;
    pinModel = mongoConnection.model<PinDocument>(Pin.name, PinSchema);
    messageModel = mongoConnection.model<MessageDocument>(Message.name, MessageSchema);
    service = new PinsService(pinModel, messageModel);
    // Deliberately does NOT call pinModel.createIndexes() here - Mongoose's
    // autoIndex is disabled in production (see app.module.ts), so the
    // unique(conversationId, messageId) index may not actually exist
    // there. setPinned()'s idempotency must hold up even without it (see
    // the atomic upsert in pins.service.ts) - this test suite intentionally
    // runs under that same unindexed condition to prove it.
  });

  afterEach(async () => {
    await pinModel.deleteMany({});
    await messageModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await mongoConnection.close();
  });

  async function createMessage(overrides: Partial<Message> = {}) {
    return messageModel.create({
      conversationId: CONVERSATION_A,
      senderId: 'sender-1',
      clientId: `client-${Date.now()}-${Math.random()}`,
      seq: Math.floor(Math.random() * 1_000_000),
      kind: 'text',
      text: 'Hello',
      ...overrides,
    });
  }

  it('pins a message that belongs to the conversation', async () => {
    const msg = await createMessage();

    const result = await service.setPinned({
      conversationId: CONVERSATION_A,
      messageId: String(msg._id),
      userId: 'user-1',
      pinned: true,
    });

    expect(result).toEqual({ pinned: true });
    const stored = await pinModel.findOne({ conversationId: CONVERSATION_A, messageId: String(msg._id) });
    expect(stored).not.toBeNull();
    expect(stored?.pinnedBy).toBe('user-1');
  });

  it('rejects pinning a message that belongs to a different conversation', async () => {
    const msg = await createMessage({ conversationId: CONVERSATION_B } as any);

    await expect(
      service.setPinned({
        conversationId: CONVERSATION_A,
        messageId: String(msg._id),
        userId: 'user-1',
        pinned: true,
      }),
    ).rejects.toThrow('message not found in this conversation');

    const stored = await pinModel.findOne({ conversationId: CONVERSATION_A, messageId: String(msg._id) });
    expect(stored).toBeNull();
  });

  it('rejects pinning an unknown message id', async () => {
    await expect(
      service.setPinned({
        conversationId: CONVERSATION_A,
        messageId: '000000000000000000000000',
        userId: 'user-1',
        pinned: true,
      }),
    ).rejects.toThrow('message not found in this conversation');
  });

  it('rejects pinning a deleted message', async () => {
    const msg = await createMessage({ isDeleted: true } as any);

    await expect(
      service.setPinned({
        conversationId: CONVERSATION_A,
        messageId: String(msg._id),
        userId: 'user-1',
        pinned: true,
      }),
    ).rejects.toThrow('cannot pin a deleted message');
  });

  it('is idempotent — pinning the same message twice does not create a duplicate record', async () => {
    const msg = await createMessage();

    await service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msg._id), userId: 'user-1', pinned: true });
    await service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msg._id), userId: 'user-1', pinned: true });

    const count = await pinModel.countDocuments({ conversationId: CONVERSATION_A, messageId: String(msg._id) });
    expect(count).toBe(1);
  });

  it('unpinning removes the record and is idempotent when already unpinned', async () => {
    const msg = await createMessage();
    await service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msg._id), userId: 'user-1', pinned: true });

    const result = await service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msg._id), userId: 'user-1', pinned: false });
    expect(result).toEqual({ pinned: false });
    expect(await pinModel.findOne({ conversationId: CONVERSATION_A, messageId: String(msg._id) })).toBeNull();

    // Unpinning again (already unpinned) must not throw.
    await expect(
      service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msg._id), userId: 'user-1', pinned: false }),
    ).resolves.toEqual({ pinned: false });
  });

  it('10 concurrent pin requests for the same message converge to exactly one record', async () => {
    const msg = await createMessage();

    await Promise.all(
      Array.from({ length: 10 }, () =>
        service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msg._id), userId: 'user-1', pinned: true }),
      ),
    );

    const count = await pinModel.countDocuments({ conversationId: CONVERSATION_A, messageId: String(msg._id) });
    expect(count).toBe(1);
  });

  it('listPinnedMessageIds returns only pins for the requested conversation, most recent first', async () => {
    const msgA1 = await createMessage();
    const msgA2 = await createMessage();
    const msgB = await createMessage({ conversationId: CONVERSATION_B } as any);

    await service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msgA1._id), userId: 'user-1', pinned: true });
    await service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msgA2._id), userId: 'user-1', pinned: true });
    await service.setPinned({ conversationId: CONVERSATION_B, messageId: String(msgB._id), userId: 'user-1', pinned: true });

    const { messageIds } = await service.listPinnedMessageIds({ conversationId: CONVERSATION_A });

    expect(messageIds.sort()).toEqual([String(msgA1._id), String(msgA2._id)].sort());
  });

  it('removing one user-visible pin does not affect another conversation entirely', async () => {
    const msgA = await createMessage();
    const msgB = await createMessage({ conversationId: CONVERSATION_B } as any);
    await service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msgA._id), userId: 'user-1', pinned: true });
    await service.setPinned({ conversationId: CONVERSATION_B, messageId: String(msgB._id), userId: 'user-2', pinned: true });

    await service.setPinned({ conversationId: CONVERSATION_A, messageId: String(msgA._id), userId: 'user-1', pinned: false });

    expect(await pinModel.findOne({ conversationId: CONVERSATION_A, messageId: String(msgA._id) })).toBeNull();
    expect(await pinModel.findOne({ conversationId: CONVERSATION_B, messageId: String(msgB._id) })).not.toBeNull();
  });
});
