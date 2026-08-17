import { app } from 'electron'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import {
  DEFAULT_SETTINGS,
  type BookmarkNode,
  type SessionV2,
  type SessionWindowV2,
  type Settings,
  type ShieldStats,
  type Suggestion
} from '@shared/types'

export function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

interface JsonFileOpts<T> {
  /** Custom merge of parsed disk data over the fallback (default: shallow spread) */
  migrate?: (parsed: unknown, fallback: T) => T
  /** File permission bits (e.g. 0o600 for secrets) */
  mode?: number
}

export class JsonFile<T> {
  private path: string
  private saveTimer: NodeJS.Timeout | null = null
  private mode?: number
  data: T

  constructor(filename: string, fallback: T, opts?: JsonFileOpts<T>) {
    this.path = join(app.getPath('userData'), filename)
    this.mode = opts?.mode
    this.data = fallback
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, 'utf-8'))
        this.data = opts?.migrate ? opts.migrate(parsed, fallback) : { ...fallback, ...parsed }
      }
    } catch (err) {
      console.warn(`[stores] failed to read ${filename}:`, err)
    }
  }

  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), 400)
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: this.mode })
    } catch (err) {
      console.warn('[stores] failed to save:', err)
    }
  }
}

// ---------------- Settings ----------------

/** Deep-merge for the nested settings objects so new keys reach existing profiles. */
function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    adblock: {
      ...base.adblock,
      ...(patch.adblock ?? {}),
      lists: { ...base.adblock.lists, ...(patch.adblock?.lists ?? {}) }
    },
    appearance: { ...base.appearance, ...(patch.appearance ?? {}) },
    newTabWidgets: { ...base.newTabWidgets, ...(patch.newTabWidgets ?? {}) },
    newTabWidgetLayout: { ...base.newTabWidgetLayout, ...(patch.newTabWidgetLayout ?? {}) },
    popups: { ...base.popups, ...(patch.popups ?? {}) },
    privacy: ((): Settings['privacy'] => {
      const merged = { ...base.privacy, ...(patch.privacy ?? {}) }
      if (![14, 30, 60, 90].includes(merged.tideDays)) merged.tideDays = 30
      return merged
    })(),
    passwords: { ...base.passwords, ...(patch.passwords ?? {}) },
    brief: { ...base.brief, ...(patch.brief ?? {}) },
    morning: { ...base.morning, ...(patch.morning ?? {}) },
    slop: { ...base.slop, ...(patch.slop ?? {}) },
    focus: { ...base.focus, ...(patch.focus ?? {}) }
  }
}

class SettingsStore extends EventEmitter {
  private file = new JsonFile<Settings>('settings.json', DEFAULT_SETTINGS, {
    migrate: (parsed, fallback) => {
      const merged = mergeSettings(fallback, parsed as Partial<Settings>)
      // the detector's switch used to be a flat boolean; keep an old "off"
      const legacy = (parsed as { slopDetector?: unknown })?.slopDetector
      if (legacy === false && (parsed as { slop?: unknown })?.slop === undefined) {
        merged.slop = { ...merged.slop, detector: false }
      }
      // the Page Cleaner's master switch becomes Focus's: keep an old "off"
      const cleaner = (parsed as { cleaner?: { enabled?: unknown } })?.cleaner
      if (cleaner?.enabled === false && (parsed as { focus?: unknown })?.focus === undefined) {
        merged.focus = { ...merged.focus, enabled: false }
      }
      // veil-era shape: carry the never-veil list over as the quiet list, drop
      // the rest (rebuilding from known keys is the scrub — `veil` and
      // `allowlist` cannot survive it)
      const oldSlop = (parsed as { slop?: { quiet?: unknown; allowlist?: unknown } })?.slop
      const hosts = (list: unknown): string[] =>
        Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string') : []
      merged.slop = {
        detector: merged.slop.detector,
        highlight: merged.slop.highlight,
        quiet: Array.isArray(oldSlop?.quiet) ? hosts(oldSlop.quiet) : hosts(oldSlop?.allowlist)
      }
      return merged
    }
  })

  get(): Settings {
    return this.file.data
  }

  set(patch: Partial<Settings>): Settings {
    const prev = this.file.data
    this.file.data = mergeSettings(prev, patch)
    this.file.save()
    this.emit('changed', this.file.data, prev)
    return this.file.data
  }

  /** ⌘⇧B / the palette: flip between sidebar and top-bar tabs. */
  toggleTabOrientation(): void {
    this.set({ tabOrientation: this.get().tabOrientation === 'vertical' ? 'horizontal' : 'vertical' })
  }

  flush(): void {
    this.file.saveNow()
  }
}

// ---------------- Bookmarks (v2: tree) ----------------

interface BookmarksFile {
  version: 2
  nodes: BookmarkNode[]
  lastFolderId: string | null
}

