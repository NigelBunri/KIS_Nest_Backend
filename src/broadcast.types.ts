// ARCHIVED/LEGACY (2026-10-04): feature-flagged off everywhere (FF_BROADCAST_CORE / FF_FEEDS_BROADCAST unset
// in every .env*/docker-compose.yml), unreachable at runtime, untouched since its single creation
// commit ~6 months ago. BLOCKED from deletion: feeds.module.ts/feeds.controller.ts hard-depend on
// this module at compile time (see src/ARCHIVED_LEGACY_BROADCAST.md for the full writeup).
export enum BroadcastVertical {
  FEEDS = 'feeds',
}

export enum BroadcastSourceType {
  FEED_POST = 'feed_post',
}

export enum BroadcastVisibility {
  PUBLIC = 'public',
  COMMUNITY = 'community',
  RESTRICTED = 'restricted',
  PRIVATE = 'private',
}

export interface BroadcastEngagement {
  reactions: number
  comments: number
  shares: number
  saves: number
}

export interface CreateBroadcastItemParams {
  tenantId: string
  creatorId: string
  vertical: BroadcastVertical
  sourceType: BroadcastSourceType
  sourceId: string
  title?: string
  body?: string
  attachments?: any[]
  metadata?: Record<string, unknown>
  visibility?: BroadcastVisibility
  idempotencyKey?: string
}
