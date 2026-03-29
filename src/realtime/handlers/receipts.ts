// src/realtime/handlers/receipts.ts

import type { Server, Socket } from 'socket.io'
import { EVT, rooms, type Ack, type ReceiptPayload, type SocketPrincipal } from '../../chat/chat.types'
import { getPrincipal, ok, err, safeAck, safeEmit } from './utils'

export interface ReceiptsDeps {
  rateLimitService: {
    assert(principal: SocketPrincipal, key: string, limit?: number): Promise<void> | void
  }
  djangoConversationClient: {
    assertMember(principal: SocketPrincipal, conversationId: string): Promise<any>
  }
  moderationService?: {
    assertAllowed(args: { conversationId: string; userId: string; action: 'receipt' }): Promise<void> | void
  }
  receiptsService: {
    applyReceipt(args: {
      userId: string
      conversationId: string
      messageId: string
      type: 'delivered' | 'read' | 'played'
      deviceId?: string
    }): Promise<any>
  }
}

export function registerReceiptHandlers(server: Server, socket: Socket, deps: ReceiptsDeps) {
  socket.on(EVT.RECEIPT, async (payload: ReceiptPayload, ack?: (a: Ack<any>) => void) => {
    const principal = getPrincipal(socket)
    const { conversationId, messageId, type } = payload || ({} as any)

    if (!conversationId || !messageId || !type) {
      return safeAck(ack, err('conversationId, messageId, type are required', 'BAD_REQUEST'))
    }

    try {
      await deps.rateLimitService.assert(principal, `receipt:${conversationId}`, 200)
      await deps.djangoConversationClient.assertMember(principal, conversationId)
      if (deps.moderationService) {
        await deps.moderationService.assertAllowed({
          conversationId,
          userId: principal.userId,
          action: 'receipt',
        })
      }

      const receiptEvent = await deps.receiptsService.applyReceipt({
        userId: principal.userId,
        conversationId,
        messageId,
        type,
        deviceId: principal.deviceId,
      })

      const receiptConvId = (receiptEvent as any)?.conversationId
      if (receiptConvId && String(receiptConvId) !== String(conversationId)) {
        throw new Error('Conversation mismatch on receipt')
      }

      safeEmit(server, rooms.convRoom(conversationId), EVT.MESSAGE_RECEIPT, receiptEvent)
      safeAck(ack, ok({ receipt: true }))
    } catch (e: any) {
      safeAck(ack, err(e?.message ?? 'Receipt failed', 'ERROR'))
    }
  })
}
