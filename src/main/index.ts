import { boot } from './bootstrap'
import * as electron from 'electron'
import { app, dialog, nativeTheme, protocol } from 'electron'
import { adblock } from './adblock'
import { setupDevshot } from './devshot'
import { initExtensions } from './extensions'
import { setupIpc } from './ipc'
import { installMenu } from './menu'
import { passwordVault } from './passwords'
import { flushAllStores, historyStore, sessionStore, settingsStore } from './stores'
import { initSessions, prepareTabSession, TAB_PARTITION } from './sessions'
import { handleOffshoreProtocol, internalPageUrl } from './util'
import type { Settings, ThemePref } from '@shared/types'
import { createWindow, focusedOffshoreWindow, markQuitting, windows } from './windows'

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
    if (!settingsStore.get().onboarded) {
      if (url) pendingUrls.push(url)
      focusedOffshoreWindow()?.win.focus()
      return
    }
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
  if (!app.isReady() || !settingsStore.get().onboarded) {
    pendingUrls.push(url)
    return
  }
  const w = focusedOffshoreWindow()
  if (w) w.tabs.createTab(url)
  else createWindow([url])
})

const pendingUrls: string[] = []

function flushPendingUrls(): void {
  if (!pendingUrls.length) return
  const urls = pendingUrls.splice(0)
  const w = focusedOffshoreWindow()
  if (w) {
    for (const url of urls) w.tabs.createTab(url)
    w.win.focus()
  } else {
    createWindow(urls)
  }
}

function applyTheme(pref: ThemePref): void {
  nativeTheme.themeSource = pref
}

/** Startup must not be held hostage by one slow subsystem. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ])
}

void app.whenReady().then(async () => {
  boot('whenReady')
  applyTheme(settingsStore.get().appearance.theme)

  // Widevine CDM (castLabs Electron for Content Security). Protected playback —
  // Netflix, Spotify Web, etc. — needs the component installed and verified
  // before the first DRM request; a miss just means no DRM this launch.
  try {
    const { components } = electron as unknown as {
      components?: { whenReady(): Promise<unknown>; status(): unknown }
    }
    if (components) {
      await withTimeout(components.whenReady(), 30_000, 'widevine')
      console.log('[widevine] ready:', JSON.stringify(components.status()))
    } else {
      console.warn('[widevine] components API missing — not the castLabs build?')
    }
  } catch (err) {
    console.error('[widevine] unavailable this launch:', err)
  }
  boot('widevine done')

  initSessions({
    broadcast: (channel, ...args) => {
      for (const w of windows) w.sendToChrome(channel, ...args)
    },
    permissionPrompt: async (message) => {
      const w = focusedOffshoreWindow()
      const opts = {
        type: 'question' as const,
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        message
      }
      const r = w ? await dialog.showMessageBox(w.win, opts) : await dialog.showMessageBox(opts)
      return r.response === 0
    }
  })

  boot('initSessions done')
  protocol.handle('offshore', handleOffshoreProtocol)
  boot('protocol.handle done')
  prepareTabSession(TAB_PARTITION)
  boot('prepareTabSession done')

  setupIpc()
  boot('setupIpc done')
  installMenu()
  boot('installMenu done')
  // Armed before the extension host: a slow or wedged extension load must not
  // decide whether the dev harness ever gets to run.
  setupDevshot()
  boot('setupDevshot done')

  try {
    await withTimeout(initExtensions(), 15_000, 'extensions')
    boot('initExtensions done')
  } catch (err) {
    console.error('[extensions] init failed (continuing without):', err)
  }

  void adblock.init()
  boot('adblock kicked off')

  settingsStore.on('changed', (next: Settings, prev: Settings) => {
    if (next.appearance.theme !== prev.appearance.theme) {
      applyTheme(next.appearance.theme)
    }
    // Turning history off should also forget what we already kept
    if (prev.keepHistory && !next.keepHistory) historyStore.clear()
    // First-run onboarding finished: open anything that arrived while it ran
    if (!prev.onboarded && next.onboarded) flushPendingUrls()
  })

  nativeTheme.on('updated', () => {
    for (const w of windows) w.tabs.refreshBackgrounds()
  })

  const startupSettings = settingsStore.get()
  if (!startupSettings.onboarded) {
    createWindow([internalPageUrl('welcome')])
  } else {
    const restore = startupSettings.restoreSession ? sessionStore.get() : null
    if (restore?.windows.length) {
      for (const sw of restore.windows) createWindow(sw)
      flushPendingUrls()
    } else {
      const initial = pendingUrls.splice(0)
      createWindow(initial.length ? initial : undefined)
    }
  }

  app.on('activate', () => {
    if (windows.size === 0) createWindow()
  })
  boot(`ready, windows=${windows.size}`)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  markQuitting()
  flushAllStores()
  // The vault debounces its writes like the stores do, but lives apart from them
  passwordVault.flush()
})
