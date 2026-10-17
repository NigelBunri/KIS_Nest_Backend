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

// Own database - see reactions.channel.spec.ts's identical comment for
// why these three real-Mongo spec files can't share one database name
// (they used to, and raced each other's dropDatabase() calls whenever
// Jest ran them as separate parallel workers).
const TEST_MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/kis_nest_votepoll_channel_test';

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
    service = new MessagesService(messageModel, {} as any, {} as any);
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

  // Poll real-time fix (requirement 1A): allowMultiple polls must let each
  // option toggle independently, never clearing a voter's other choices
  // the way single-choice does.
  describe('allowMultiple polls', () => {
    async function createMultiPollMessage() {
      return messageModel.create({
        conversationId: CHANNEL_CONVERSATION_ID,
        senderId: 'owner-user-1',
        clientId: `client-${Date.now()}-${Math.random()}`,
        seq: Math.floor(Math.random() * 1_000_000),
        kind: 'poll',
        poll: {
          question: 'Pick any that apply',
          allowMultiple: true,
          options: [
            { id: 'opt-a', text: '9am', votes: 0, voters: [] },
            { id: 'opt-b', text: '11am', votes: 0, voters: [] },
          ],
        },
      });
    }

    it('voting for a second option does not clear the first', async () => {
      const msg = await createMultiPollMessage();
      await service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
      });
      const result = await service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-b', userId: 'follower-1',
      });
      const options = (result as any).poll.options;
      expect(options.find((o: any) => o.id === 'opt-a').voters).toContain('follower-1');
      expect(options.find((o: any) => o.id === 'opt-b').voters).toContain('follower-1');
    });

    it('tapping an already-selected option toggles it off', async () => {
      const msg = await createMultiPollMessage();
      await service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
      });
      const result = await service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
      });
      const optA = (result as any).poll.options.find((o: any) => o.id === 'opt-a');
      expect(optA.votes).toBe(0);
      expect(optA.voters).not.toContain('follower-1');
    });
  });

  // Poll real-time fix (requirement 1D): closing time enforcement.
  describe('poll closing', () => {
    it('rejects a vote after expiresAt has passed, with no background job involved', async () => {
      const msg = await createPollMessage({
        poll: {
          question: 'Already past its deadline',
          options: [
            { id: 'opt-a', text: '9am', votes: 0, voters: [] },
            { id: 'opt-b', text: '11am', votes: 0, voters: [] },
          ],
          expiresAt: new Date(Date.now() - 60_000),
        },
      } as any);

      await expect(
        service.votePoll({
          conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
        }),
      ).rejects.toThrow('This poll is closed.');

      // Lazily persisted so every future reader sees the same closedAt,
      // not just a live recomputation of an already-past expiresAt.
      const stored = await messageModel.findById(msg._id);
      expect((stored as any)?.poll?.closedAt).toBeTruthy();
    });

    it('accepts a vote before expiresAt', async () => {
      const msg = await createPollMessage({
        poll: {
          question: 'Still open',
          options: [
            { id: 'opt-a', text: '9am', votes: 0, voters: [] },
            { id: 'opt-b', text: '11am', votes: 0, voters: [] },
          ],
          expiresAt: new Date(Date.now() + 60_000),
        },
      } as any);

      const result = await service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
      });
      expect((result as any).poll.options.find((o: any) => o.id === 'opt-a').votes).toBe(1);
    });

    it('rejects a vote on a manually-closed poll', async () => {
      const msg = await createPollMessage();
      await service.closePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), userId: 'owner-user-1',
      });

      await expect(
        service.votePoll({
          conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
        }),
      ).rejects.toThrow('This poll is closed.');
    });

    it('only the poll creator can close it manually', async () => {
      const msg = await createPollMessage();
      await expect(
        service.closePoll({
          conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), userId: 'follower-1',
        }),
      ).rejects.toThrow('only the poll creator can close this poll');
    });

    it('closing twice is idempotent, not an error', async () => {
      const msg = await createPollMessage();
      await service.closePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), userId: 'owner-user-1',
      });
      const second = await service.closePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), userId: 'owner-user-1',
      });
      expect((second as any).poll.closedAt).toBeTruthy();
    });

    it('final results remain visible after closure', async () => {
      const msg = await createPollMessage();
      await service.votePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
      });
      const closed = await service.closePoll({
        conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), userId: 'owner-user-1',
      });
      const optA = (closed as any).poll.options.find((o: any) => o.id === 'opt-a');
      expect(optA.votes).toBe(1);
      expect(optA.voters).toContain('follower-1');
    });
  });

  // Poll real-time fix (requirement 1E): a hand-crafted/replayed socket
  // payload must be rejected server-side regardless of what the mobile
  // app's own PollModal already validated.
  describe('poll creation payload validation (assertValidPollPayload)', () => {
    const makeService = () => new MessagesService(messageModel, {} as any, {} as any);

    it('rejects a poll with fewer than 2 options', () => {
      const svc: any = makeService();
      expect(() => svc.assertValidPollPayload({ options: [{ id: 'a', text: 'only one' }] })).toThrow(
        'at least 2 options',
      );
    });

    it('rejects a poll option with no text', () => {
      const svc: any = makeService();
      expect(() =>
        svc.assertValidPollPayload({ options: [{ id: 'a', text: '' }, { id: 'b', text: 'ok' }] }),
      ).toThrow('requires text');
    });

    it('rejects a closing time that is not in the future', () => {
      const svc: any = makeService();
      expect(() =>
        svc.assertValidPollPayload({
          options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }],
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ).toThrow('must be in the future');
    });

    it('accepts a valid poll with a future closing time', () => {
      const svc: any = makeService();
      expect(() =>
        svc.assertValidPollPayload({
          options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ).not.toThrow();
    });
  });

  // Event date/time fix (requirement 2B): re-validated server-side,
  // independent of whatever the mobile date/time pickers already enforce.
  describe('event payload validation (assertValidEventPayload)', () => {
    const makeService = () => new MessagesService(messageModel, {} as any, {} as any);

    it('rejects a malformed startsAt', () => {
      const svc: any = makeService();
      expect(() => svc.assertValidEventPayload({ startsAt: 'not-a-date' })).toThrow(
        'startsAt must be a valid date',
      );
    });

    it('rejects an endsAt that is before startsAt', () => {
      const svc: any = makeService();
      const starts = new Date();
      const ends = new Date(starts.getTime() - 60_000);
      expect(() =>
        svc.assertValidEventPayload({ startsAt: starts.toISOString(), endsAt: ends.toISOString() }),
      ).toThrow('end time must be after its start time');
    });

    it('accepts a multi-day event (endsAt on a later calendar date)', () => {
      const svc: any = makeService();
      const starts = new Date();
      const ends = new Date(starts.getTime() + 3 * 24 * 60 * 60 * 1000);
      expect(() =>
        svc.assertValidEventPayload({ startsAt: starts.toISOString(), endsAt: ends.toISOString() }),
      ).not.toThrow();
    });

    it('accepts an event with no endsAt at all', () => {
      const svc: any = makeService();
      expect(() => svc.assertValidEventPayload({ startsAt: new Date().toISOString() })).not.toThrow();
    });
  });

  // Poll real-time fix (requirement 1C): simultaneous votes must not
  // corrupt the final counts - every mutation in votePoll() is a single
  // atomic $pull/$addToSet keyed off _id (+ an arrayFilter), so concurrent
  // calls can only interleave, never lose or double an update.
  describe('concurrency', () => {
    it('10 different voters voting simultaneously are all counted exactly once', async () => {
      const msg = await createPollMessage();
      const voters = Array.from({ length: 10 }, (_, i) => `concurrent-follower-${i}`);
      await Promise.all(
        voters.map((userId) =>
          service.votePoll({
            conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId,
          }),
        ),
      );
      const stored = await messageModel.findById(msg._id);
      const optA = (stored as any).poll.options.find((o: any) => o.id === 'opt-a');
      expect(optA.votes).toBe(10);
      expect(new Set(optA.voters).size).toBe(10);
      for (const userId of voters) expect(optA.voters).toContain(userId);
    });

    it('the same voter firing the same vote twice concurrently never double-counts', async () => {
      const msg = await createPollMessage();
      await Promise.all([
        service.votePoll({
          conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
        }),
        service.votePoll({
          conversationId: CHANNEL_CONVERSATION_ID, messageId: String(msg._id), optionId: 'opt-a', userId: 'follower-1',
        }),
      ]);
      const stored = await messageModel.findById(msg._id);
      const optA = (stored as any).poll.options.find((o: any) => o.id === 'opt-a');
      expect(optA.votes).toBe(1);
      expect(optA.voters).toEqual(['follower-1']);
    });
  });
});
