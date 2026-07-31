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
}
