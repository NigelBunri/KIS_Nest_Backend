const SECTIONS = [
  {
    id: 'community',
    title: 'Community Feed',
    description: 'People-powered updates from the field team.',
  },
  {
    id: 'partner',
    title: 'Partner Feed',
    description: 'Partner announcements and product highlights.',
  },
  {
    id: 'broadcast',
    title: 'Broadcast',
    description: 'Live stream shout-outs and viewer questions.',
  },
]

const EVT = {
  JOIN: 'chat.join',
  LEAVE: 'chat.leave',
  SEND: 'chat.send',
  MESSAGE: 'chat.message',
}

const state = {
  socket: null,
  connected: false,
  serverUrl: '',
  wsPath: '/ws',
  sectionConversations: SECTIONS.reduce((acc, section) => {
    acc[section.id] = null
    return acc
  }, {}),
  conversationToSection: new Map(),
}

const refs = {}
const sentLocal = new Map()

const logEl = document.getElementById('activityLog')
const statusEl = document.getElementById('wsStatus')
const clearAssignmentsBtn = document.getElementById('clearAssignments')
const connectBtn = document.getElementById('connect')
const disconnectBtn = document.getElementById('disconnect')

function $(id) {
  return document.getElementById(id)
}

function nowTime() {
  return new Date().toLocaleTimeString()
}

function ensureString(value) {
  if (typeof value === 'string') return value
  if (value && typeof value.toString === 'function') return value.toString()
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function log(...args) {
  if (!logEl) return
  const line = document.createElement('div')
  line.textContent = `[${nowTime()}] ${args.map(ensureString).join(' ')}`
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}

function mkClientId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function base64Decode(b64) {
  try {
    return decodeURIComponent(
      escape(atob(String(b64).replace(/^BASE64:/, ''))),
    )
  } catch {
    return b64
  }
}

function formatTimestamp(value) {
  if (!value) return ''
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return value
  return when.toLocaleTimeString()
}

function clearThread(sectionId) {
  const thread = refs[sectionId]?.thread
  if (thread) thread.innerHTML = ''
}

function appendComment(sectionId, { author, text, createdAt, mine }) {
  if (!text) return
  const thread = refs[sectionId]?.thread
  if (!thread) return

  const comment = document.createElement('div')
  comment.className = `comment${mine ? ' mine' : ''}`

  const avatar = document.createElement('div')
  avatar.className = 'comment-avatar'
  avatar.textContent = (author || '•').slice(0, 2).toUpperCase()

  const body = document.createElement('div')
  body.className = 'comment-body'

  const authorLine = document.createElement('div')
  authorLine.className = 'comment-author'
  const nameSpan = document.createElement('span')
  nameSpan.textContent = author || 'Unknown'
  const timeSpan = document.createElement('span')
  timeSpan.textContent = formatTimestamp(createdAt) || nowTime()
  authorLine.appendChild(nameSpan)
  authorLine.appendChild(timeSpan)

  const textEl = document.createElement('div')
  textEl.className = 'comment-text'
  textEl.textContent = text

  body.appendChild(authorLine)
  body.appendChild(textEl)
  comment.appendChild(avatar)
  comment.appendChild(body)
  thread.appendChild(comment)
  thread.scrollTop = thread.scrollHeight
}

function renderSections() {
  const grid = document.getElementById('feedGrid')
  if (!grid) return

  SECTIONS.forEach((section) => {
    const card = document.createElement('article')
    card.className = 'feed-card'
    card.innerHTML = `
      <div class="feed-card-head">
        <div>
          <h3>${section.title}</h3>
          <p class="feed-meta">${section.description}</p>
        </div>
        <span class="section-id" id="section-${section.id}-label">(no conversation)</span>
      </div>
      <div class="row">
        <input class="conversation-input" placeholder="Conversation ID" />
        <button class="primary small assign-button" data-section="${section.id}">Track</button>
      </div>
      <div class="feed-thread" id="thread-${section.id}"></div>
      <div class="row" style="justify-content:flex-start">
        <span class="status-pill" id="status-${section.id}">waiting for connection</span>
      </div>
      <div class="composer">
        <input id="composer-${section.id}" placeholder="Share your thought…" />
        <button id="send-${section.id}" class="primary" disabled>Comment</button>
      </div>
    `
    grid.appendChild(card)

    const conversationInput = card.querySelector('.conversation-input')
    const assignBtn = card.querySelector(`.assign-button[data-section="${section.id}"]`)

    refs[section.id] = {
      thread: document.getElementById(`thread-${section.id}`),
      conversationInput,
      composer: document.getElementById(`composer-${section.id}`),
      sendBtn: document.getElementById(`send-${section.id}`),
      label: document.getElementById(`section-${section.id}-label`),
      status: document.getElementById(`status-${section.id}`),
    }

    if (conversationInput && assignBtn) {
      assignBtn.addEventListener('click', () => assignConversation(section.id))
      conversationInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          assignConversation(section.id)
        }
      })
    }

    const composer = refs[section.id].composer
    const sendBtn = refs[section.id].sendBtn
    if (composer && sendBtn) {
      composer.addEventListener('input', () => updateComposerState(section.id))
      composer.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          sendComment(section.id)
        }
      })
      sendBtn.addEventListener('click', () => sendComment(section.id))
    }

    updateComposerState(section.id)
  })
}