function migrateBookmarks(parsed: unknown, fallback: BookmarksFile): BookmarksFile {
  const p = parsed as Record<string, unknown>
  // v1 detection by key presence, not version (shallow merges can leave both)
  if (Array.isArray(p.items)) {
    const items = p.items as { id: string; title: string; url: string; createdAt: number }[]
    return {
      version: 2,
      nodes: items.map((b, i) => ({
        id: b.id ?? genId(),
        parentId: null,
        index: i,
        type: 'bookmark' as const,
        title: b.title,
        url: b.url,
        createdAt: b.createdAt ?? Date.now()
      })),
      lastFolderId: null
    }
  }
  return { ...fallback, ...(p as Partial<BookmarksFile>), version: 2 }
}

class BookmarksStore extends EventEmitter {
  private file = new JsonFile<BookmarksFile>(
    'bookmarks.json',
    { version: 2, nodes: [], lastFolderId: null },
    { migrate: migrateBookmarks }
  )

  constructor() {
    super()
    this.normalize()
  }

  /** Re-number sibling indexes 0..n per parent, keeping relative order. */
  private normalize(): void {
    const byParent = new Map<string | null, BookmarkNode[]>()
    for (const n of this.file.data.nodes) {
      const list = byParent.get(n.parentId) ?? []
      list.push(n)
      byParent.set(n.parentId, list)
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => a.index - b.index)
      list.forEach((n, i) => (n.index = i))
    }
  }

  private commit(): void {
    this.normalize()
    this.file.save()
    this.emit('changed')
  }

  list(): BookmarkNode[] {
    return this.file.data.nodes
  }

  byId(id: string): BookmarkNode | undefined {
    return this.file.data.nodes.find((n) => n.id === id)
  }

  isBookmarked(url: string): boolean {
    return this.file.data.nodes.some((n) => n.type === 'bookmark' && n.url === url)
  }

  get lastFolderId(): string | null {
    const id = this.file.data.lastFolderId
    return id && this.byId(id)?.type === 'folder' ? id : null
  }

  setLastFolder(id: string | null): void {
    this.file.data.lastFolderId = id
    this.file.save()
  }

  private siblingCount(parentId: string | null): number {
    return this.file.data.nodes.filter((n) => n.parentId === parentId).length
  }

  add(url: string, title: string, favicon?: string, parentId?: string | null): BookmarkNode {
    const existing = this.file.data.nodes.find((n) => n.type === 'bookmark' && n.url === url)
    if (existing) {
      if (favicon && existing.favicon !== favicon) {
        existing.favicon = favicon
        this.commit()
      }
      return existing
    }
    const parent = parentId === undefined ? this.lastFolderId : parentId
    const bm: BookmarkNode = {
      id: genId(),
      parentId: parent,
      index: this.siblingCount(parent),
      type: 'bookmark',
      title: title || url,
      url,
      favicon,
      createdAt: Date.now()
    }
    this.file.data.nodes.push(bm)
    this.commit()
    return bm
  }

  /** Refresh the stored icon for a bookmarked url; no-op if unbookmarked or unchanged. */
  setFavicon(url: string, favicon?: string): void {
    if (!favicon) return
    let touched = false
    for (const n of this.file.data.nodes) {
      if (n.type === 'bookmark' && n.url === url && n.favicon !== favicon) {
        n.favicon = favicon
        touched = true
      }
    }
    if (touched) this.commit()
  }

  createFolder(title: string, parentId: string | null = null): BookmarkNode {
    const folder: BookmarkNode = {
      id: genId(),
      parentId,
      index: this.siblingCount(parentId),
      type: 'folder',
      title: title || 'New Folder',
      createdAt: Date.now()
    }
    this.file.data.nodes.push(folder)
    this.commit()
    return folder
  }

  update(id: string, patch: { title?: string; url?: string }): void {
    const n = this.byId(id)
    if (!n) return
    if (patch.title !== undefined) n.title = patch.title
    if (patch.url !== undefined && n.type === 'bookmark') n.url = patch.url
    this.commit()
  }

  /** True if `candidate` is `ancestorId` or inside it. */
  private isDescendant(candidate: string | null, ancestorId: string): boolean {
    let cur = candidate
    while (cur) {
      if (cur === ancestorId) return true
      cur = this.byId(cur)?.parentId ?? null
    }
    return false
  }

  move(id: string, newParentId: string | null, index: number): void {
    const n = this.byId(id)
    if (!n) return
    if (newParentId && (this.byId(newParentId)?.type !== 'folder' || this.isDescendant(newParentId, id))) return
    const siblings = this.file.data.nodes
      .filter((s) => s.parentId === newParentId && s.id !== id)
      .sort((a, b) => a.index - b.index)
    n.parentId = newParentId
    siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, n)
    siblings.forEach((s, i) => (s.index = i))
    this.commit()
  }

  remove(id: string): void {
    const doomed = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const n of this.file.data.nodes) {
        if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
          doomed.add(n.id)
          grew = true
        }
      }
    }
    const before = this.file.data.nodes.length
    this.file.data.nodes = this.file.data.nodes.filter((n) => !doomed.has(n.id))
    if (this.file.data.nodes.length !== before) this.commit()
  }

  /** Toggle bookmark state for a url; returns new state. */
  toggle(url: string, title: string, favicon?: string): boolean {
    const existing = this.file.data.nodes.find((n) => n.type === 'bookmark' && n.url === url)
    if (existing) {
      this.remove(existing.id)
      return false
    }
    this.add(url, title, favicon)
    return true
  }

  search(query: string, limit: number): Suggestion[] {
    const q = query.toLowerCase()
    if (!q) return []
    const scored: { score: number; n: BookmarkNode }[] = []
    for (const n of this.file.data.nodes) {
      if (n.type !== 'bookmark' || !n.url) continue
      const title = n.title.toLowerCase()
      const url = n.url.toLowerCase()
      if (!title.includes(q) && !url.includes(q)) continue
      let score = 1
      if (title.startsWith(q)) score += 3
      if (url.replace(/^https?:\/\/(www\.)?/, '').startsWith(q)) score += 3
      scored.push({ score, n })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(({ n }) => ({
      kind: 'bookmark' as const,
      text: n.url!,
      url: n.url!,
      title: n.title,
      favicon: n.favicon
    }))
  }

  /** First few bookmarks in tree order — fills out the omnibox's opening list. */
  top(limit: number): Suggestion[] {
    const out: Suggestion[] = []
    for (const n of this.file.data.nodes) {
      if (n.type !== 'bookmark' || !n.url) continue
      out.push({ kind: 'bookmark', text: n.url, url: n.url, title: n.title, favicon: n.favicon })
      if (out.length === limit) break
    }
    return out
  }

  flush(): void {
    this.file.saveNow()
  }
}

