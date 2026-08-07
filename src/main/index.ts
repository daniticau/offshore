import './bootstrap'
import { app, dialog, nativeTheme, protocol } from 'electron'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { adblock } from './adblock'
import { setupDevshot } from './devshot'
import { initExtensions } from './extensions'
import { setupIpc } from './ipc'
import { installMenu } from './menu'
import { flushAllStores, sessionStore, settingsStore } from './stores'
import { tabSession } from './tabs'
import { handleOffshoreProtocol, internalPageUrl, normalizeUserAgent } from './util'
import { createWindow, focusedOffshoreWindow, windows } from './windows'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'offshore',
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
])

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => /^https?:\/\//.test(a))
    const w = focusedOffshoreWindow()
    if (w) {
      if (url) w.tabs.createTab(url)
      w.win.show()
      w.win.focus()
    } else {
      createWindow(url ? [url] : undefined)
    }
  })
}

app.on('open-url', (e, url) => {
  e.preventDefault()
  const w = focusedOffshoreWindow()
  if (w) w.tabs.createTab(url)
  else if (app.isReady()) createWindow([url])
  else pendingUrls.push(url)
})

const pendingUrls: string[] = []

void app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light'

  const ses = tabSession()
  ses.setUserAgent(normalizeUserAgent(ses.getUserAgent()))

  protocol.handle('offshore', handleOffshoreProtocol)
  ses.protocol.handle('offshore', handleOffshoreProtocol)

  setupPermissions(ses)
  setupDownloads(ses)

  try {
    await initExtensions()
  } catch (err) {
    console.error('[extensions] init failed (continuing without):', err)
  }

  void adblock.init(ses)

  setupIpc()
  installMenu()
  setupDevshot()

  const startupSettings = settingsStore.get()
  if (!startupSettings.onboarded) {
    createWindow([internalPageUrl('welcome')])
  } else {
    const restore = startupSettings.restoreSession ? sessionStore.get() : []
    const initial = [...restore, ...pendingUrls]
    createWindow(initial.length ? initial : undefined)
  }

  app.on('activate', () => {
    if (windows.size === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  flushAllStores()
})

function setupPermissions(ses: Electron.Session): void {
  const autoAllow = new Set([
    'fullscreen',
    'pointerLock',
    'clipboard-sanitized-write',
    'mediaKeySystem',
    'speaker-selection'
  ])
  const autoDeny = new Set(['geolocation', 'notifications', 'midi', 'midiSysex', 'hid', 'serial', 'usb'])

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
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
      const w = focusedOffshoreWindow()
      const opts = {
        type: 'question' as const,
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        message: `Allow ${host} to use your camera and microphone?`
      }
      const show = w ? dialog.showMessageBox(w.win, opts) : dialog.showMessageBox(opts)
      void show.then((r) => callback(r.response === 0))
      return
    }
    callback(false)
  })
}

function setupDownloads(ses: Electron.Session): void {
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
    const send = (state: string): void => {
      for (const w of windows) {
        w.sendToChrome('downloads:event', {
          id,
          filename: basename(target),
          state,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          savePath: target
        })
      }
    }
    item.on('updated', (_ev, state) => send(state === 'interrupted' ? 'interrupted' : 'progressing'))
    item.once('done', (_ev, state) => send(state))
    send('progressing')
  })
}