function updateComposerState(sectionId) {
  const composer = refs[sectionId]?.composer
  const sendBtn = refs[sectionId]?.sendBtn
  const hasConversation = Boolean(state.sectionConversations[sectionId])
  const connected = state.connected
  if (!composer || !sendBtn) return
  const hasText = composer.value.trim().length > 0
  sendBtn.disabled = !(connected && hasConversation && hasText)
  composer.disabled = !connected
}

function updateAllComposerStates() {
  SECTIONS.forEach((section) => updateComposerState(section.id))
}

function updateSectionStatus(sectionId, text, tone = 'normal') {
  const status = refs[sectionId]?.status
  if (!status) return
  status.textContent = text
  status.classList.toggle('active', tone === 'active')
  status.classList.toggle('error', tone === 'error')
}

function assignConversation(sectionId) {
  const input = refs[sectionId]?.conversationInput
  const value = input?.value.trim()
  if (!value) {
    log(`Please provide a conversation ID for ${sectionId}.`)
    return
  }
  setConversation(sectionId, value)
}

function setConversation(sectionId, conversationId) {
  const current = state.sectionConversations[sectionId]
  if (current && current !== conversationId) {
    leaveConversation(current, sectionId)
  }
  if (conversationId) {
    state.sectionConversations[sectionId] = conversationId
    state.conversationToSection.set(conversationId, sectionId)
    refs[sectionId]?.label?.textContent = conversationId
    refs[sectionId]?.conversationInput?.value = ''
    updateSectionStatus(
      sectionId,
      state.connected ? 'tracking comments' : 'queued (connect to join)',
      'active',
    )
    clearThread(sectionId)
    if (state.connected) {
      joinConversation(conversationId, sectionId)
    }
  } else {
    state.sectionConversations[sectionId] = null
    updateSectionStatus(sectionId, 'cleared')
    refs[sectionId]?.label?.textContent = '(no conversation)'
    refs[sectionId]?.conversationInput?.value = ''
    clearThread(sectionId)
  }
  updateComposerState(sectionId)
}

function joinConversation(conversationId, sectionId) {
  if (!state.socket) return
  state.socket.emit(EVT.JOIN, { conversationId }, (ack) => {
    if (ack?.ok) {
      log(`Joined ${conversationId} for ${sectionId}`)
      updateSectionStatus(sectionId, 'tracking comments', 'active')
    } else {
      const message = ack?.error || 'join failed'
      log(`Unable to join ${conversationId}: ${message}`)
      updateSectionStatus(sectionId, message, 'error')
    }
  })
}

function leaveConversation(conversationId, sectionId) {
  if (!conversationId || !state.socket) return
  state.socket.emit(EVT.LEAVE, { conversationId }, (ack) => {
    log(`Left ${conversationId} (${ensureString(ack)})`)
  })
  state.conversationToSection.delete(conversationId)
}

