// src/realtime/socket-dto.ts
// Validated DTOs for all inbound socket events.
// Use validateSocketPayload() to validate before trusting any field.

import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsArray,
  IsEnum,
  MaxLength,
  ArrayMaxSize,
  IsIn,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { MESSAGE_KINDS, type MessageKindValue } from '../chat/chat.types';

// ─── Validation helper ────────────────────────────────────────────────────────

export async function validateSocketPayload<T extends object>(
  DtoClass: new () => T,
  payload: unknown,
): Promise<{ ok: true; value: T } | { ok: false; errors: string[] }> {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, errors: ['Payload must be an object'] };
  }
  const instance = plainToInstance(DtoClass, payload, {
    excludeExtraneousValues: false,
  });
  const errors: ValidationError[] = await validate(instance, {
    whitelist: false,
    forbidNonWhitelisted: false,
    skipMissingProperties: false,
  });
  if (errors.length) {
    const messages = errors.flatMap((e) =>
      Object.values(e.constraints ?? { _: 'Invalid value' }),
    );
    return { ok: false, errors: messages };
  }
  return { ok: true, value: instance };
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  clientId!: string;

  @IsOptional()
  @IsIn(MESSAGE_KINDS)
  kind?: MessageKindValue;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  text?: string;

  // Styled-text visual fields — stored in a sub-document in MongoDB.
  // Validated loosely; the Mongoose schema enforces required fields.
  @IsOptional()
  styledText?: {
    text: string
    backgroundColor?: string
    fontSize?: number
    fontColor?: string
    fontFamily?: string
  };

  @IsOptional()
  voice?: unknown;

  @IsOptional()
  sticker?: unknown;

  @IsOptional()
  contacts?: unknown[];

  @IsOptional()
  poll?: unknown;

  @IsOptional()
  event?: unknown;

  @IsOptional()
  location?: unknown;

  @IsOptional()
  replyToId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  attachments?: unknown[];

  @IsOptional()
  media?: unknown;

  @IsOptional()
  encryptionMeta?: unknown;

  @IsOptional()
  ciphertext?: string;

  @IsOptional()
  iv?: string;

  @IsOptional()
  tag?: string;

  @IsOptional()
  aad?: string;

  @IsOptional()
  encryptionVersion?: string;

  @IsOptional()
  encryptionKeyVersion?: string;
}

export class EditMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  messageId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  text?: string;
}

export class DeleteMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  messageId!: string;
}

export class HistoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  before?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  after?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class ReactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  messageId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  emoji!: string;
}

export class ReceiptDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  messageId!: string;

  @IsString()
  @IsIn(['delivered', 'read'])
  type!: string;
}

export class TypingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsBoolean()
  isTyping!: boolean;
}

export class JoinRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;
}

const CALL_TYPES = ['voice', 'video', 'voice-group', 'video-group', 'broadcast'] as const;
export type CallTypeValue = (typeof CALL_TYPES)[number];

export class CallOfferDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;

  @IsOptional()
  @IsIn(CALL_TYPES)
  callType?: CallTypeValue;

  @IsOptional()
  @IsIn(['voice', 'video'])
  media?: 'voice' | 'video';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  inviteeUserIds?: string[];
}

export class CallSignalDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;
}

// WebRTC signaling — targeted peer-to-peer relay

export class CallSdpDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  targetUserId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(65_536)
  sdp!: string;

  @IsOptional()
  @IsIn(['offer', 'answer'])
  sdpType?: 'offer' | 'answer';
}

export class CallIceCandidateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  targetUserId!: string;

  // ICE candidate is an opaque object — pass it through unmodified
  candidate!: unknown;
}

// Social call events

export class CallHandDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;
}

export class CallReactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  emoji!: string;
}

export class CallChatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  text!: string;
}

// Host control actions

export class CallParticipantActionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  targetUserId!: string;
}
