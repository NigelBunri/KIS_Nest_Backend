// Real, Mongo-backed verification (Priority 6: Channel polls) that
// MessagesService.votePoll() — already-existing, generic, no conversation-
// type branching anywhere in it — genuinely works correctly for a
// Channel-shaped conversation: single vote per user (re-voting moves the
// vote, doesn't stack it), rejects voting on a deleted message, rejects an
// unknown option. Connects to a real local MongoDB rather than mocking
// Mongoose, since the behavior under test (option array mutation +
// voters-array membership) is exactly the kind of thing a mock can't
// meaningfully exercise.

import { Model, connect, Connection } from 'mongoose';
import { Message, MessageSchema, MessageDocument } from './schemas/message.schema';
import { MessagesService } from './messages.service';

const TEST_MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/kis_nest_updates_test';

describe('MessagesService.votePoll (real Mongo, Channel-shaped conversation)', () => {
  let mongoConnection: Connection;
  let messageModel: Model<MessageDocument>;
  let service: MessagesService;

  const CHANNEL_CONVERSATION_ID = 'channel-conv-22222222-2222-2222-2222-222222222222';

  beforeAll(async () => {
    mongoConnection = (await connect(TEST_MONGO_URI)).connection;
    messageModel = mongoConnection.model<MessageDocument>(Message.name, MessageSchema);
    // votePoll() only ever touches this.messageModel (confirmed by reading
    // the method) - constructing the service directly rather than through
    // Nest's TestingModule/DI container avoids having to stand up its
    // other constructor dependency (UploadIntent's model) purely to
    // satisfy the injector for a method that never uses it.
    service = new MessagesService(messageModel, {} as any);
  });

  afterEach(async () => {
    await messageModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await mongoConnection.close();
  });

  async function createPollMessage(overrides: Partial<Message> = {}) {
    return messageModel.create({
      conversationId: CHANNEL_CONVERSATION_ID,
      senderId: 'owner-user-1',
      clientId: `client-${Date.now()}-${Math.random()}`,
      seq: Math.floor(Math.random() * 1_000_000),
      kind: 'poll',
      poll: {
        question: 'Which service time works best?',
        options: [
          { id: 'opt-a', text: '9am', votes: 0, voters: [] },
          { id: 'opt-b', text: '11am', votes: 0, voters: [] },
        ],
      },
      ...overrides,
    });
  }

  it('a follower can vote on a channel poll', async () => {
    const msg = await createPollMessage();
    const result = await service.votePoll({
      conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
    });
    const optA = (result as any).poll.options.find((o: any) => o.id === 'opt-a');
    expect(optA.votes).toBe(1);
    expect(optA.voters).toContain('follower-1');
  });

  it('re-voting moves the vote instead of stacking it (single vote per user)', async () => {
    const msg = await createPollMessage();
    await service.votePoll({
      conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
    });
    const result = await service.votePoll({
      conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-b', userId: 'follower-1',
    });
    const options = (result as any).poll.options;
    const optA = options.find((o: any) => o.id === 'opt-a');
    const optB = options.find((o: any) => o.id === 'opt-b');
    expect(optA.votes).toBe(0);
    expect(optA.voters).not.toContain('follower-1');
    expect(optB.votes).toBe(1);
    expect(optB.voters).toContain('follower-1');
  });

  it('re-voting the same option twice does not double-count', async () => {
    const msg = await createPollMessage();
    await service.votePoll({
      conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
    });
    const result = await service.votePoll({
      conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
    });
    const optA = (result as any).poll.options.find((o: any) => o.id === 'opt-a');
    expect(optA.votes).toBe(1);
    expect(optA.voters).toEqual(['follower-1']);
  });

  it('multiple followers voting are counted independently and correctly', async () => {
    const msg = await createPollMessage();
    await service.votePoll({
      conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
    });
    const result = await service.votePoll({
      conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-2',
    });
    const optA = (result as any).poll.options.find((o: any) => o.id === 'opt-a');
    expect(optA.votes).toBe(2);
    expect(optA.voters.sort()).toEqual(['follower-1', 'follower-2']);
  });

  it('rejects voting on a deleted poll message', async () => {
    const msg = await createPollMessage({ isDeleted: true } as any);
    await expect(
      service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
      }),
    ).rejects.toThrow('cannot vote on deleted message');
  });

  it('rejects an unknown option id', async () => {
    const msg = await createPollMessage();
    await expect(
      service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'not-a-real-option', userId: 'follower-1',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects voting on a non-poll message', async () => {
    const msg = await messageModel.create({
      conversationId: CHANNEL_CONVERSATION_ID,
      senderId: 'owner-user-1',
      clientId: `client-${Date.now()}`,
      seq: 1,
      kind: 'text',
      text: 'Not a poll',
    });
    await expect(
      service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
      }),
    ).rejects.toThrow('message is not a poll');
  });
});
