// Real, Mongo-backed test (isolated local test database, not mocked) for
// the fix made in this pass: toggleReaction() previously had no isDeleted
// guard at all (votePoll already did), so a reaction could be added to a
// message the sender/moderator had deleted. Also verifies — by actually
// running it, not just reading the code — that toggleReaction() is
// conversation-type-agnostic: conversationId is a plain string field with
// no branching anywhere in this service, so a Channel-backed conversation
// exercises the exact same code path as a DM/group, confirmed here with a
// conversationId that stands in for a Channel's real UUID.
//
// Connects directly to a real local MongoDB (kis_nest_updates_test,
// dropped and isolated for this run) rather than mocking Mongoose — the
// bug this test guards against is a real persistence-layer query
// condition (isDeleted), which a mocked model can't meaningfully exercise.

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Model, connect, Connection } from 'mongoose';
import { Message, MessageSchema, MessageDocument } from '../messages/schemas/message.schema';
import { ReactionsService } from './reactions.service';

const TEST_MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/kis_nest_updates_test';

describe('ReactionsService (real Mongo, Channel-shaped conversation)', () => {
  let mongoConnection: Connection;
  let messageModel: Model<MessageDocument>;
  let service: ReactionsService;

  const CHANNEL_CONVERSATION_ID = 'channel-conv-11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    mongoConnection = (await connect(TEST_MONGO_URI)).connection;
    const module: TestingModule = await Test.createTestingModule({
      imports: [MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }])],
      providers: [ReactionsService],
    })
      .overrideProvider(getModelToken(Message.name))
      .useValue(mongoConnection.model(Message.name, MessageSchema))
      .compile();

    service = module.get<ReactionsService>(ReactionsService);
    messageModel = module.get<Model<MessageDocument>>(getModelToken(Message.name));
  });

  afterEach(async () => {
    await messageModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await mongoConnection.close();
  });

  async function createMessage(overrides: Partial<Message> = {}) {
    return messageModel.create({
      conversationId: CHANNEL_CONVERSATION_ID,
      senderId: 'owner-user-1',
      clientId: `client-${Date.now()}-${Math.random()}`,
      seq: Math.floor(Math.random() * 1_000_000),
      kind: 'text',
      text: 'Channel broadcast update',
      reactions: [],
      ...overrides,
    });
  }

  it('adds a reaction to a live channel message', async () => {
    const msg = await createMessage();
    const result = await service.toggleReaction({
      userId: 'follower-1',
      conversationId: CHANNEL_CONVERSATION_ID,
      messageId: String(msg._id),
      emoji: '🙏',
    });
    expect(result.reactions).toHaveLength(1);
    expect(result.reactions[0]).toMatchObject({ userId: 'follower-1', emoji: '🙏' });
  });

  it('toggles the same emoji off on a second call (WhatsApp-style toggle)', async () => {
    const msg = await createMessage();
    await service.toggleReaction({
      userId: 'follower-1', conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), emoji: '❤️',
    });
    const second = await service.toggleReaction({
      userId: 'follower-1', conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), emoji: '❤️',
    });
    expect(second.reactions).toHaveLength(0);
  });

  it('switching emoji replaces the previous reaction, not stacks it', async () => {
    const msg = await createMessage();
    await service.toggleReaction({
      userId: 'follower-1', conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), emoji: '👍',
    });
    const second = await service.toggleReaction({
      userId: 'follower-1', conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), emoji: '🎉',
    });
    expect(second.reactions).toHaveLength(1);
    expect(second.reactions[0]).toMatchObject({ userId: 'follower-1', emoji: '🎉' });
  });

  it('two different followers reacting both persist independently', async () => {
    const msg = await createMessage();
    await service.toggleReaction({
      userId: 'follower-1', conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), emoji: '👍',
    });
    const result = await service.toggleReaction({
      userId: 'follower-2', conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), emoji: '👍',
    });
    expect(result.reactions).toHaveLength(2);
  });

  it('rejects reacting to a deleted message (the fix under test)', async () => {
    const msg = await createMessage({ isDeleted: true } as any);
    await expect(
      service.toggleReaction({
        userId: 'follower-1', conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), emoji: '👍',
      }),
    ).rejects.toThrow('Message not found');

    const reloaded = await messageModel.findById(msg._id);
    expect(reloaded?.reactions).toHaveLength(0);
  });

  it('rejects an unknown messageId', async () => {
    const fakeId = '507f1f77bcf86cd799439011';
    await expect(
      service.toggleReaction({
        userId: 'follower-1', conversationId: CHANNEL_CONVERSATION_ID, messageId: fakeId, emoji: '👍',
      }),
    ).rejects.toThrow('Message not found');
  });
});
