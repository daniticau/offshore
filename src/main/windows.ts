import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { SessionWindowV2, TabsState } from '@shared/types'
import { popupOwner } from './popups'
import { sessionStore, settingsStore } from './stores'
import { TabManager, type TabHost } from './tabs'
import { devRendererUrl, remapInternal } from './util'

export interface Insets {
  top: number
  left: number
  right: number
  bottom: number
}

/** Pre-first-paint fallback only; steady-state insets are measured from the chrome DOM. */
const DEFAULT_INSETS: Record<'vertical' | 'horizontal', Insets> = {
  vertical: { top: 10, left: 252, right: 10, bottom: 10 },
  horizontal: { top: 92, left: 10, right: 10, bottom: 10 }
}

export const windows = new Set<OffshoreWindow>()

let lastFocused: OffshoreWindow | undefined
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function focusedOffshoreWindow(): OffshoreWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    for (const w of windows) {
      if (w.win.id === focused.id) return w
    }
    // A focused popup routes to its owning window
    const owner = popupOwner(focused)
    if (owner && windows.has(owner)) return owner
  }
  if (lastFocused && windows.has(lastFocused)) return lastFocused
  return windows.values().next().value
}

export function windowForBrowserWindow(bw: Pick<BrowserWindow, 'id'>): OffshoreWindow | undefined {
  for (const w of windows) if (w.win.id === bw.id) return w
  return undefined
}

export function windowForBrowserWindowId(id: number): OffshoreWindow | undefined {
  for (const w of windows) if (w.win.id === id) return w
  return undefined
}

export function windowForTab(tabId: number): OffshoreWindow | undefined {
  for (const w of windows) if (w.tabs.byId(tabId)) return w
  return undefined
}

export function windowForChromeContents(wcId: number): OffshoreWindow | undefined {
  for (const w of windows) if (w.win.webContents.id === wcId) return w
  return undefined
}

function clampBounds(b: { x: number; y: number; width: number; height: number }): Electron.Rectangle {
  const display = screen.getDisplayMatching(b)
  const wa = display.workArea
  const width = Math.min(Math.max(b.width, 660), wa.width)
  const height = Math.min(Math.max(b.height, 420), wa.height)
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width)
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height)
  return { x, y, width, height }
}

export class OffshoreWindow implements TabHost {
  win: BrowserWindow
  tabs: TabManager
  private insets: Insets
  private contentFullscreen = false
  private overlayOpen = false

  constructor(restore?: SessionWindowV2 | string[]) {
    this.insets = DEFAULT_INSETS[settingsStore.get().tabOrientation]

    const saved = restore && !Array.isArray(restore) && restore.bounds ? clampBounds(restore.bounds) : null
    const cascade = !saved && lastFocused && !lastFocused.win.isDestroyed()
      ? (() => {
          const [x, y] = lastFocused!.win.getPosition()
          return clampBounds({ x: x + 28, y: y + 28, width: 1380, height: 880 })
        })()
      : null

    this.win = new BrowserWindow({
      width: saved?.width ?? cascade?.width ?? 1380,
      height: saved?.height ?? cascade?.height ?? 880,
      ...(saved ? { x: saved.x, y: saved.y } : cascade ? { x: cascade.x, y: cascade.y } : {}),
      minWidth: 660,
      minHeight: 420,
      show: false,
      titleBarStyle: 'hiddenInset',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      title: 'Offshore',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true
      }
    })

    this.tabs = new TabManager(this)
    windows.add(this)
    lastFocused ??= this

    this.win.on('resize', () => this.tabs.layout())
    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('closed', () => {
      this.tabs.destroy()
      windows.delete(this)
      if (lastFocused === this) lastFocused = undefined
      if (!quitting) serializeSession()
    })
    this.win.on('focus', () => {
      lastFocused = this
      // Keep page focus in the content, not the chrome, when returning to the window
      if (!this.overlayOpen) this.tabs.activeTab?.wc.focus()
    })
    this.win.on('resized', () => this.onTabsChanged())
    this.win.on('moved', () => this.onTabsChanged())

    const dev = devRendererUrl()
    if (dev) {
      void this.win.loadURL(`${dev}/index.html`)
    } else {
      void this.win.loadFile(join(__dirname, '../renderer/index.html'))
    }

    this.win.webContents.on('did-finish-load', () => {
      this.pushState(this.tabs.state())
      this.sendToChrome('settings:changed', settingsStore.get())
    })

    if (restore && !Array.isArray(restore)) {
      this.tabs.restoreFromSession(restore)
    } else {
      const urls = restore?.length ? restore : [undefined]
      for (const url of urls) {
        this.tabs.createTab(url ? remapInternal(url) : undefined, { activate: true })
      }
    }
  }

  // ---- TabHost ----

  contentBounds() {
    const [width, height] = this.win.getContentSize()
    const { top, left, right, bottom } = this.insets
    return {
      x: left,
      y: top,
      width: Math.max(0, width - left - right),
      height: Math.max(0, height - top - bottom)
    }
  }

  fullBounds() {
    const [width, height] = this.win.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  isContentFullscreen(): boolean {
    return this.contentFullscreen
  }

  setContentFullscreen(v: boolean): void {
    this.contentFullscreen = v
  }

  isOverlayOpen(): boolean {
    return this.overlayOpen
  }

  pushState(state: TabsState): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('tabs:state', state)
  }

  sendToChrome(channel: string, ...args: unknown[]): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, ...args)
  }

  onTabsChanged(): void {
    serializeSession()
  }

  // ---- chrome UI hooks ----

  setInsets(insets: Insets): void {
    this.insets = insets
    this.tabs.layout()
  }

  setOverlay(open: boolean): void {
    this.overlayOpen = open
    this.tabs.setActiveVisible(!open)
    if (!open) this.tabs.activeTab?.wc.focus()
  }

  /** Dynamic density: chrome hid/revealed itself — keep traffic lights in sync. */
  setCollapsed(collapsed: boolean): void {
    try {
      this.win.setWindowButtonVisibility(!collapsed)
    } catch {
      /* not macOS */
    }
  }
}

/** Persist every window's spaces/tabs/bounds (debounced by the store). */
export function serializeSession(): void {
  if (quitting) return
  const snapshot = [...windows]
    .filter((w) => !w.win.isDestroyed())
    .map((w) => ({
      ...w.tabs.serializeWindow(),
      bounds: w.win.getNormalBounds()
    }))
  sessionStore.set(snapshot)
}

export function createWindow(restore?: SessionWindowV2 | string[]): OffshoreWindow {
  return new OffshoreWindow(restore)
}
