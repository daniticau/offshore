import type {
  ActionId,
  BlockedPopup,
  BookmarkNode,
  BriefWeather,
  DevToolsDock,
  DownloadEntry,
  ExtensionInfo,
  GeocodeResult,
  Insets,
  PasswordMeta,
  PasswordsStatus,
  Settings,
  SpaceProfile,
  Suggestion,
  TabsState
} from './types'

/**
 * The two contextBridge surfaces, declared once for both sides of the wall.
 *
 * The preloads type their exposed objects with these interfaces and the
 * renderer reads the bridges through them, so a method that drifts — renamed,
 * re-signatured, removed on one side only — is a compile error rather than an
 * undefined-is-not-a-function at runtime. `src/shared` is the only directory
 * both tsconfig projects can see, which is what makes this the meeting point.
 */

/** Channels the chrome UI may subscribe to via offshore.on(). */
export const CHROME_EVENTS = [
  'tabs:state',
  'settings:changed',
  'bookmarks:changed',
  'omnibox:focus',
  'find:open',
  'find:result',
  'downloads:event',
  'devshot:composite',
  'chrome:page-freeze',
  'spaces:begin-rename',
  'bookmarks:begin-rename',
  'bookmarks:edit-current',
  'chrome:toggle-hidden',
  'passwords:offer',
  'widgets:edit',
  'newtab:request'
] as const

export type ChromeEvent = (typeof CHROME_EVENTS)[number]

/** window.offshore — the chrome UI's bridge. */
export interface OffshoreApi {
  tabs: {
    create(url?: string): Promise<number | undefined>
    close(id: number): Promise<void>
    activate(id: number): Promise<void>
    navigate(id: number | null, input: string): Promise<void>
    back(id?: number): Promise<void>
    forward(id?: number): Promise<void>
    reload(id?: number, force?: boolean): Promise<void>
    stop(id?: number): Promise<void>
    reorder(ids: number[]): Promise<void>
    toggleSplit(): Promise<void>
    splitWith(tabId: number): Promise<void>
    unsplit(): Promise<void>
    devtools(): Promise<void>
    devtoolsDock(dock: DevToolsDock): Promise<void>
    mute(id: number, muted: boolean): Promise<void>
    getState(): Promise<TabsState | undefined>
  }
  spaces: {
    create(name?: string): Promise<string | undefined>
    activate(id: string): Promise<void>
    rename(id: string, name: string): Promise<void>
    setAccent(id: string, accent: string | null): Promise<void>
    moveTab(tabId: number, spaceId: string): Promise<void>
    setProfile(id: string, profile: SpaceProfile): Promise<void>
    remove(id: string): Promise<void>
  }
  menu: {
    homeContext(): Promise<void>
    tabContext(tabId: number): Promise<void>
    spaceContext(spaceId: string): Promise<void>
    bookmarkContext(nodeId: string): Promise<void>
  }
  omnibox: { suggest(input: string): Promise<Suggestion[]> }
  home: { setSearch(open: boolean, tabId?: number): Promise<void> }
  actions: { run(id: ActionId): Promise<void> }
  chrome: {
    setInsets(insets: Insets): Promise<void>
    setOverlay(open: boolean): Promise<void>
    setCollapsed(collapsed: boolean): Promise<void>
    freezeAck(): void
    focusPage(): Promise<void>
    copyText(text: string): Promise<void>
  }
  privacy: { clearSite(): Promise<boolean> }
  brief: { weather(): Promise<BriefWeather | null> }
  find: {
    start(text: string, opts: { findNext: boolean; forward: boolean }): Promise<void>
    stop(): Promise<void>
  }
  bookmarks: {
    list(): Promise<BookmarkNode[]>
    toggle(url: string, title: string, favicon?: string): Promise<boolean>
    addFolder(title: string, parentId: string | null): Promise<BookmarkNode | null>
    update(id: string, patch: { title?: string; url?: string }): Promise<void>
    move(id: string, parentId: string | null, index: number): Promise<void>
    remove(id: string): Promise<void>
    setLastFolder(id: string | null): Promise<void>
  }
  passwords: {
    resolveOffer(offerId: string, action: 'save' | 'never' | 'dismiss'): Promise<void>
  }
  popups: {
    getBlocked(tabId: number): Promise<BlockedPopup[]>
    open(tabId: number, url: string): Promise<void>
    allowSite(tabId: number): Promise<void>
  }
  slop: {
    /** Lift a standing veil on this tab — the reader wants the page anyway. */
    readAnyway(tabId: number): Promise<void>
    /** Put this tab's site on (or take it off) the never-veil list. */
    setAllowed(tabId: number, allowed: boolean): Promise<void>
  }
  extensions: { has(): Promise<boolean> }
  downloads: {
    list(): Promise<DownloadEntry[]>
    clear(): Promise<void>
    open(id: string): Promise<void>
    reveal(id: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  adblock: { toggleSite(url: string): Promise<boolean> }
  focus: {
    /** Flip Focus for the active tab's site — strip + compact on, restore off. */
    toggle(): Promise<void>
  }
  window: {
    zoom(): Promise<void>
    close(): Promise<void>
    minimize(): Promise<void>
  }
  on(channel: ChromeEvent, cb: (...args: any[]) => void): () => void
  devshotDone(): void
}

/** window.offshoreInternal — the privileged bridge offshore:// pages get. */
export interface OffshoreInternalApi {
  settings: {
    get(): Promise<Settings | null>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  bookmarks: {
    list(): Promise<BookmarkNode[]>
    addFolder(title: string, parentId: string | null): Promise<BookmarkNode | null>
    update(id: string, patch: { title?: string; url?: string }): Promise<void>
    remove(id: string): Promise<void>
  }
  extensions: {
    list(): Promise<ExtensionInfo[]>
    uninstall(id: string): Promise<void>
  }
  passwords: {
    status(): Promise<PasswordsStatus>
    list(): Promise<PasswordMeta[]>
    reveal(id: string): Promise<string | null>
    copy(id: string): Promise<boolean>
    delete(id: string): Promise<void>
    neverList(): Promise<string[]>
    removeNever(origin: string): Promise<void>
  }
  brief: {
    weather(): Promise<BriefWeather | null>
    geocode(q: string): Promise<GeocodeResult[]>
  }
  history: { clear(): Promise<void> }
  focus: {
    /** Hosts Focus is currently on for, sorted. */
    sites(): Promise<string[]>
    forget(host: string): Promise<void>
    forgetAll(): Promise<void>
  }
  privacy: { clearSiteData(): Promise<void> }
  app: { info(): Promise<{ version: string } | null> }
  open(url: string): Promise<void>
  /** Fires when the chrome asks the new-tab page to enter widget edit mode. */
  onEditWidgets(cb: () => void): void
  home: {
    setSearch(open: boolean): Promise<void>
    onSearch(cb: (open: boolean) => void): void
    /** The home screen has genuinely painted — swap gates wait on this. */
    painted(): void
    /** What the omnibox would offer for the same half-typed word. */
    suggest(input: string): Promise<Suggestion[]>
  }
}
