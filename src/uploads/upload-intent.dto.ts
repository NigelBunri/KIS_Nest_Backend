// src/uploads/upload-intent.dto.ts
import { IsInt, IsOptional, IsPositive, IsString, MaxLength, Min } from 'class-validator';

export class InitiateUploadDto {
  @IsString() @MaxLength(255) filename!: string;
  @IsString() @MaxLength(255) content_type!: string;
  @IsInt() @Min(1) size_bytes!: number;

  @IsOptional() @IsString() @MaxLength(64) context?: string;
  @IsOptional() @IsString() @MaxLength(128) conversationId?: string;
  @IsOptional() @IsString() @MaxLength(128) clientId?: string;
}

export class ConfirmUploadDto {
  @IsOptional() @IsPositive() duration_seconds?: number;

  // Broadcast-video-only (context: 'broadcast_video' at initiate time) —
  // triggers UploadIntentService.confirm()'s post-confirm call to Django's
  // process-video-upload webhook. See that method for why this metadata
  // travels here instead of at initiate time: it's only needed once the
  // upload is confirmed, and keeping initiate's contract minimal/generic
  // (filename/content-type/size only) means every other upload kind never
  // has to think about these fields.
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @MaxLength(128) channelId?: string;
  // Nest attachmentId (never a raw storage key — see uploads/upload-intent.
  // service.ts's UUID-not-a-key guard on uploadId for why) of a separately
  // uploaded thumbnail image, if the client picked/generated a custom one
  // instead of relying on Django's auto-generated frame-grab.
  @IsOptional() @IsString() thumbnailAttachmentId?: string;
}