function sendComment(sectionId) {
  const conversationId = state.sectionConversations[sectionId]
  const composer = refs[sectionId]?.composer
  if (!state.socket || !state.connected || !conversationId || !composer) {
    log('Cannot send comment; ensure you are connected and tracking a conversation.')
    return
  }
  const text = composer.value.trim()
  if (!text) return

  const clientId = mkClientId()
  appendComment(sectionId, {
    author: 'You',
    text,
    createdAt: new Date().toISOString(),
    mine: true,
  })
  composer.value = ''
  updateComposerState(sectionId)

  sentLocal.set(clientId, { sectionId, conversationId })
  setTimeout(() => sentLocal.delete(clientId), 60_000)

  const payload = {
    conversationId,
    clientId,
    kind: 'text',
    text,
  }

  state.socket.emit(EVT.SEND, payload, (ack) => {
    log('chat.send ack', ack)
  })
}

function handleIncomingMessage(message) {
  const conversationId = message?.conversationId
  if (!conversationId) return
  const sectionId = state.conversationToSection.get(conversationId)
  if (!sectionId) return

  const cid = message?.clientId
  if (cid) {
    const record = sentLocal.get(cid)
    if (record && record.sectionId === sectionId && record.conversationId === conversationId) {
      sentLocal.delete(cid)
      return
    }
  }

  const sender =
    message?.senderName ||
    message?.sender ||
    message?.user ||
    message?.from ||
    'Someone'
  const text =
    (typeof message?.text === 'string' && message.text) ||
    (typeof message?.message === 'string' && message.message) ||
    (typeof message?.ciphertext === 'string' && base64Decode(message.ciphertext)) ||
    ''

  appendComment(sectionId, {
    author: sender,
    text,
    createdAt: message?.createdAt,
    mine: false,
  })
}

function wireSocket() {
  const base = $('serverUrl')?.value.trim() || ''
  const path = $('wsPath')?.value.trim() || '/ws'
  const token = $('authToken')?.value.trim()
  const url = base || window.location.origin

  state.serverUrl = url
  state.wsPath = path

  if (state.socket) {
    state.socket.disconnect()
  }

  log(`Connecting to ${url}${path}`)
  connectBtn.disabled = true
  updateConnectionStatus('connecting…', false)

  const opts = { path, transports: ['websocket', 'polling'] }
  if (token) opts.auth = { token }
  const socket = io(url, opts)
  state.socket = socket

  socket.on('connect', () => {
    state.connected = true
    updateConnectionStatus('connected', true)
    disconnectBtn.disabled = false
    log('Socket connected', socket.id)
    SECTIONS.forEach((section) => {
      const convo = state.sectionConversations[section.id]
      if (convo) joinConversation(convo, section.id)
    })
    updateAllComposerStates()
  })

  socket.on('disconnect', (reason) => {
    state.connected = false
    updateConnectionStatus(`disconnected (${reason})`, false)
    disconnectBtn.disabled = true
    connectBtn.disabled = false
    log('Socket disconnected', reason)
    updateAllComposerStates()
  })

  socket.on('connect_error', (err) => {
    state.connected = false
    updateConnectionStatus('connect error', false)
    connectBtn.disabled = false
    disconnectBtn.disabled = true
    log('connect_error', err?.message || err)
  })

  socket.on('chat.ready', (payload) => {
    log('chat.ready', payload)
  })

  socket.on(EVT.MESSAGE, (payload) => {
    handleIncomingMessage(payload)
  })
}

function updateConnectionStatus(text, online) {
  if (!statusEl) return
  statusEl.textContent = text
  if (online) {
    statusEl.classList.add('active')
    statusEl.classList.remove('error')
  } else {
    statusEl.classList.remove('active')
  }
}

function tearDownSocket() {
  if (!state.socket) return
  log('Disconnect requested')
  state.socket.disconnect()
  state.socket = null
  state.connected = false
  updateConnectionStatus('disconnected', false)
  disconnectBtn.disabled = true
  connectBtn.disabled = false
  updateAllComposerStates()
}

function resetAssignments() {
  SECTIONS.forEach((section) => setConversation(section.id, null))
  log('Cleared all conversation assignments')
}

function init() {
  if (!logEl || !statusEl || !connectBtn || !disconnectBtn) return
  renderSections()
  connectBtn.addEventListener('click', wireSocket)
  disconnectBtn.addEventListener('click', tearDownSocket)
  clearAssignmentsBtn?.addEventListener('click', resetAssignments)
  updateAllComposerStates()
  log('Ready to wire LinkedIn-style comments.')
}

init()
