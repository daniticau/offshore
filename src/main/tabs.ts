import {
  Menu,
  MenuItem,
  WebContentsView,
  clipboard,
  nativeTheme,
  type BrowserWindow,
  type Rectangle,
  type WebContents
} from 'electron'
import { join } from 'path'
import type {
  AccentId,
  FindResult,
  SessionSpaceV2,
  SessionWindowV2,
  SpaceInfo,
  SpaceProfile,
  TabInfo,
  TabsState
} from '@shared/types'
import { SEARCH_ENGINES } from '@shared/types'
import { adblock } from './adblock'
import { extensionsRef } from './extensions-ref'
import { passwordVault } from './passwords'
import {
  blockedPopupCount,
  popupDecision,
  recordBlocked,
  registerPageContents
} from './popups'
import { TAB_PARTITION, prepareTabSession, spacePartition, tabSession } from './sessions'
import { bookmarksStore, genId, historyStore, settingsStore } from './stores'
import {
  devRendererUrl,
  errorPageTarget,
  errorPageUrl,
  internalPageUrl,
  isInternalUrl,
  remapInternal,
  resolveOmniboxInput,
  toDisplayUrl
} from './util'
import type { OffshoreWindow } from './windows'

export { TAB_PARTITION, tabSession } from './sessions'

export interface Space {
  id: string
  name: string
  accent?: AccentId
  profile: SpaceProfile
  createdAt: number
  lastActiveTabId: number
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

function devOriginArgs(): string[] {
  const dev = devRendererUrl()
  if (!dev) return []
  try {
    return [`--offshore-dev-origin=${new URL(dev).origin}`]
  } catch {
    return []
  }
}

/** Fill saved credentials into a page when we hold some for its exact origin. */
export function maybeAutofill(wc: WebContents, partition: string): void {
  if (!settingsStore.get().passwords.enabled) return
  let u: URL
  try {
    u = new URL(wc.getURL())
  } catch {
    return
  }
  const ok =
    u.protocol === 'https:' ||
    (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
  if (!ok) return
  const creds = passwordVault.pickForFill(u.origin, partition)
  if (creds) wc.send('passwords:fill', { username: creds.username, password: creds.password })
}

export class Tab {
  readonly view: WebContentsView
  readonly partition: string
  spaceId = ''
  favicon?: string
  loadError?: string
  /** 0–100 heuristic slop score reported by the page preload */
  slopScore?: number

  constructor(initialUrl: string, partition: string) {
    this.partition = partition
    this.view = new WebContentsView({
      webPreferences: {
        session: prepareTabSession(partition),
        preload: join(__dirname, '../preload/internal.js'),
        sandbox: true,
        contextIsolation: true,
        scrollBounce: true,
        safeDialogs: true,
        additionalArguments: devOriginArgs()
      }
    })
    this.setBackgroundForUrl(initialUrl)
    const v = this.view as WebContentsView & { setBorderRadius?: (r: number) => void }
    if (typeof v.setBorderRadius === 'function') v.setBorderRadius(12)
  }

  get id(): number {
    return this.view.webContents.id
  }

  get wc(): WebContents {
    return this.view.webContents
  }

  setBackgroundForUrl(url: string): void {
    // Electron reads 8-digit hex as #AARRGGBB, not #RRGGBBAA. Use the 6-digit
    // form for opaque colours so a stray alpha can never make the page view
    // translucent — a translucent view over real page content aborts the
    // compositor. Internal pages stay fully transparent so the chrome shows through.
    const webBg = nativeTheme.shouldUseDarkColors ? '#10181E' : '#FFFFFF'
    this.view.setBackgroundColor(isInternalUrl(url) ? '#00000000' : webBg)
  }

  info(): TabInfo {
    const wc = this.wc
    const url = wc.getURL() || ''
    const errorTarget = errorPageTarget(url)
    let canGoBack = false
    let canGoForward = false
    try {
      canGoBack = wc.navigationHistory.canGoBack()
      canGoForward = wc.navigationHistory.canGoForward()
    } catch {
      /* navigation history unavailable during teardown */
    }
    const effectiveUrl = errorTarget ?? url
    return {
      id: this.id,
      spaceId: this.spaceId,
      url,
      displayUrl: errorTarget ?? toDisplayUrl(url),
      title: errorTarget ? 'Problem loading page' : wc.getTitle() || 'New Tab',
      favicon: errorTarget ? undefined : this.favicon,
      isLoading: wc.isLoading(),
      canGoBack,
      canGoForward,
      audible: wc.isCurrentlyAudible(),
      muted: wc.isAudioMuted(),
      blockedCount: adblock.counts.get(this.id) ?? 0,
      blockedPopups: blockedPopupCount(this.id),
      isBookmarked: bookmarksStore.isBookmarked(effectiveUrl),
      slopScore: this.slopScore
    }
  }
}

export class TabManager {
  private host: TabHost
  tabs: Tab[] = []
  activeTabId = -1
  spaces: Space[] = []
  activeSpaceId = ''
  private closedTabs: { url: string; spaceId: string }[] = []
  private pushTimer: NodeJS.Timeout | null = null
  private pipTabId: number | null = null
  /** Two tabs sharing the content area side by side (Helium-style split). */
  splitPair: [number, number] | null = null

  constructor(host: TabHost) {
    this.host = host
    const main: Space = {
      id: genId(),
      name: 'Main',
      profile: 'shared',
      createdAt: Date.now(),
      lastActiveTabId: -1
    }
    this.spaces = [main]
    this.activeSpaceId = main.id
  }

  // ---- lookups ----

  get activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId)
  }

