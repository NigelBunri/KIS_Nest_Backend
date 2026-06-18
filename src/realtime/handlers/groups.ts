// src/realtime/handlers/groups.ts
//
// Handlers for group/subroom management and multi-device session management.

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'

import { EVT, rooms, type Ack, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

const logger = new Logger('ChatGroupHandlers')

export interface GroupsDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
    updateSettings(args: {
      conversationId: string
      settings: { name?: string; description?: string; icon?: string }
      token?: string
    }): Promise<Record<string, unknown>>
    getDevices(token: string): Promise<unknown[]>
    removeDevice(deviceId: string, token: string): Promise<{ removed: boolean }>
  }
  threadsService: {
    renameThread(args: { threadId: string; title: string; requestedByUserId: string }): Promise<{
      id: string
      conversationId: string
      title: string
    }>
  }
}

export function registerGroupHandlers(server: Server, socket: Socket, deps: GroupsDeps) {
  // ─── subroom.rename ───────────────────────────────────────────────────────

  // subroom.rename { subroomId: string, title: string }
  // Updates the Thread document's title and broadcasts subroom.updated to the
  // conversation room so all participants see the new name.
  socket.on(EVT.SUBROOM_RENAME, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const subroomId = typeof p.subroomId === 'string' ? p.subroomId.trim() : ''
    const title = typeof p.title === 'string' ? p.title.trim() : ''

    if (!subroomId || !title) {
      return safeAck(ack, err('subroomId and title are required', 'BAD_REQUEST'))
    }
    if (title.length > 200) {
      return safeAck(ack, err('title must be 200 characters or fewer', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `subroom_rename:${subroomId}`, 20)

      const updated = await deps.threadsService.renameThread({
        threadId: subroomId,
        title,
        requestedByUserId: principal.userId,
      })

      // Broadcast to the conversation room so all members see the rename
      safeEmit(server, rooms.convRoom(updated.conversationId), EVT.SUBROOM_UPDATED, {
        subroomId,
        conversationId: updated.conversationId,
        title: updated.title,
        updatedBy: principal.userId,
        at: new Date().toISOString(),
      })

      safeAck(ack, ok({ subroomId, title: updated.title }))
    } catch (error: any) {
      logger.error(`[groups] subroom.rename failed subroomId=${subroomId} userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Subroom rename failed', 'ERROR'))
    }
  })

  // ─── group.update_settings ────────────────────────────────────────────────

  // group.update_settings { conversationId: string, settings: { name?, description?, icon? } }
  // Patches the conversation metadata in Django and broadcasts conversation.updated
  // to the conversation room.
  socket.on(EVT.GROUP_UPDATE_SETTINGS, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const conversationId = typeof p.conversationId === 'string' ? p.conversationId.trim() : ''
    const settings = (p.settings && typeof p.settings === 'object') ? p.settings as Record<string, unknown> : {}

    if (!conversationId) {
      return safeAck(ack, err('conversationId is required', 'BAD_REQUEST'))
    }

    const name = typeof settings.name === 'string' ? settings.name.trim() : undefined
    const description = typeof settings.description === 'string' ? settings.description.trim() : undefined
    const icon = typeof settings.icon === 'string' ? settings.icon.trim() : undefined

    if (name === undefined && description === undefined && icon === undefined) {
      return safeAck(ack, err('At least one of name, description, icon must be provided', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `group_update_settings:${conversationId}`, 10)
      // Verify the caller is a member (and has appropriate role — Django will enforce admin check)
      await deps.djangoConversationClient.assertMember(principal, conversationId)

      const updated = await deps.djangoConversationClient.updateSettings({
        conversationId,
        settings: { name, description, icon },
        token: principal.token,
      })

      // Broadcast conversation.updated to all members in the conv room
      safeEmit(server, rooms.convRoom(conversationId), EVT.CONVERSATION_UPDATED, {
        event: EVT.CONVERSATION_UPDATED,
        reason: 'settings_updated',
        conversationId,
        updatedBy: principal.userId,
        settings: { name, description, icon },
        at: new Date().toISOString(),
        ...updated,
      })

      safeAck(ack, ok({ updated: true, conversationId, settings: { name, description, icon } }))
    } catch (error: any) {
      logger.error(`[groups] group.update_settings failed conversationId=${conversationId} userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Group settings update failed', 'ERROR'))
    }
  })

  // ─── user.get_devices ─────────────────────────────────────────────────────

  // user.get_devices {}
  // Fetches the authenticated user's device sessions from Django and emits
  // user.devices_list back to the requesting socket only.
  socket.on(EVT.USER_GET_DEVICES, async (_payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)

    if (!principal.token) {
      return safeAck(ack, err('Authentication token required', 'UNAUTHORIZED'))
    }

    try {
      await deps.rateLimitService.assert(principal, `user_get_devices:${principal.userId}`, 10)

      const devices = await deps.djangoConversationClient.getDevices(principal.token)

      // Emit only to the requesting socket — device list is private
      socket.emit(EVT.USER_DEVICES_LIST, { devices })
      safeAck(ack, ok({ devices }))
    } catch (error: any) {
      logger.error(`[groups] user.get_devices failed userId=${principal?.userId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Get devices failed', 'ERROR'))
    }
  })

  // ─── user.remove_device ───────────────────────────────────────────────────

  // user.remove_device { deviceId: string }
  // Revokes a device session via Django and emits user.device_removed back to
  // the requesting socket with the result.
  socket.on(EVT.USER_REMOVE_DEVICE, async (payload: unknown, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const p = payload as Record<string, unknown> ?? {}
    const deviceId = typeof p.deviceId === 'string' ? p.deviceId.trim() : ''

    if (!deviceId) {
      return safeAck(ack, err('deviceId is required', 'BAD_REQUEST'))
    }
    if (!principal.token) {
      return safeAck(ack, err('Authentication token required', 'UNAUTHORIZED'))
    }

    try {
      await deps.rateLimitService.assert(principal, `user_remove_device:${principal.userId}`, 10)

      const result = await deps.djangoConversationClient.removeDevice(deviceId, principal.token)

      // Emit only to the requesting socket
      socket.emit(EVT.USER_DEVICE_REMOVED, { deviceId, removed: result.removed })
      safeAck(ack, ok({ deviceId, removed: result.removed }))
    } catch (error: any) {
      logger.error(`[groups] user.remove_device failed userId=${principal?.userId} deviceId=${deviceId}`, error?.message)
      safeAck(ack, err(error?.message ?? 'Remove device failed', 'ERROR'))
    }
  })
}
