import type {
  DownloadEntry,
  ActionId,
  BlockedPopup,
  BookmarkNode,
  BriefWeather,
  DevToolsDock,
  FindResult,
  PageFreezeFrame,
  PasswordOffer,
  Settings,
  SpaceInfo,
  SpaceProfile,
  Suggestion,
  TabsState
} from '@shared/types'

export interface Insets {
  top: number
  left: number
  right: number
  bottom: number
}

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
  privacy: {
    clearSite(): Promise<boolean>
  }
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
  app: { info(): Promise<{ version: string } | null> }
  window: { zoom(): Promise<void> }
  on(channel: string, cb: (...args: never[]) => void): () => void
  devshotDone(): void
}

export const offshore = (window as unknown as { offshore: OffshoreApi }).offshore

export function prettyHost(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'offshore:') return url.replace(/\/$/, '')
    return u.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export type {
  TabsState,
  Settings,
  Suggestion,
  BookmarkNode,
  SpaceInfo,
  SpaceProfile,
  DevToolsDock,
  PageFreezeFrame,
  FindResult,
  PasswordOffer,
  BlockedPopup
}
