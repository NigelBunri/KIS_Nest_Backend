// src/chat/features/messages/messages.dto.ts

import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
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

  // Canonical voice-attachment metadata. Previously this class declared
  // ONLY durationMs — Mongoose subdocument casting silently strips any
  // field not declared on the schema/DTO, so a client-sent voice.url was
  // discarded the instant a message saved, regardless of what the sender
  // actually uploaded. That was the root cause of voice notes being
  // unplayable for receivers (who only ever see the persisted, stripped
  // document) and, intermittently, for senders themselves (once their own
  // view re-derives from the same persisted/broadcast shape rather than
  // their local optimistic draft). All optional for backward compatibility
  // with any already-deployed client build that still sends only
  // {durationMs} — new sends always populate the rest, see
  // apps: KIS RN uploadFileToBackend.ts / ChatRoomHandlers.tsx.
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsString() url?: string;
  // Django's MediaAsset.id (UUID) — the PERMANENT identity used to refresh
  // an expired playback url via GET /chat/messages/:messageId/voice/playback-url
  // (see voice-playback.service.ts). This is what Django's internal
  // chat-voice-sign endpoint looks the asset up by; `objectKey` below is
  // kept for backward compat / display only — Django's UploadFileView never
  // actually returns the real S3 key to a client, so this field is
  // populated with the same asset id today (see buildVoiceAttachment.ts on
  // the RN side) rather than a real storage key. Never trust either field
  // as a substitute for the server re-deriving the object from the
  // persisted message — see voice-playback.service.ts.
  @IsOptional() @IsString() mediaAssetId?: string;
  @IsOptional() @IsString() objectKey?: string;
  @IsOptional() @IsString() originalName?: string;
  @IsOptional() @IsString() mimeType?: string;
  @IsOptional() @IsInt() @Min(0) size?: number;
  @IsOptional() @IsArray() waveform?: number[];
  // ISO-8601. Purely advisory for the client's own cache-freshness check —
  // never trusted server-side; the server always re-validates via Django at
  // refresh time regardless of what this says.
  @IsOptional() @IsString() urlExpiresAt?: string;
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

export class LocationDto {
  @IsNumber() latitude!: number;
  @IsNumber() longitude!: number;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString()
  title?: string;
}

export class BibleVerseDto {
  @IsString() reference!: string;

  @IsOptional() @IsString() bookCode?: string;
  @IsOptional() @IsString() bookName?: string;

  @IsInt() @Min(1) chapter!: number;

  @IsOptional() @IsInt() @Min(1) verseStart?: number;
  @IsOptional() @IsInt() @Min(1) verseEnd?: number;

  @IsOptional() @IsString() text?: string;
}

export class LinkPreviewDto {
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() image?: string;
  @IsOptional() @IsString() site_name?: string;
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
  previewText?: string;

  @IsOptional() @IsString()
  ciphertext?: string;

  @IsOptional() @IsObject()
  encryptionMeta?: Record<string, any>;

  @IsOptional()
  encrypted?: boolean;

  @IsOptional() @IsString()
  iv?: string;

  @IsOptional() @IsString()
  tag?: string;

  @IsOptional() @IsString()
  aad?: string;

  @IsOptional() @IsString()
  encryptionVersion?: string;

  @IsOptional() @IsString()
  encryptionKeyVersion?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StyledTextDto)
  styledText?: StyledTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceDto)
  voice?: VoiceDto;

  // Only meaningful for unencrypted sends (public rooms, or E2EE off) - an
  // E2EE send's real viewOnce flag lives inside the encrypted payload and
  // never reaches the server at creation time; that's fine, since it isn't
  // needed until the recipient actually opens it (see chat.view_once /
  // markViewOnceOpened, which sets it server-side at that point instead).
  @IsOptional()
  @IsBoolean()
  viewOnce?: boolean;

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
  @IsObject()
  media?: Record<string, any>;

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

  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BibleVerseDto)
  bibleVerse?: BibleVerseDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LinkPreviewDto)
  linkPreview?: LinkPreviewDto;

  @IsOptional() @IsString()
  replyToId?: string;
}
