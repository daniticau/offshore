import { app } from 'electron'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULT_SETTINGS, type Bookmark, type Settings, type Suggestion } from '@shared/types'

class JsonFile<T> {
  private path: string
  private saveTimer: NodeJS.Timeout | null = null
  data: T

  constructor(filename: string, fallback: T) {
    this.path = join(app.getPath('userData'), filename)
    this.data = fallback
    try {
      if (existsSync(this.path)) {
        this.data = { ...fallback, ...JSON.parse(readFileSync(this.path, 'utf-8')) }
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
      writeFileSync(this.path, JSON.stringify(this.data, null, 2))
    } catch (err) {
      console.warn('[stores] failed to save:', err)
    }
  }
}

// ---------------- Settings ----------------

class SettingsStore extends EventEmitter {
  private file = new JsonFile<Settings>('settings.json', DEFAULT_SETTINGS)

  get(): Settings {
    return this.file.data
  }

  set(patch: Partial<Settings>): Settings {
    const prev = this.file.data
    this.file.data = {
      ...prev,
      ...patch,
      adblock: { ...prev.adblock, ...(patch.adblock ?? {}) },
      appearance: { ...prev.appearance, ...(patch.appearance ?? {}) }
    }
    this.file.save()
    this.emit('changed', this.file.data, prev)
    return this.file.data
  }

  flush(): void {
    this.file.saveNow()
  }
}

// ---------------- Bookmarks ----------------

class BookmarksStore extends EventEmitter {
  private file = new JsonFile<{ items: Bookmark[] }>('bookmarks.json', { items: [] })

  list(): Bookmark[] {
    return this.file.data.items
  }

  isBookmarked(url: string): boolean {
    return this.file.data.items.some((b) => b.url === url)
  }

  add(url: string, title: string): Bookmark {
    const existing = this.file.data.items.find((b) => b.url === url)
    if (existing) return existing
    const bm: Bookmark = {
      id: Math.random().toString(36).slice(2, 10),
      url,
      title: title || url,
      createdAt: Date.now()
    }
    this.file.data.items.unshift(bm)
    this.file.save()
    this.emit('changed')
    return bm
  }

  remove(idOrUrl: string): void {
    const before = this.file.data.items.length
    this.file.data.items = this.file.data.items.filter((b) => b.id !== idOrUrl && b.url !== idOrUrl)
    if (this.file.data.items.length !== before) {
      this.file.save()
      this.emit('changed')
    }
  }

  /** Toggle bookmark state for a url; returns new state. */
  toggle(url: string, title: string): boolean {
    if (this.isBookmarked(url)) {
      this.remove(url)
      return false
    }
    this.add(url, title)
    return true
  }

  flush(): void {
    this.file.saveNow()
  }
}

// ---------------- History ----------------

interface HistoryEntry {
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

  clear(): void {
    this.byUrl.clear()
    this.file.data.entries = []
    this.file.saveNow()
  }

  flush(): void {
    this.file.saveNow()
  }
}

// ---------------- Session (open tabs) ----------------

class SessionStore {
  private file = new JsonFile<{ urls: string[] }>('last-session.json', { urls: [] })

  get(): string[] {
    return this.file.data.urls
  }

  set(urls: string[]): void {
    this.file.data.urls = urls
    this.file.saveNow()
  }
}

export const settingsStore = new SettingsStore()
export const bookmarksStore = new BookmarksStore()
export const historyStore = new HistoryStore()
export const sessionStore = new SessionStore()

export function flushAllStores(): void {
  settingsStore.flush()
  bookmarksStore.flush()
  historyStore.flush()
}
