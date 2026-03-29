// src/chat/feature-flags.ts

export const FF = {
  THREADS: true,
  PINS: true,
  STARS: true,
  SEARCH: true,
  MODERATION: true,
  CALLS: true,
  NOTIFICATIONS: true,

  // Observability additions
  METRICS: true,
} as const;
