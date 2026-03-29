import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CallInviteDto {
  @IsString()
  conversationId!: string;

  @IsString()
  callId!: string; // client uuid

  @IsOptional()
  @IsString()
  media?: string; // "voice" | "video"

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  inviteeUserIds?: string[]; // optional explicit list; else you can infer from convo members on client side
}

export class CallAnswerDto {
  @IsString()
  conversationId!: string;

  @IsString()
  callId!: string;
}

export class CallRejectDto {
  @IsString()
  conversationId!: string;

  @IsString()
  callId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class CallEndDto {
  @IsString()
  conversationId!: string;

  @IsString()
  callId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class CallSignalDto {
  @IsString()
  conversationId!: string;

  @IsString()
  callId!: string;

  @IsIn(['offer', 'answer', 'ice', 'renegotiate', 'hangup'])
  kind!: 'offer' | 'answer' | 'ice' | 'renegotiate' | 'hangup';

  @IsOptional()
  @IsString()
  toUserId?: string; // optional (directed) else broadcast to convRoom

  // We do NOT validate SDP/candidate shape server-side here (keep gateway thin).
  @IsOptional()
  payload?: any;

  @IsOptional()
  @IsString()
  payloadType?: string; // "sdp" | "candidate" | ...
}
