# ARCHIVED / LEGACY: BroadcastModule

**Status as of 2026-10-04: BLOCKED from removal. Kept in place, not deleted.**

## Why this exists

`BroadcastModule` (this directory's `broadcast.module.ts`, `broadcast.controller.ts`,
`broadcast.service.ts`, `broadcast-reactions.service.ts`, `broadcast.types.ts`,
`broadcast-item.schema.ts`, `broadcast-reaction.schema.ts`) is a dormant Mongo-backed
"republish a chat message to a public tenant feed" stub. It is unreachable at
runtime in every environment that uses this repo's `.env`/`.env.example`/
`docker-compose.yml` as-is:

- `BroadcastController` is gated by `@FeatureFlag('FF_BROADCAST_CORE')`.
- `FeedsController` (a separate module, see below) is gated by
  `@FeatureFlag('FF_FEEDS_BROADCAST')`.
- `FeatureFlagGuard.canActivate()` (`src/feature-flag.guard.ts`) reads
  `process.env[flag] ?? '0'` and only activates on the literal string `'1'`.
- Neither `FF_BROADCAST_CORE` nor `FF_FEEDS_BROADCAST` appears anywhere in
  `.env`, `.env.example`, or `docker-compose.yml` in this repo (confirmed by
  grep 2026-10-04). Both flags therefore default to off everywhere.
- Single commit `56d456a` ("my first commit") created this module; untouched
  since across ~6 months / 77+ subsequent commits of repo history.
- The real, authoritative broadcast/channel platform for this product is
  Django's `apps.broadcasts` (`BroadcastChannel` -> `ChannelContent`). This
  NestJS module is unrelated scaffolding that was never wired up to it.

## Why it was NOT deleted (2026-10-04 closure attempt)

This module has a real, compile-time dependency from **outside itself**:

- `src/feeds.module.ts` imports `BroadcastModule` directly
  (`import { BroadcastModule } from './broadcast.module'`) and lists it in
  its own `@Module({ imports: [...] })`.
- `src/feeds.controller.ts` (`FeedsController`) imports `BroadcastService`
  and the `BroadcastSourceType`/`BroadcastVertical` enums from
  `broadcast.service.ts`/`broadcast.types.ts`, injects `BroadcastService` via
  constructor DI, and calls `broadcastService.createItem(...)` from two
  handlers (`POST :id/broadcast`, `POST broadcast-from-channel`).
- `FeedsModule` is itself registered in `src/app.module.ts`, alongside
  `BroadcastModule`.

`FeedsModule`/`FeedsController` are themselves gated by the same
feature-flag pattern (`FF_FEEDS_BROADCAST`, also unset everywhere) and are
therefore equally unreachable at runtime right now — but `FeedsModule` was
**not** in scope for this closure task (only `BroadcastModule` was), and
deleting `BroadcastService`/`broadcast.types.ts` without also editing
`FeedsModule`/`FeedsController` would break `npm run build` / `npm run
typecheck` for this repo. Per the closure mandate ("if anything surprises
you ... do NOT force a deletion"), this module is being left in place and
documented instead.

## What would need to happen to actually delete this

Either:
1. Expand the scope to also retire `FeedsModule`/`FeedsController`
   (`src/feeds.module.ts`, `src/feeds.controller.ts`, `src/feeds.service.ts`,
   `src/feed-post.schema.ts`) and re-verify those have no other live
   consumers, then delete the whole `BroadcastModule` + `FeedsModule` family
   together and unregister both from `src/app.module.ts`; or
2. Keep `FeedsModule` but strip its two broadcast-republish endpoints
   (`broadcast`, `broadcast-from-channel`) and the `BroadcastModule` import,
   then delete `BroadcastModule` on its own.

Neither was authorized under this task's scope, so this file exists purely
as a marker for the next person who considers deleting `BroadcastModule`:
check `feeds.module.ts`/`feeds.controller.ts` first.
