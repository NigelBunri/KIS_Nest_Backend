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
