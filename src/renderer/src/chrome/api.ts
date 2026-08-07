import type {
  Bookmark,
  FindResult,
  Settings,
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
    mute(id: number, muted: boolean): Promise<void>
    getState(): Promise<TabsState | undefined>
  }
  omnibox: { suggest(input: string): Promise<Suggestion[]> }
  chrome: {
    setInsets(insets: Insets): Promise<void>
    setOverlay(open: boolean): Promise<void>
  }
  find: {
    start(text: string, opts: { findNext: boolean; forward: boolean }): Promise<void>
    stop(): Promise<void>
  }
  bookmarks: {
    list(): Promise<Bookmark[]>
    toggle(url: string, title: string): Promise<boolean>
    remove(idOrUrl: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  adblock: { toggleSite(url: string): Promise<boolean> }
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

export type { TabsState, Settings, Suggestion, Bookmark, FindResult }
