import {
  Menu,
  MenuItem,
  WebContentsView,
  clipboard,
  session,
  type BrowserWindow,
  type Rectangle,
  type WebContents
} from 'electron'
import { join } from 'path'
import type { FindResult, TabInfo, TabsState } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/types'
import { adblock } from './adblock'
import { extensionsRef } from './extensions-ref'
import { bookmarksStore, historyStore, settingsStore } from './stores'
import {
  internalPageUrl,
  isInternalUrl,
  resolveOmniboxInput,
  toDisplayUrl
} from './util'

export const TAB_PARTITION = 'persist:offshore'

export function tabSession() {
  return session.fromPartition(TAB_PARTITION)
}

export interface TabHost {
  win: BrowserWindow
  contentBounds(): Rectangle
  fullBounds(): Rectangle
  isContentFullscreen(): boolean
  setContentFullscreen(v: boolean): void
  isOverlayOpen(): boolean
  pushState(state: TabsState): void
  sendToChrome(channel: string, ...args: unknown[]): void
  onTabsChanged(): void
}

export class Tab {
  readonly view: WebContentsView
  favicon?: string
  loadError?: string

  constructor(initialUrl: string) {
    this.view = new WebContentsView({
      webPreferences: {
        session: tabSession(),
        preload: join(__dirname, '../preload/internal.js'),
        sandbox: true,
        contextIsolation: true,
        scrollBounce: true,
        safeDialogs: true
      }
    })
    this.setBackgroundForUrl(initialUrl)
    const radius = 10
    const v = this.view as WebContentsView & { setBorderRadius?: (r: number) => void }
    if (typeof v.setBorderRadius === 'function') v.setBorderRadius(radius)
  }

  get id(): number {
    return this.view.webContents.id
  }

  get wc(): WebContents {
    return this.view.webContents
  }

  setBackgroundForUrl(url: string): void {
    this.view.setBackgroundColor(isInternalUrl(url) ? '#00000000' : '#FFFFFFFF')
  }

  info(activeInWindow: boolean): TabInfo {
    const wc = this.wc
    const url = wc.getURL() || ''
    let canGoBack = false
    let canGoForward = false
    try {
      canGoBack = wc.navigationHistory.canGoBack()
      canGoForward = wc.navigationHistory.canGoForward()
    } catch {
      /* older API fallback below */
    }
    void activeInWindow
    return {
      id: this.id,
      url,
      displayUrl: toDisplayUrl(url),
      title: wc.getTitle() || 'New Tab',
      favicon: this.favicon,
      isLoading: wc.isLoading(),
      canGoBack,
      canGoForward,
      audible: wc.isCurrentlyAudible(),
      muted: wc.isAudioMuted(),
      blockedCount: adblock.counts.get(this.id) ?? 0,
      isBookmarked: bookmarksStore.isBookmarked(url)
    }
  }
}

export class TabManager {
  private host: TabHost
  tabs: Tab[] = []
  activeTabId = -1
  private closedUrls: string[] = []
  private pushTimer: NodeJS.Timeout | null = null

  constructor(host: TabHost) {
    this.host = host
  }