  byId(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id)
  }

  spaceById(id: string): Space | undefined {
    return this.spaces.find((s) => s.id === id)
  }

  get activeSpace(): Space {
    return this.spaceById(this.activeSpaceId) ?? this.spaces[0]
  }

  tabsIn(spaceId: string): Tab[] {
    return this.tabs.filter((t) => t.spaceId === spaceId)
  }

  partitionFor(space: Space): string {
    return space.profile === 'separate' ? spacePartition(space.id) : TAB_PARTITION
  }

  // ---- tabs ----

  createTab(url?: string, opts: { activate?: boolean; index?: number; spaceId?: string } = {}): Tab {
    const space = this.spaceById(opts.spaceId ?? this.activeSpaceId) ?? this.activeSpace
    const target = url || internalPageUrl('start')
    const tab = new Tab(target, this.partitionFor(space))
    tab.spaceId = space.id
    let index = opts.index
    if (index === undefined) {
      const spaceTabs = this.tabsIn(space.id)
      index = spaceTabs.length
        ? this.tabs.indexOf(spaceTabs[spaceTabs.length - 1]) + 1
        : this.tabs.length
    }
    this.tabs.splice(index, 0, tab)
    this.host.win.contentView.addChildView(tab.view)
    tab.view.setVisible(false)
    this.wireTab(tab)
    if (tab.partition === TAB_PARTITION) {
      try {
        extensionsRef.current?.addTab(tab.wc, this.host.win)
      } catch (err) {
        console.warn('[extensions] addTab failed:', err)
      }
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
    if (tab.spaceId !== this.activeSpaceId) this.activeSpaceId = tab.spaceId
    const space = this.spaceById(tab.spaceId)
    if (space) space.lastActiveTabId = id
    if (this.splitPair && !this.inSplit(id)) this.splitPair = null
    for (const t of this.tabs) {
      t.view.setVisible((t.id === id || this.inSplit(t.id)) && !this.host.isOverlayOpen())
    }
    this.layout()
    if (tab.partition === TAB_PARTITION) {
      try {
        extensionsRef.current?.selectTab(tab.wc)
      } catch {
        /* extension system optional */
      }
    }
    if (!this.host.isOverlayOpen()) tab.wc.focus()
    // Arc-style mini-player: video keeps playing in a floating PiP window
    if (prev && prev.id !== id) this.maybeEnterPip(prev)
    if (this.pipTabId === id) this.exitPip(tab)
    this.pushState()
  }

  closeTab(id: number): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return
    const [tab] = this.tabs.splice(idx, 1)
    this.clearSplitIf(tab.id)
    if (this.pipTabId === tab.id) this.pipTabId = null
    const url = tab.wc.getURL()
    if (url && !isInternalUrl(url)) this.closedTabs.push({ url, spaceId: tab.spaceId })
    const closedSpaceId = tab.spaceId
    if (this.activeTabId === id) {
      this.activeTabId = -1
      const spaceTabs = this.tabsIn(closedSpaceId)
      // nearest neighbor within the same space
      const following = spaceTabs.find((t) => this.tabs.indexOf(t) >= idx)
      const next = following ?? spaceTabs[spaceTabs.length - 1]
      if (next) this.activateTab(next.id)
    }
    this.host.win.contentView.removeChildView(tab.view)
    adblock.dropTab(id)
    tab.wc.close()
    // Zero tabs is a real state: the chrome shows the home screen with a
    // centered search bar. The window only closes when the human closes it.
    if (this.tabs.length === 0 || this.tabsIn(closedSpaceId).length === 0) {
      this.host.win.webContents.focus()
    }
    this.pushState()
    this.host.onTabsChanged()
  }

  /** Remove a tab's view without close-bookkeeping (space rebuilds, moves). */
  private detachTab(tab: Tab): void {
    this.clearSplitIf(tab.id)
    const idx = this.tabs.indexOf(tab)
    if (idx !== -1) this.tabs.splice(idx, 1)
    if (this.pipTabId === tab.id) this.pipTabId = null
    if (this.activeTabId === tab.id) this.activeTabId = -1
    try {
      this.host.win.contentView.removeChildView(tab.view)
    } catch {
      /* view already detached */
    }
    adblock.dropTab(tab.id)
    tab.wc.close()
  }

  reopenClosedTab(): void {
    const entry = this.closedTabs.pop()
    if (!entry) return
    if (this.spaceById(entry.spaceId)) this.createTab(entry.url, { spaceId: entry.spaceId })
    else this.createTab(entry.url)
  }

  /** Reorder a subset of tabs (one space's list) without disturbing the rest. */
  reorder(ids: number[]): void {
    const moving = new Set(ids)
    const queue = ids.map((id) => this.byId(id)).filter((t): t is Tab => !!t)
    this.tabs = this.tabs.map((t) => (moving.has(t.id) ? queue.shift()! : t))
    this.pushState()
    this.host.onTabsChanged()
  }

  duplicateTab(id: number): void {
    const tab = this.byId(id)
    if (!tab) return
    const url = tab.wc.getURL()
    if (!url) return
    this.createTab(url, { index: this.tabs.indexOf(tab) + 1, spaceId: tab.spaceId })
  }

  closeOtherTabs(id: number): void {
    const keep = this.byId(id)
    if (!keep) return
    for (const t of this.tabsIn(keep.spaceId)) {
      if (t.id !== id) this.closeTab(t.id)
    }
  }

  navigate(id: number | null, input: string): void {
    const tab = id == null ? this.activeTab : this.byId(id)
    const url = resolveOmniboxInput(input, settingsStore.get())
    if (!tab) {
      // zero-tab home screen: typing conjures the first tab
      this.createTab(url)
      return
    }
    tab.loadError = undefined
    tab.setBackgroundForUrl(url)
    void tab.wc.loadURL(url).catch(() => {})
    tab.wc.focus()
  }

  // ---- spaces ----

  createSpace(name?: string, profile: SpaceProfile = 'shared'): Space {
    const space: Space = {
      id: genId(),
      name: name || `Space ${this.spaces.length + 1}`,
      profile,
      createdAt: Date.now(),
      lastActiveTabId: -1
    }
    this.spaces.push(space)
    this.createTab(undefined, { spaceId: space.id })
    this.pushState()
    this.host.onTabsChanged()
    return space
  }

  activateSpace(id: string): void {
    const space = this.spaceById(id)
    if (!space || id === this.activeSpaceId) return
    this.activeSpaceId = id
    const target = this.byId(space.lastActiveTabId) ?? this.tabsIn(id)[0]
    if (target) this.activateTab(target.id)
    else this.createTab(undefined, { spaceId: id })
    this.pushState()
    this.host.onTabsChanged()
  }

  cycleSpace(dir: 1 | -1): void {
    if (this.spaces.length < 2) return
    const idx = this.spaces.findIndex((s) => s.id === this.activeSpaceId)
    const next = this.spaces[(idx + dir + this.spaces.length) % this.spaces.length]
    this.activateSpace(next.id)
  }

  renameSpace(id: string, name: string): void {
    const space = this.spaceById(id)
    if (!space || !name.trim()) return
    space.name = name.trim()
    this.pushState()
    this.host.onTabsChanged()
  }

  setSpaceAccent(id: string, accent: AccentId | null): void {
    const space = this.spaceById(id)
    if (!space) return
    space.accent = accent ?? undefined
    this.pushState()
    this.host.onTabsChanged()
  }

  /** Flip a space between the shared profile and its own cookie jar (reloads its tabs). */
  setSpaceProfile(id: string, profile: SpaceProfile): void {
    const space = this.spaceById(id)
    if (!space || space.profile === profile) return
    const old = this.tabsIn(id)
    const urls = old.map((t) => t.wc.getURL() || internalPageUrl('start'))
    const activeIdx = Math.max(0, old.findIndex((t) => t.id === space.lastActiveTabId))
    const wasActiveSpace = this.activeSpaceId === id
    space.profile = profile
    for (const t of old) this.detachTab(t)
    urls.forEach((u, i) => {
      const tab = this.createTab(remapInternal(u), {
        spaceId: id,
        activate: wasActiveSpace && i === activeIdx
      })
      if (i === activeIdx) space.lastActiveTabId = tab.id
    })
    this.pushState()
    this.host.onTabsChanged()
  }

  deleteSpace(id: string): void {
    if (this.spaces.length < 2) return
    const idx = this.spaces.findIndex((s) => s.id === id)
    if (idx === -1) return
    const wasActive = this.activeSpaceId === id
    for (const t of this.tabsIn(id)) {
      const url = t.wc.getURL()
      if (url && !isInternalUrl(url)) this.closedTabs.push({ url, spaceId: id })
      this.detachTab(t)
    }
    this.spaces.splice(idx, 1)
    if (wasActive) {
      const neighbor = this.spaces[Math.min(idx, this.spaces.length - 1)]
      this.activeSpaceId = neighbor.id
      const target = this.byId(neighbor.lastActiveTabId) ?? this.tabsIn(neighbor.id)[0]
      if (target) this.activateTab(target.id)
      else this.createTab(undefined, { spaceId: neighbor.id })
    }
    this.pushState()
    this.host.onTabsChanged()
  }

  moveTabToSpace(tabId: number, spaceId: string, index?: number): void {
    const tab = this.byId(tabId)
    const target = this.spaceById(spaceId)
    if (!tab || !target || tab.spaceId === spaceId) return
    const source = this.spaceById(tab.spaceId)
    const sameSession = this.partitionFor(target) === tab.partition
    if (sameSession) {
      const wasActive = this.activeTabId === tabId
      // pick a replacement in the source space before relocating
      if (wasActive && source) {
        const remaining = this.tabsIn(source.id).filter((t) => t.id !== tabId)
        this.activeTabId = -1
        if (remaining.length) this.activateTab(remaining[0].id)
      }
      const at = this.tabs.indexOf(tab)
      this.tabs.splice(at, 1)
      const targetTabs = this.tabsIn(spaceId)
      const insertAt =
        index !== undefined && targetTabs[index]
          ? this.tabs.indexOf(targetTabs[index])
          : targetTabs.length
            ? this.tabs.indexOf(targetTabs[targetTabs.length - 1]) + 1
            : this.tabs.length
      this.tabs.splice(insertAt, 0, tab)
      tab.spaceId = spaceId
      target.lastActiveTabId = tabId
    } else {
      // Different cookie jar: the page must reload under the target session
      const url = tab.wc.getURL() || internalPageUrl('start')
      this.detachTab(tab)
      const fresh = this.createTab(remapInternal(url), { spaceId, activate: false })
      target.lastActiveTabId = fresh.id
    }
    if (source && this.tabsIn(source.id).length === 0) {
      this.createTab(undefined, { spaceId: source.id, activate: source.id === this.activeSpaceId })
    }
    this.pushState()
    this.host.onTabsChanged()
  }

  // ---- mini-player ----

  private maybeEnterPip(tab: Tab): void {
    if (!settingsStore.get().autoPip) return
    if (!/^https?:/.test(tab.wc.getURL())) return
    // The probe decides playability itself — isCurrentlyAudible() misses muted
    // players, and the eval cost on tab switch is negligible.
    const ENTER = `(() => {
      if (location.hostname.endsWith('youtube.com') && location.pathname.startsWith('/shorts')) return false
      const vw = Math.max(1, window.innerWidth), vh = Math.max(1, window.innerHeight)
      const cands = [...document.querySelectorAll('video')].filter(v => {
        if (v.paused || v.ended || v.readyState <= 2 || v.disablePictureInPicture) return false
        const r = v.getBoundingClientRect()
        if (r.width < 320 || r.height < 180) return false
        if (v.muted) {
          if (v.loop) return false
          const cover = (r.width * r.height) / (vw * vh)
          if (cover < 0.5) return false
        }
        return true
      })
      cands.sort((a, b) => {
        if (a.muted !== b.muted) return a.muted ? 1 : -1
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return rb.width * rb.height - ra.width * ra.height
      })
      const v = cands[0]
      if (v && document.pictureInPictureEnabled && !document.pictureInPictureElement) {
        v.requestPictureInPicture().catch(() => {})
        return true
      }
      return false
    })()`
    tab.wc
      .executeJavaScript(ENTER, true)
      .then((entered) => {
        if (!entered) return
        // User may have already switched back while the promise settled
        if (this.activeTabId === tab.id) this.exitPip(tab)
        else this.pipTabId = tab.id
      })
      .catch(() => {})
  }

  private exitPip(tab?: Tab): void {
    this.pipTabId = null
    if (!tab) return
    const EXIT = `if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})`
    void tab.wc.executeJavaScript(EXIT, true).catch(() => {})
  }

  // ---- layout / state ----

  layout(): void {
    const active = this.activeTab
    if (!active) return
    const bounds = this.host.isContentFullscreen() ? this.host.fullBounds() : this.host.contentBounds()
    const pair = this.splitTabs()
    if (pair && !this.host.isContentFullscreen()) {
      const gap = 8
      const half = Math.max(0, Math.round((bounds.width - gap) / 2))
      const [left, right] = pair
      left.view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: half,
        height: Math.max(0, Math.round(bounds.height))
      })
      right.view.setBounds({
        x: Math.round(bounds.x) + half + gap,
        y: Math.round(bounds.y),
        width: Math.max(0, Math.round(bounds.width) - half - gap),
        height: Math.max(0, Math.round(bounds.height))
      })
      return
    }
    active.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    })
  }

  /** The split tabs in visual order (by tab-strip index), or null if not splitting. */
  private splitTabs(): [Tab, Tab] | null {
    if (!this.splitPair) return null
    const a = this.byId(this.splitPair[0])
    const b = this.byId(this.splitPair[1])
    if (!a || !b || a.spaceId !== b.spaceId) return null
    return this.tabs.indexOf(a) <= this.tabs.indexOf(b) ? [a, b] : [b, a]
  }

  private inSplit(id: number): boolean {
    return this.splitPair !== null && (this.splitPair[0] === id || this.splitPair[1] === id)
  }

  private clearSplitIf(id: number): void {
    if (this.inSplit(id)) this.splitPair = null
  }

  /** Toggle a 50/50 split of the active tab with its neighbour (creating one if alone). */
  toggleSplit(): void {
    if (this.splitPair) {
      this.splitPair = null
      this.activateTab(this.activeTabId)
      return
    }
    const active = this.activeTab
    if (!active) return
    const spaceTabs = this.tabsIn(active.spaceId)
    let partner = spaceTabs[(spaceTabs.indexOf(active) + 1) % spaceTabs.length]
    if (!partner || partner.id === active.id) {
      partner = this.createTab(undefined, { spaceId: active.spaceId, activate: false })
    }
    this.splitPair = [active.id, partner.id]
    // Re-assert activation: the extensions layer activates a freshly created
    // tab mid-createTab (before the pair exists), hiding the original half.
    this.activateTab(active.id)
  }

  setActiveVisible(visible: boolean): void {
    this.activeTab?.view.setVisible(visible)
    const pair = this.splitTabs()
    if (pair) for (const t of pair) t.view.setVisible(visible)
    if (visible) this.layout()
  }

  /** Re-apply theme-dependent backdrop colors (on theme change). */
  refreshBackgrounds(): void {
    for (const t of this.tabs) t.setBackgroundForUrl(t.wc.getURL() || '')
  }

  private serializeUrl(tab: Tab): string {
    const u = tab.wc.getURL()
    if (!u) return 'offshore://start'
    const errorTarget = errorPageTarget(u)
    if (errorTarget) return errorTarget
    return isInternalUrl(u) ? toDisplayUrl(u) : u
  }

  serializeWindow(): SessionWindowV2 {
    const spaces: SessionSpaceV2[] = this.spaces.map((sp) => {
      const tabs = this.tabsIn(sp.id)
      const activeTabIndex = Math.max(
        0,
        tabs.findIndex((t) => t.id === sp.lastActiveTabId)
      )
      return {
        id: sp.id,
        name: sp.name,
        accent: sp.accent,
        profile: sp.profile,
        tabs: (tabs.length ? tabs.map((t) => ({ url: this.serializeUrl(t) })) : [{ url: 'offshore://start' }]),
        activeTabIndex
      }
    })
    return { spaces, activeSpaceId: this.activeSpaceId }
  }

  /** Rebuild spaces + tabs from a saved session. Call before any tab exists. */
  restoreFromSession(sw: SessionWindowV2): void {
    const restored = (sw.spaces ?? []).filter((s) => s && Array.isArray(s.tabs))
    if (restored.length) {
      this.spaces = restored.map((s) => ({
        id: s.id || genId(),
        name: s.name || 'Main',
        accent: s.accent,
        profile: s.profile ?? 'shared',
        createdAt: Date.now(),
        lastActiveTabId: -1
      }))
      this.activeSpaceId = this.spaceById(sw.activeSpaceId)?.id ?? this.spaces[0].id
    }
    for (let i = 0; i < this.spaces.length; i++) {
      const space = this.spaces[i]
      const saved = restored[i]
      const urls = saved?.tabs.map((t) => t.url).filter(Boolean) ?? []
      const activeIdx = Math.min(Math.max(0, saved?.activeTabIndex ?? 0), Math.max(0, urls.length - 1))
      urls.forEach((u, j) => {
        const tab = this.createTab(remapInternal(u), { activate: false, spaceId: space.id })
        if (j === activeIdx) space.lastActiveTabId = tab.id
      })
      if (this.tabsIn(space.id).length === 0) {
        const tab = this.createTab(undefined, { activate: false, spaceId: space.id })
        space.lastActiveTabId = tab.id
      }
    }
    const active = this.activeSpace
    const target = this.byId(active.lastActiveTabId) ?? this.tabsIn(active.id)[0]
    if (target) this.activateTab(target.id)
  }

  state(): TabsState {
    const spaces: SpaceInfo[] = this.spaces.map((s) => ({
      id: s.id,
      name: s.name,
      accent: s.accent,
      profile: s.profile
    }))
    return {
      tabs: this.tabs.map((t) => t.info()),
      activeTabId: this.activeTabId,
      spaces,
      activeSpaceId: this.activeSpaceId,
      splitPair: this.splitPair
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
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
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

  // ---- wiring ----

  private wireTab(tab: Tab): void {
    const wc = tab.wc

    registerPageContents(wc, {
      kind: 'tab',
      ownerWindow: this.host as unknown as OffshoreWindow,
      partition: tab.partition
    })

    wc.setVisualZoomLevelLimits(1, 3).catch(() => {})

    wc.on('page-title-updated', (_e, title) => {
      if (settingsStore.get().keepHistory) historyStore.setTitle(wc.getURL(), title)
      this.pushState()
    })

    wc.on('page-favicon-updated', (_e, favicons) => {
      // internal pages wear their own glyphs — a dev-server /favicon.ico 404
      // here would render as Chromium's broken-image box in the tab strip
      if (isInternalUrl(wc.getURL())) return
      tab.favicon = favicons[favicons.length - 1]
      // keep saved bookmarks showing the site's current icon
      bookmarksStore.setFavicon(wc.getURL(), tab.favicon)
      this.pushState()
    })

    wc.on('did-start-loading', () => this.pushState())
    wc.on('did-stop-loading', () => this.pushState())

    wc.on('did-navigate', (_e, url) => {
      tab.loadError = undefined
      tab.slopScore = undefined
      tab.favicon = undefined
      if (this.pipTabId === tab.id) this.pipTabId = null
      adblock.resetCount(tab.id)
      tab.setBackgroundForUrl(url)
      if (!isInternalUrl(url) && settingsStore.get().keepHistory) historyStore.record(url)
      this.pushState()
      this.host.onTabsChanged()
    })

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        if (!isInternalUrl(url) && settingsStore.get().keepHistory) historyStore.record(url)
        this.pushState()
      }
    })

    wc.on('focus', () => {
      if (this.inSplit(tab.id) && this.activeTabId !== tab.id) {
        this.activeTabId = tab.id
        const space = this.spaceById(tab.spaceId)
        if (space) space.lastActiveTabId = tab.id
        this.pushState()
      }
    })

    wc.on('dom-ready', () => {
      maybeAutofill(wc, tab.partition)
    })

    // Internal pages never load in subframes (privileged bridge lives there)
    wc.on('will-frame-navigate', (ev) => {
      if (!ev.isMainFrame && isInternalUrl(ev.url)) ev.preventDefault()
    })

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || errorCode === 0) return
      tab.loadError = errorDescription
      const failed = validatedURL || wc.getURL()
      if (failed && !errorPageTarget(failed) && !isInternalUrl(failed)) {
        void wc.loadURL(errorPageUrl(failed, errorCode, errorDescription)).catch(() => {})
      }
      this.pushState()
    })

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      tab.loadError = `Page crashed (${details.reason})`
      const current = wc.getURL()
      if (current && !isInternalUrl(current)) {
        void wc.loadURL(errorPageUrl(current, 0, `crash:${details.reason}`)).catch(() => {})
      }
      this.pushState()
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

    wc.on('context-menu', (_e, params) => {
      this.showContextMenu(tab, params)
    })

    this.installWindowOpenPolicy(wc, tab)
  }

  /** Popup policy shared by tabs and (recursively) the popups they open. */
  private installWindowOpenPolicy(wc: WebContents, openerTab: Tab | null): void {
    wc.setWindowOpenHandler((details) => {
      if (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') {
        const anchor = openerTab ?? this.activeTab
        const idx = anchor ? this.tabs.indexOf(anchor) : this.tabs.length - 1
        this.createTab(details.url, {
          activate: details.disposition === 'foreground-tab',
          index: idx + 1,
          spaceId: anchor?.spaceId
        })
        return { action: 'deny' }
      }
      if (popupDecision(wc, details.url) === 'block') {
        recordBlocked(wc, details.url)
        return { action: 'deny' }
      }
      // Real popup (window.open with features) — OAuth flows and friends
      const partition = openerTab?.partition ?? TAB_PARTITION
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            session: prepareTabSession(partition),
            preload: join(__dirname, '../preload/internal.js'),
            sandbox: true,
            contextIsolation: true,
            additionalArguments: devOriginArgs()
          }
        }
      }
    })

    wc.on('did-create-window', (win) => {
      const partition = openerTab?.partition ?? TAB_PARTITION
      const pwc = win.webContents
      registerPageContents(pwc, {
        kind: 'popup',
        ownerWindow: this.host as unknown as OffshoreWindow,
        partition
      })
      pwc.on('will-frame-navigate', (ev) => {
        if (isInternalUrl(ev.url)) ev.preventDefault()
      })
      pwc.on('dom-ready', () => maybeAutofill(pwc, partition))
      this.installWindowOpenPolicy(pwc, openerTab)
    })
  }

  /** Open a previously blocked popup as a real (hardened) popup window. */
  openBlockedPopup(tabId: number, url: string): void {
    const tab = this.byId(tabId)
    if (!tab || !/^https?:/i.test(url)) return
    void tab.wc.executeJavaScript(
      `window.open(${JSON.stringify(url)}, '_blank', 'width=980,height=720,popup')`,
      true // user gesture: the human clicked "open" in the chrome
    ).catch(() => {})
  }

  private showContextMenu(tab: Tab, params: Electron.ContextMenuParams): void {
    const wc = tab.wc
    const menu = new Menu()
    const add = (opts: Electron.MenuItemConstructorOptions): void => {
      menu.append(new MenuItem(opts))
    }

    // The new-tab page is widget-based — offer its controls right here
    if (toDisplayUrl(wc.getURL()) === 'offshore://start') {
      add({
        label: 'Edit Widgets…',
        click: () => wc.send('widgets:edit')
      })
      add({ type: 'separator' })
    }

    if (params.linkURL) {
      const idx = this.tabs.findIndex((t) => t.id === tab.id)
      add({
        label: 'Open Link in New Tab',
        click: () => this.createTab(params.linkURL, { index: idx + 1, spaceId: tab.spaceId })
      })
      add({
        label: 'Open Link in Background',
        click: () => this.createTab(params.linkURL, { activate: false, index: idx + 1, spaceId: tab.spaceId })
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
      add({ label: 'Back', enabled: tab.info().canGoBack, click: () => this.goBack(tab.id) })
      add({
        label: 'Forward',
        enabled: tab.info().canGoForward,
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
