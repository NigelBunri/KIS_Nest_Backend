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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  attachments?: unknown[];

  @IsOptional()
  encryptionMeta?: unknown;
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

export class CallOfferDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  callId!: string;

  @IsIn(['voice', 'video'])
  media!: 'voice' | 'video';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
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