  get activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId)
  }

  byId(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id)
  }

  createTab(url?: string, opts: { activate?: boolean; index?: number } = {}): Tab {
    const target = url || internalPageUrl('start')
    const tab = new Tab(target)
    const index = opts.index ?? this.tabs.length
    this.tabs.splice(index, 0, tab)
    this.host.win.contentView.addChildView(tab.view)
    tab.view.setVisible(false)
    this.wireTab(tab)
    try {
      extensionsRef.current?.addTab(tab.wc, this.host.win)
    } catch (err) {
      console.warn('[extensions] addTab failed:', err)
    }
    void tab.wc.loadURL(target).catch(() => {})
    if (opts.activate !== false) this.activateTab(tab.id)
    this.pushState()
    this.host.onTabsChanged()
    return tab
  }

  activateTab(id: number): void {
    const tab = this.byId(id)
    if (!tab) return
    const prev = this.activeTab
    this.activeTabId = id
    for (const t of this.tabs) {
      t.view.setVisible(t.id === id && !this.host.isOverlayOpen())
    }
    this.layout()
    try {
      extensionsRef.current?.selectTab(tab.wc)
    } catch {
      /* extension system optional */
    }
    if (!this.host.isOverlayOpen()) tab.wc.focus()
    // Arc-style mini-player: video keeps playing in a floating PiP window
    if (prev && prev.id !== id) this.maybeEnterPip(prev)
    if (this.pipTabId === id) this.exitPip(tab)
    this.pushState()
  }

  private pipTabId: number | null = null

  private maybeEnterPip(tab: Tab): void {
    if (!settingsStore.get().autoPip) return
    if (!tab.wc.isCurrentlyAudible()) return
    if (!/^https?:/.test(tab.wc.getURL())) return
    const ENTER = `(() => {
      const vids = [...document.querySelectorAll('video')].filter(v => !v.paused && !v.ended && v.readyState > 2)
      const v = vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
      if (v && document.pictureInPictureEnabled && !document.pictureInPictureElement) {
        v.requestPictureInPicture().catch(() => {})
        return true
      }
      return false
    })()`
    tab.wc
      .executeJavaScript(ENTER, true)
      .then((entered) => {
        if (entered) this.pipTabId = tab.id
      })
      .catch(() => {})
  }

  private exitPip(tab?: Tab): void {
    this.pipTabId = null
    if (!tab) return
    const EXIT = `if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})`
    void tab.wc.executeJavaScript(EXIT, true).catch(() => {})
  }

  closeTab(id: number): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return
    const [tab] = this.tabs.splice(idx, 1)
    if (this.pipTabId === tab.id) this.pipTabId = null
    const url = tab.wc.getURL()
    if (url && !isInternalUrl(url)) this.closedUrls.push(url)
    if (this.activeTabId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1]
      this.activeTabId = -1
      if (next) this.activateTab(next.id)
    }
    this.host.win.contentView.removeChildView(tab.view)
    adblock.dropTab(id)
    tab.wc.close()
    if (this.tabs.length === 0) {
      this.host.win.close()
    }
    this.pushState()
    this.host.onTabsChanged()
  }

  reopenClosedTab(): void {
    const url = this.closedUrls.pop()
    if (url) this.createTab(url)
  }

  reorder(ids: number[]): void {
    const byId = new Map(this.tabs.map((t) => [t.id, t]))
    const next: Tab[] = []
    for (const id of ids) {
      const t = byId.get(id)
      if (t) {
        next.push(t)
        byId.delete(id)
      }
    }
    next.push(...byId.values())
    this.tabs = next
    this.pushState()
    this.host.onTabsChanged()
  }

  navigate(id: number | null, input: string): void {
    const tab = id == null ? this.activeTab : this.byId(id)
    if (!tab) return
    const url = resolveOmniboxInput(input, settingsStore.get())
    tab.loadError = undefined
    tab.setBackgroundForUrl(url)
    void tab.wc.loadURL(url).catch(() => {})
    tab.wc.focus()
  }

  layout(): void {
    const active = this.activeTab
    if (!active) return
    const bounds = this.host.isContentFullscreen() ? this.host.fullBounds() : this.host.contentBounds()
    active.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    })
  }

  setActiveVisible(visible: boolean): void {
    this.activeTab?.view.setVisible(visible)
    if (visible) this.layout()
  }

  serialize(): string[] {
    return this.tabs
      .map((t) => t.wc.getURL())
      .filter((u) => !!u)
      .map((u) => (isInternalUrl(u) ? toDisplayUrl(u) : u))
  }

  state(): TabsState {
    return {
      tabs: this.tabs.map((t) => t.info(t.id === this.activeTabId)),
      activeTabId: this.activeTabId
    }
  }

  pushState(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.host.pushState(this.state())
    }, 16)
  }

  destroy(): void {
    for (const tab of this.tabs) {
      try {
        this.host.win.contentView.removeChildView(tab.view)
        tab.wc.close()
      } catch {
        /* window is going away */
      }
      adblock.dropTab(tab.id)
    }
    this.tabs = []
  }

  private wireTab(tab: Tab): void {
    const wc = tab.wc

    wc.setVisualZoomLevelLimits(1, 3).catch(() => {})

    wc.on('page-title-updated', (_e, title) => {
      historyStore.setTitle(wc.getURL(), title)
      this.pushState()
    })

    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[favicons.length - 1]
      this.pushState()
    })

    wc.on('did-start-loading', () => this.pushState())
    wc.on('did-stop-loading', () => this.pushState())

    wc.on('did-navigate', (_e, url) => {
      tab.loadError = undefined
      adblock.resetCount(tab.id)
      tab.setBackgroundForUrl(url)
      historyStore.record(url)
      this.pushState()
      this.host.onTabsChanged()
    })

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        historyStore.record(url)
        this.pushState()
      }
    })

    wc.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3 && errorCode !== 0) {
        tab.loadError = errorDescription
        this.pushState()
      }
    })

    wc.on('audio-state-changed', () => this.pushState())

    wc.on('enter-html-full-screen', () => {
      this.host.setContentFullscreen(true)
      this.layout()
    })
    wc.on('leave-html-full-screen', () => {
      this.host.setContentFullscreen(false)
      this.layout()
    })

    wc.on('found-in-page', (_e, result) => {
      const payload: FindResult = {
        activeMatch: result.activeMatchOrdinal,
        matches: result.matches
      }
      this.host.sendToChrome('find:result', payload)
    })

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit') {
        tab.loadError = `Page crashed (${details.reason})`
        this.pushState()
      }
    })

    wc.on('context-menu', (_e, params) => {
      this.showContextMenu(tab, params)
    })

    wc.setWindowOpenHandler((details) => {
      if (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') {
        const idx = this.tabs.findIndex((t) => t.id === tab.id)
        this.createTab(details.url, {
          activate: details.disposition === 'foreground-tab',
          index: idx + 1
        })
        return { action: 'deny' }
      }
      // Real popup (window.open with features) — allow as a lightweight window, e.g. OAuth
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { session: tabSession(), sandbox: true, contextIsolation: true }
        }
      }
    })
  }

  private showContextMenu(tab: Tab, params: Electron.ContextMenuParams): void {
    const wc = tab.wc
    const menu = new Menu()
    const add = (opts: Electron.MenuItemConstructorOptions) => menu.append(new MenuItem(opts))

    if (params.linkURL) {
      const idx = this.tabs.findIndex((t) => t.id === tab.id)
      add({
        label: 'Open Link in New Tab',
        click: () => this.createTab(params.linkURL, { index: idx + 1 })
      })
      add({
        label: 'Open Link in Background',
        click: () => this.createTab(params.linkURL, { activate: false, index: idx + 1 })
      })
      add({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) })
      add({ type: 'separator' })
    }

    if (params.hasImageContents && params.srcURL) {
      add({ label: 'Open Image in New Tab', click: () => this.createTab(params.srcURL) })
      add({ label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) })
      add({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) })
      add({ type: 'separator' })
    }

    if (params.selectionText && !params.isEditable) {
      const engine = SEARCH_ENGINES[settingsStore.get().searchEngine]
      const snippet =
        params.selectionText.length > 30
          ? `${params.selectionText.slice(0, 30)}…`
          : params.selectionText
      add({ label: 'Copy', role: 'copy' })
      add({
        label: `Search ${engine.name} for “${snippet}”`,
        click: () =>
          this.createTab(engine.searchUrl.replace('%s', encodeURIComponent(params.selectionText)))
      })
      add({ type: 'separator' })
    }

    if (params.isEditable) {
      add({ label: 'Undo', role: 'undo' })
      add({ label: 'Redo', role: 'redo' })
      add({ type: 'separator' })
      add({ label: 'Cut', role: 'cut' })
      add({ label: 'Copy', role: 'copy' })
      add({ label: 'Paste', role: 'paste' })
      add({ label: 'Select All', role: 'selectAll' })
      add({ type: 'separator' })
    }

    if (!params.linkURL && !params.hasImageContents && !params.selectionText && !params.isEditable) {
      add({ label: 'Back', enabled: tab.info(true).canGoBack, click: () => this.goBack(tab.id) })
      add({
        label: 'Forward',
        enabled: tab.info(true).canGoForward,
        click: () => this.goForward(tab.id)
      })
      add({ label: 'Reload', click: () => wc.reload() })
      add({ type: 'separator' })
    }

    try {
      const items = extensionsRef.current?.getContextMenuItems(wc, params) ?? []
      if (items.length) {
        for (const item of items) menu.append(item)
        menu.append(new MenuItem({ type: 'separator' }))
      }
    } catch {
      /* extension menus are best-effort */
    }

    add({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) })
    menu.popup({ window: this.host.win })
  }

  goBack(id?: number): void {
    const tab = id == null ? this.activeTab : this.byId(id)
    try {
      tab?.wc.navigationHistory.goBack()
    } catch {
      /* nothing to go back to */
    }
  }

  goForward(id?: number): void {
    const tab = id == null ? this.activeTab : this.byId(id)
    try {
      tab?.wc.navigationHistory.goForward()
    } catch {
      /* nothing forward */
    }
  }
}
