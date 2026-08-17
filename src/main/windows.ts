import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { Insets, SessionWindowV2, TabsState } from '@shared/types'
import { HARNESS_ACTIVE, HARNESS_QUIET } from './bootstrap'
import { popupOwner } from './popups'
import { sessionStore, settingsStore } from './stores'
import { TabManager, type Tab, type TabHost } from './tabs'
import { devRendererUrl, remapInternal } from './util'

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
  return windowForBrowserWindowId(bw.id)
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

/**
 * Show a harness window as a 2px sliver hanging off the leftmost display,
 * positioned BEFORE the show so it never flashes over the human's work.
 * The focusless show still walks macOS's renderer-visibility marking path
 * (showInactive does not — captures come back 0×0), and the marking sticks.
 * The park trusts its own math rather than AppKit, which quietly drags a
 * wholly off-screen window back to a 40px sliver of its own choosing.
 */
export function quietShow(win: BrowserWindow): void {
  const { width } = win.getBounds()
  const [, wy] = win.getPosition()
  const left = screen
    .getAllDisplays()
    .reduce((min, d) => (d.bounds.x < min.bounds.x ? d : min))
  // keep the sliver inside that display's vertical range, or it occludes anyway
  const y = Math.min(Math.max(wy, left.bounds.y), left.bounds.y + left.bounds.height - 100)
  win.setPosition(left.bounds.x - width + 2, y)
  // the sliver satisfies AppKit; opacity and shadow are for the human — a
  // parked window still blooms a soft shadow onto the screen edge without this
  win.setHasShadow(false)
  win.setOpacity(0)
  // an invisible window still hit-tests: let the human's clicks fall through,
  // or a stray click on the parked sliver becomes a page gesture
  win.setIgnoreMouseEvents(true)
  win.setFocusable(false)
  win.show()
  win.setFocusable(true)
}

// Under the quiet harness, no window escapes: popups and anything else
// Chromium conjures outside OffshoreWindow's ready-to-show path get parked the
// moment they try to show. The log line names the escapee so a new window
// source is a diagnosis, not a mystery.
if (HARNESS_QUIET) {
  app.on('browser-window-created', (_e, win) => {
    win.on('show', () => {
      const b = win.getBounds()
      const onScreen = screen.getAllDisplays().some(
        (d) =>
          Math.min(b.x + b.width, d.bounds.x + d.bounds.width) - Math.max(b.x, d.bounds.x) > 10 &&
          Math.min(b.y + b.height, d.bounds.y + d.bounds.height) - Math.max(b.y, d.bounds.y) > 0
      )
      if (!onScreen && win.getOpacity() === 0) return
      console.log(`[quiet] reparked window "${win.getTitle()}" from ${JSON.stringify(b)}`)
      quietShow(win)
    })
  })
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
        contextIsolation: true,
        // The harness parks the window off-screen; Chromium would throttle an
        // occluded renderer's timers to 1Hz, and the chrome's own choreography
        // (peek delays, transitions) runs on those timers.
        backgroundThrottling: !HARNESS_ACTIVE
      }
    })

    /*
     * AppKit's own buttons go away and the chrome draws three of its own in
     * their place. Two reasons. The look: macOS colors its buttons whenever the
     * window is key, and the resting state we want is three neutral dots that
     * only light up under the pointer. And the behaviour: a real button sitting
     * over our chrome has its own AppKit tracking, which our drag regions kept
     * stealing the mouse from — that is why hovering the red one lit nothing in
     * a windowed frame while the same gesture worked in full screen.
     */
    try {
      this.win.setWindowButtonVisibility(false)
    } catch {
      /* not macOS — there were never any buttons to hide */
    }

    this.tabs = new TabManager(this)
    windows.add(this)
    lastFocused ??= this

    this.win.on('resize', () => this.tabs.layout())
    // Harness windows surface as an edge sliver, never over the human's work
    this.win.once('ready-to-show', () => (HARNESS_QUIET ? quietShow(this.win) : this.win.show()))
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
   * A new tab, cursor already in the pill the page puts in the middle of
   * itself — the one thing a new tab has that the empty window doesn't.
   *
   * The chrome decides what that means, because it is the only side that knows
   * whether you are already sitting on a blank tab with its search put away. Ask
   * it, the way pressing the New Tab row does, so ⌘T and the row cannot disagree
   * — pressing the key used to make a second blank tab and hand the first one a
   * row of its own in the sidebar.
   */
  openNewTab(): void {
    this.sendToChrome('newtab:request')
  }

  /**
   * Actually make the tab — the other half of newtab:request, called by the
   * chrome once it has decided a real tab is what's wanted. The cursor lands
   * where the layout keeps its search: vertical's new tab carries a pill in the
   * middle of the page, so the page takes it; horizontal has the address bar
   * right above the page, so the cursor starts up there, the way Chrome does it.
   */
  newTabNow(): Tab {
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

  /**
   * The chrome draws its own traffic lights, so there is nothing here to keep in
   * sync any more — they are three elements in the sidebar and they leave with
   * it. Kept as a no-op because the chrome still reports its state on every
   * collapse, and because a window that is not macOS never had buttons to hide.
   */
  setCollapsed(_collapsed: boolean): void {
    /* the lights are the chrome's now — see TrafficLights in Tabs.tsx */
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
