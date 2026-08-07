import { BrowserWindow } from 'electron'
import { join } from 'path'
import type { TabsState } from '@shared/types'
import { sessionStore, settingsStore } from './stores'
import { TabManager, type TabHost } from './tabs'
import { devRendererUrl, internalPageUrl, isInternalPage, toDisplayUrl } from './util'

export interface Insets {
  top: number
  left: number
  right: number
  bottom: number
}

const DEFAULT_INSETS: Record<'vertical' | 'horizontal', Insets> = {
  vertical: { top: 10, left: 252, right: 10, bottom: 10 },
  horizontal: { top: 92, left: 10, right: 10, bottom: 10 }
}

export const windows = new Set<OffshoreWindow>()

export function focusedOffshoreWindow(): OffshoreWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  for (const w of windows) {
    if (w.win === focused) return w
    // A focused WebContentsView belongs to a window too
    if (focused && w.win.id === focused.id) return w
  }
  return windows.values().next().value
}

export function windowForBrowserWindow(bw: Pick<BrowserWindow, 'id'>): OffshoreWindow | undefined {
  for (const w of windows) if (w.win === bw || w.win.id === bw.id) return w
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

export class OffshoreWindow implements TabHost {
  win: BrowserWindow
  tabs: TabManager
  private insets: Insets
  private contentFullscreen = false
  private overlayOpen = false

  constructor(initialUrls?: string[]) {
    this.insets = DEFAULT_INSETS[settingsStore.get().tabOrientation]

    this.win = new BrowserWindow({
      width: 1380,
      height: 880,
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

    this.win.on('resize', () => this.tabs.layout())
    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('closed', () => {
      this.tabs.destroy()
      windows.delete(this)
    })
    this.win.on('focus', () => {
      // Keep page focus in the content, not the chrome, when returning to the window
      if (!this.overlayOpen) this.tabs.activeTab?.wc.focus()
    })

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

    const urls = initialUrls?.length ? initialUrls : [undefined]
    for (const url of urls) {
      this.tabs.createTab(url ? remapInternal(url) : undefined, { activate: true })
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
    // Continuously persist the first window's tabs for session restore
    const first = windows.values().next().value
    if (first === this) {
      sessionStore.set(this.tabs.serialize())
    }
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
}

/** If a stored/session url is an offshore:// display url, map to a loadable url. */
function remapInternal(url: string): string {
  if (url.startsWith('offshore://')) {
    const page = url.replace('offshore://', '').replace(/\/.*$/, '')
    if (isInternalPage(page)) return internalPageUrl(page)
  }
  return url
}

export function createWindow(urls?: string[]): OffshoreWindow {
  return new OffshoreWindow(urls)
}

export function displayUrlsForSession(): string[] {
  const first = windows.values().next().value
  return first ? first.tabs.serialize().map(toDisplayUrl) : []
}