// ---------------- History ----------------

export interface HistoryEntry {
  url: string
  title: string
  visitCount: number
  lastVisit: number
}

const HISTORY_CAP = 4000

class HistoryStore {
  private file = new JsonFile<{ entries: HistoryEntry[] }>('history.json', { entries: [] })
  private byUrl = new Map<string, HistoryEntry>()

  constructor() {
    for (const e of this.file.data.entries) this.byUrl.set(e.url, e)
  }

  record(url: string): void {
    if (!/^https?:\/\//.test(url)) return
    let e = this.byUrl.get(url)
    if (!e) {
      e = { url, title: '', visitCount: 0, lastVisit: 0 }
      this.byUrl.set(url, e)
      this.file.data.entries.push(e)
    }
    e.visitCount += 1
    e.lastVisit = Date.now()
    if (this.file.data.entries.length > HISTORY_CAP) {
      this.file.data.entries.sort((a, b) => b.lastVisit - a.lastVisit)
      const removed = this.file.data.entries.splice(HISTORY_CAP)
      for (const r of removed) this.byUrl.delete(r.url)
    }
    this.file.save()
  }

  setTitle(url: string, title: string): void {
    const e = this.byUrl.get(url)
    if (e && title) {
      e.title = title
      this.file.save()
    }
  }

  /** Read-only view for the morning brief's distiller. */
  entries(): ReadonlyArray<HistoryEntry> {
    return this.file.data.entries
  }

  /**
   * Test harness only: seed entries with explicit timestamps. Exists because
   * `record()` stamps `lastVisit = Date.now()` and the morning flow needs
   * entries that are days old.
   */
  inject(list: HistoryEntry[]): void {
    for (const e of list) {
      this.byUrl.set(e.url, e)
      this.file.data.entries.push(e)
    }
    this.file.save()
  }

  /** Frecency-ish search over history for omnibox suggestions. */
  search(query: string, limit: number): Suggestion[] {
    const q = query.toLowerCase()
    const now = Date.now()
    const scored: { score: number; e: HistoryEntry }[] = []
    for (const e of this.byUrl.values()) {
      const hay = `${e.url} ${e.title}`.toLowerCase()
      if (!hay.includes(q)) continue
      const recency = Math.max(0, 1 - (now - e.lastVisit) / (1000 * 60 * 60 * 24 * 30))
      const score = e.visitCount * 2 + recency * 10 + (e.url.toLowerCase().startsWith(`https://${q}`) ? 20 : 0)
      scored.push({ score, e })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(({ e }) => ({
      kind: 'history' as const,
      text: e.url,
      url: e.url,
      title: e.title
    }))
  }

  /**
   * The sites you actually go to, one row per host — what the omnibox shows the
   * moment it opens, before a single character is typed.
   */
  top(limit: number): Suggestion[] {
    const now = Date.now()
    const best = new Map<string, { score: number; e: HistoryEntry }>()
    for (const e of this.byUrl.values()) {
      let host: string
      try {
        host = new URL(e.url).host
      } catch {
        continue
      }
      const recency = Math.max(0, 1 - (now - e.lastVisit) / (1000 * 60 * 60 * 24 * 30))
      const score = e.visitCount * 2 + recency * 10
      const cur = best.get(host)
      if (!cur || score > cur.score) best.set(host, { score, e })
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ e }) => ({ kind: 'history' as const, text: e.url, url: e.url, title: e.title }))
  }

