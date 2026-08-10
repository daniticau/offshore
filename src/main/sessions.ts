import { app, session, shell, type Session } from 'electron'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { adblock } from './adblock'
import { downloadsStore } from './stores'
import { clientHintHeaders, handleOffshoreProtocol, normalizeUserAgent } from './util'

/**
 * Every browsing session partition (the shared one plus each separate-login
 * space) goes through prepareTabSession so downloads, permissions, the
 * offshore:// scheme, UA normalization, and adblock apply uniformly.
 */

export const TAB_PARTITION = 'persist:offshore'

const prepared = new Map<string, Session>()

let broadcastFn: (channel: string, ...args: unknown[]) => void = () => {}
let permissionPrompt: (message: string) => Promise<boolean> = async () => false

export function initSessions(opts: {
  broadcast: (channel: string, ...args: unknown[]) => void
  permissionPrompt: (message: string) => Promise<boolean>
}): void {
  broadcastFn = opts.broadcast
  permissionPrompt = opts.permissionPrompt
}

export function spacePartition(spaceId: string): string {
  return `persist:space-${spaceId}`
}

export function preparedSessions(): Session[] {
  return [...prepared.values()]
}

export function tabSession(): Session {
  return prepareTabSession(TAB_PARTITION)
}

export function prepareTabSession(partition: string): Session {
  const existing = prepared.get(partition)
  if (existing) return existing
  const ses = session.fromPartition(partition)
  prepared.set(partition, ses)
  ses.setUserAgent(normalizeUserAgent(ses.getUserAgent()), 'en-US,en')
  setupClientHints(ses)
  try {
    ses.protocol.handle('offshore', handleOffshoreProtocol)
  } catch {
    /* already registered for this session */
  }
  setupPermissions(ses)
  setupDownloads(ses)
  adblock.attachSession(ses)
  return ses
}

/** Re-attach the client hints Electron drops when the UA is overridden. Safe to own
 * onBeforeSendHeaders here: the adblocker uses onBeforeRequest/onHeadersReceived and
 * the extensions layer uses onHeadersReceived, so nothing else claims this event. */
function setupClientHints(ses: Session): void {
  const hints = clientHintHeaders()
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    if (details.url.startsWith('https://') || details.url.startsWith('http://')) {
      const present = new Set(Object.keys(details.requestHeaders).map((k) => k.toLowerCase()))
      for (const [name, value] of Object.entries(hints)) {
        if (!present.has(name)) details.requestHeaders[name] = value
      }
    }
    cb({ requestHeaders: details.requestHeaders })
  })
}

// ---------------- permissions ----------------

function setupPermissions(ses: Session): void {
  const autoAllow = new Set([
    'fullscreen',
    'pointerLock',
    'clipboard-sanitized-write',
    'mediaKeySystem',
    'speaker-selection'
  ])
  const autoDeny = new Set(['geolocation', 'notifications', 'midi', 'midiSysex', 'hid', 'serial', 'usb'])

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (autoAllow.has(permission)) return callback(true)
    if (autoDeny.has(permission)) return callback(false)
    if (permission === 'media') {
      // Camera/mic: ask the human, once per request
      const host = (() => {
        try {
          return new URL(details.requestingUrl).hostname
        } catch {
          return 'this site'
        }
      })()
      void permissionPrompt(`Allow ${host} to use your camera and microphone?`).then(callback)
      return
    }
    callback(false)
  })
}

// ---------------- downloads ----------------

/** download id -> save path; renderers only ever pass ids back, never paths. */
const downloadPaths = new Map<string, string>()

export function openDownload(id: string): void {
  const path = downloadPaths.get(id) ?? downloadsStore.pathOf(id)
  if (path && existsSync(path)) void shell.openPath(path)
}

export function revealDownload(id: string): void {
  const path = downloadPaths.get(id) ?? downloadsStore.pathOf(id)
  if (path && existsSync(path)) shell.showItemInFolder(path)
}

function setupDownloads(ses: Session): void {
  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads')
    const original = item.getFilename() || 'download'
    let target = join(dir, original)
    let counter = 1
    while (existsSync(target)) {
      const dot = original.lastIndexOf('.')
      const stem = dot > 0 ? original.slice(0, dot) : original
      const ext = dot > 0 ? original.slice(dot) : ''
      target = join(dir, `${stem} (${counter})${ext}`)
      counter += 1
    }
    item.setSavePath(target)
    const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    downloadPaths.set(id, target)
    downloadsStore.add({
      id,
      filename: basename(target),
      path: target,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now()
    })
    const send = (state: string): void => {
      broadcastFn('downloads:event', {
        id,
        filename: basename(target),
        state,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes()
      })
    }
    item.on('updated', (_ev, state) => send(state === 'interrupted' ? 'interrupted' : 'progressing'))
    item.once('done', (_ev, state) => {
      downloadsStore.update(id, {
        state: state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes()
      })
      send(state)
    })
    send('progressing')
  })
}
