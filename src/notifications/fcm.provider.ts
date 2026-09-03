import type { PushMessage, PushProvider } from './push.provider'

type FirebaseAdmin = {
  apps: any[]
  initializeApp: (args: any) => any
  credential: { cert: (input: any) => any }
  messaging: () => {
    sendEachForMulticast: (payload: any) => Promise<{ responses: Array<{ success: boolean; error?: { code: string } }> }>
  }
}

let adminInstance: FirebaseAdmin | null = null

function loadAdmin(): FirebaseAdmin | null {
  if (adminInstance) return adminInstance
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const admin = require('firebase-admin') as FirebaseAdmin
    adminInstance = admin
    return admin
  } catch {
    return null
  }
}

function buildCredential(): any | null {
  const json = process.env.FCM_SERVICE_ACCOUNT_JSON
  const path = process.env.FCM_SERVICE_ACCOUNT_PATH
  if (json) {
    try {
      return JSON.parse(json)
    } catch {
      return null
    }
  }
  if (path) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(path)
    } catch {
      return null
    }
  }
  return null
}

function ensureApp(admin: FirebaseAdmin): boolean {
  const cred = buildCredential()
  if (!cred) return false
  if (admin.apps?.length) return true
  admin.initializeApp({ credential: admin.credential.cert(cred) })
  return true
}

// Codes that indicate a token is permanently invalid and should be deactivated
const STALE_ERROR_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
])

class FcmPushProvider implements PushProvider {
  constructor(private readonly admin: FirebaseAdmin) {}

  async send(tokens: string[], msg: PushMessage) {
    const data: Record<string, string> = {}
    if (msg.data) {
      for (const [key, value] of Object.entries(msg.data)) {
        if (value == null) continue
        data[key] = String(value)
      }
    }

    // Incoming-call pushes are data-only + high-priority: the client's
    // background handler calls RNCallKeep.displayIncomingCall() itself to
    // show the native ringing UI, so an OS-rendered `notification` block
    // would show a redundant tray notification alongside it. Every other
    // push type keeps the `notification` block for normal OS display.
    const isIncomingCall = data.type === 'incoming_call'
    const payload: Record<string, unknown> = {
      tokens,
      data: isIncomingCall ? { ...data, title: msg.title, body: msg.body } : data,
      android: { priority: 'high' },
    }
    if (!isIncomingCall) {
      payload.notification = {
        title: msg.title,
        body: msg.body,
      }
    }

    const res = await this.admin.messaging().sendEachForMulticast(payload)
    const delivered = res.responses.filter((r) => r.success).length
    const failedResponses = res.responses
      .map((r, i) => ({ r, token: tokens[i] }))
      .filter(({ r }) => !r.success)
    // Permanently invalid — deactivate, never retry.
    const failedTokens = failedResponses
      .filter(({ r }) => r.error && STALE_ERROR_CODES.has(r.error.code))
      .map(({ token }) => token)
    // Everything else that failed (rate limit, transient 5xx, unknown) —
    // may succeed on a retry; the token itself isn't necessarily bad.
    const transientTokens = failedResponses
      .filter(({ r }) => !(r.error && STALE_ERROR_CODES.has(r.error.code)))
      .map(({ token }) => token)
    return { delivered, failedTokens, transientTokens }
  }
}

export function createFcmProvider(): PushProvider | null {
  const admin = loadAdmin()
  if (!admin) return null
  if (!ensureApp(admin)) return null
  return new FcmPushProvider(admin)
}