  clear(): void {
    this.byUrl.clear()
    this.file.data.entries = []
    this.file.saveNow()
  }

  flush(): void {
    this.file.saveNow()
  }
}

// ---------------- Downloads (recent list, Chrome-style) ----------------

interface StoredDownload {
  id: string
  filename: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
}

const DOWNLOADS_CAP = 50

class DownloadsStore {
  private file = new JsonFile<{ items: StoredDownload[] }>('downloads.json', { items: [] })

  constructor() {
    // anything still "progressing" from a previous run died with that run
    for (const d of this.file.data.items) {
      if (d.state === 'progressing') d.state = 'interrupted'
    }
  }

  add(item: StoredDownload): void {
    this.file.data.items.unshift(item)
    if (this.file.data.items.length > DOWNLOADS_CAP) {
      this.file.data.items.length = DOWNLOADS_CAP
    }
    this.file.save()
  }

  update(id: string, patch: Partial<StoredDownload>): void {
    const d = this.file.data.items.find((i) => i.id === id)
    if (!d) return
    Object.assign(d, patch)
    this.file.save()
  }

  pathOf(id: string): string | undefined {
    return this.file.data.items.find((i) => i.id === id)?.path
  }

  /** Renderer-safe view: paths never leave the main process. */
  list(): import('@shared/types').DownloadEntry[] {
    return this.file.data.items.map(({ id, filename, state, receivedBytes, totalBytes, startedAt }) => ({
      id,
      filename,
      state,
      receivedBytes,
      totalBytes,
      startedAt
    }))
  }

  clear(): void {
    this.file.data.items = []
    this.file.saveNow()
  }
}

export const downloadsStore = new DownloadsStore()

// ---------------- Shield lifetime stats ----------------

/**
 * The Shield's lifetime blocked counter. A trailing throttle, not JsonFile's
 * debounce — save() resets its timer on every call, so a stream of blocks
 * would postpone the write forever.
 */
class ShieldStatsStore {
  private file = new JsonFile<ShieldStats>('shield-stats.json', { blockedTotal: 0, since: Date.now() })
  private timer: NodeJS.Timeout | null = null

  get(): ShieldStats {
    return this.file.data
  }

  add(n: number): void {
    this.file.data = { ...this.file.data, blockedTotal: this.file.data.blockedTotal + n }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.file.saveNow()
      }, 2000)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.file.saveNow()
  }
}

// ---------------- Session (open windows/spaces/tabs) ----------------

type SessionFileShape = SessionV2 & { urls?: string[] }

function migrateSession(parsed: unknown, fallback: SessionFileShape): SessionFileShape {
  const p = parsed as Record<string, unknown>
  if (Array.isArray(p.urls)) {
    const urls = p.urls as string[]
    if (urls.length) {
      const spaceId = genId()
      return {
        version: 2,
        windows: [
          {
            spaces: [{ id: spaceId, name: 'Main', tabs: urls.map((url) => ({ url })), activeTabIndex: 0 }],
            activeSpaceId: spaceId
          }
        ]
      }
    }
    return { version: 2, windows: [] }
  }
  return { ...fallback, ...(p as Partial<SessionFileShape>), version: 2 }
}

class SessionStore {
  private file = new JsonFile<SessionFileShape>(
    'last-session.json',
    { version: 2, windows: [] },
    { migrate: migrateSession }
  )

  get(): SessionV2 {
    return { version: 2, windows: this.file.data.windows ?? [] }
  }

  set(windows: SessionWindowV2[]): void {
    this.file.data.windows = windows
    this.file.save()
  }

  flush(): void {
    this.file.saveNow()
  }
}

export const settingsStore = new SettingsStore()
export const bookmarksStore = new BookmarksStore()
export const historyStore = new HistoryStore()
export const sessionStore = new SessionStore()
export const shieldStatsStore = new ShieldStatsStore()

export function flushAllStores(): void {
  settingsStore.flush()
  bookmarksStore.flush()
  historyStore.flush()
  sessionStore.flush()
  shieldStatsStore.flush()
}
