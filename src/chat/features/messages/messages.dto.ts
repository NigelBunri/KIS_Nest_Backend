// src/chat/features/messages/messages.dto.ts

import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  ArrayMaxSize,
  IsIn,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MESSAGE_KINDS, type MessageKind, type MessageKindValue } from '../../chat.types';

export class AttachmentDto {
  @IsString() id!: string;
  @IsString() url!: string;

  @IsString() originalName!: string;
  @IsString() mimeType!: string;

  @IsInt() @Min(0) size!: number;

  @IsOptional() @IsString() kind?: string;

  @IsOptional() @IsInt() @Min(0) width?: number;
  @IsOptional() @IsInt() @Min(0) height?: number;
  @IsOptional() @IsInt() @Min(0) durationMs?: number;
  @IsOptional() @IsString() thumbUrl?: string;
}

export class StyledTextDto {
  @IsString() text!: string;
  @IsString() backgroundColor!: string;

  @IsInt() @Min(10) @Max(120)
  fontSize!: number;

  @IsString() fontColor!: string;

  @IsOptional() @IsString()
  fontFamily?: string;
}

export class VoiceDto {
  @IsInt() @Min(1) @Max(60 * 60 * 1000)
  durationMs!: number;
}

export class StickerDto {
  @IsString() id!: string;
  @IsString() uri!: string;

  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsInt() @Min(0) width?: number;
  @IsOptional() @IsInt() @Min(0) height?: number;
}

export class ContactDto {
  @IsString() id!: string;
  @IsString() name!: string;
  @IsString() phone!: string;
}

export class PollOptionDto {
  @IsString() id!: string;
  @IsString() text!: string;

  @IsOptional() @IsInt() @Min(0)
  votes?: number;
}

export class PollDto {
  @IsOptional() @IsString()
  id?: string;

  @IsString() question!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PollOptionDto)
  options!: PollOptionDto[];

  @IsOptional() @IsBoolean()
  allowMultiple?: boolean;

  // Keep string here; schema stores Date|null, service can map/ignore
  @IsOptional() @IsString()
  expiresAt?: string | null;
}

export class EventDto {
  @IsOptional() @IsString()
  id?: string;

  @IsString() title!: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  location?: string;

  @IsString() startsAt!: string;

  @IsOptional() @IsString()
  endsAt?: string;

  @IsOptional() @IsInt() @Min(0)
  reminderMinutes?: number;
}

export class SendMessageDto {
  @IsString() conversationId!: string;
  @IsString() clientId!: string;

  @IsIn(MESSAGE_KINDS as readonly string[])
  kind: MessageKindValue

  // ✅ Batch B: optional thread routing
  @IsOptional()
  @IsString()
  threadId?: string;

  @IsOptional() @IsString()
  text?: string;

  @IsOptional() @IsString()
  ciphertext?: string;

  @IsOptional() @IsObject()
  encryptionMeta?: Record<string, any>;

  @IsOptional()
  @ValidateNested()
  @Type(() => StyledTextDto)
  styledText?: StyledTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceDto)
  voice?: VoiceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => StickerDto)
  sticker?: StickerDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  contacts?: ContactDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PollDto)
  poll?: PollDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => EventDto)
  event?: EventDto;

  @IsOptional() @IsString()
  replyToId?: string;
}
