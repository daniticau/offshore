import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { SessionWindowV2, TabsState } from '@shared/types'
import { popupOwner } from './popups'
import { sessionStore, settingsStore } from './stores'
import { TabManager, type Tab, type TabHost } from './tabs'
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

/** How long we wait for the chrome to say it has painted the still. */
const FREEZE_ACK_MS = 250

export class OffshoreWindow implements TabHost {
  win: BrowserWindow
  tabs: TabManager
  private insets: Insets
  private contentFullscreen = false
  private overlayOpen = false
  /** Resolves when the chrome has the freeze frames up; see setOverlay. */
  private freezeAck: (() => void) | null = null
  /** Bumped per overlay change so a stale capture never lands. */
  private overlayGen = 0

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
    /*
     * Zoom, un-zoom and full screen all animate the frame, and the content size
     * arrives a beat after the event does. The page view is ours to move by hand
     * — a native one would follow the window itself — so every one of these
     * transitions gets a layout now and another once the frame has settled.
     * Without the second pass an un-zoom can leave the view at the size the
     * window used to be, which reads as a glitch along the edges.
     */
    this.win.on('maximize', () => this.settleLayout())
    this.win.on('unmaximize', () => this.settleLayout())
    this.win.on('restore', () => this.settleLayout())
    this.win.on('enter-full-screen', () => this.settleLayout())
    this.win.on('leave-full-screen', () => this.settleLayout())

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

  /**
   * A new tab, and the cursor in whichever search the layout has already put in
   * front of you.
   *
   * Vertical tucks the address bar away down the side, so the page carries a
   * pill in the middle of itself and that pill takes the cursor. Horizontal has
   * the address bar sitting right above the page — so nothing appears in the
   * middle of the screen, and the cursor starts up there, exactly the way it
   * does in Chrome.
   */
  openNewTab(): Tab {
    const tab = this.tabs.createTab()
    if (settingsStore.get().tabOrientation === 'horizontal') {
      // The chrome has to know it is looking at a fresh tab *before* it takes
      // the cursor. State pushes are batched by a frame; the focus message is
      // not, so it would arrive first and the address bar would open selecting
      // the address of the tab you just left.
      this.pushState(this.tabs.state())
      this.win.webContents.focus()
      this.sendToChrome('omnibox:focus')
    } else {
      tab.wc.focus()
    }
    return tab
  }

  onTabsChanged(): void {
    serializeSession()
  }

  // ---- chrome UI hooks ----

  setInsets(insets: Insets): void {
    this.insets = insets
    this.tabs.layout()
  }

  /** Lay the views out now, and again when the window frame stops moving. */
  private settleLayout(): void {
    this.tabs.layout()
    setTimeout(() => {
      if (!this.win.isDestroyed()) this.tabs.layout()
    }, 260)
  }

  /**
   * A chrome panel needs the space the page is sitting in.
   *
   * The chrome renders *under* the page views, so the view has to step aside for
   * a panel to be seen at all — which used to leave a blank card behind it. So
   * we photograph the page first, hand the picture to the chrome, wait for it to
   * be on screen, and only then hide the live view. Nothing appears to move.
   *
   * On the way back the view is shown before the picture is dropped: it paints
   * over the still, so again there is no frame where neither is there.
   */
  setOverlay(open: boolean): void {
    const gen = ++this.overlayGen
    this.overlayOpen = open
    if (!open) {
      this.tabs.setActiveVisible(true, () => {
        if (gen === this.overlayGen) this.sendToChrome('chrome:page-freeze', null)
      })
      this.tabs.activeTab?.wc.focus()
      return
    }
    void (async () => {
      const frames = await this.tabs.captureVisible()
      // the panel may have come and gone while the shutter was open
      if (gen !== this.overlayGen || this.win.isDestroyed()) return
      if (frames.length) {
        this.sendToChrome('chrome:page-freeze', frames)
        await this.awaitFreezeAck()
        if (gen !== this.overlayGen || this.win.isDestroyed()) return
      }
      this.tabs.setActiveVisible(false)
    })()
  }

  /** The chrome has the still up — or it has had long enough to say so. */
  onFreezeAck(): void {
    const ack = this.freezeAck
    this.freezeAck = null
    ack?.()
  }

  private awaitFreezeAck(): Promise<void> {
    this.onFreezeAck()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.freezeAck === fire) this.freezeAck = null
        resolve()
      }, FREEZE_ACK_MS)
      const fire = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.freezeAck = fire
    })
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
