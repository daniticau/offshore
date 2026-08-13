import { EventEmitter } from 'events'
import type { PageEdit, PageEditOp, SiteEdits } from '@shared/types'
import { JsonFile, genId } from './stores'

/**
 * Every page edit the browser has been asked to remember, keyed by host.
 *
 * The record is deliberately dumb: an op, a selector, at most a value. All the
 * craft — picking a selector that survives a re-render, applying without
 * fighting the page — lives in the page preload (src/preload/pageedit.ts).
 * Main only keeps the ledger, so the ledger is all it has to get right:
 * validated fields, one edit per (op, selector) so re-editing replaces rather
 * than piles up, and a cap that keeps a runaway page from growing the file
 * forever.
 */

const MAX_EDITS_PER_SITE = 300
const MAX_SELECTOR = 2048
const MAX_VALUE = 32_768
const MAX_LABEL = 120
const OPS: readonly PageEditOp[] = ['hide', 'text', 'focus']

interface PageEditsFile {
  version: 1
  sites: Record<string, SiteEdits>
}

class PageEditsStore extends EventEmitter {
  private file = new JsonFile<PageEditsFile>('page-edits.json', { version: 1, sites: {} })

  forHost(host: string): SiteEdits | undefined {
    return this.file.data.sites[host]
  }

  count(host: string): number {
    return this.forHost(host)?.edits.length ?? 0
  }

  enabled(host: string): boolean {
    return this.forHost(host)?.enabled ?? true
  }

  /** Sites that actually hold edits, for the settings page. */
  list(): SiteEdits[] {
    return Object.values(this.file.data.sites)
      .filter((s) => s.edits.length > 0)
      .sort((a, b) => a.host.localeCompare(b.host))
  }

  /**
   * Remember one edit. Returns the stored record (its id is what undo needs),
   * or null when the payload doesn't survive validation.
   */
  record(
    host: string,
    payload: { op: unknown; selector: unknown; value?: unknown; path?: unknown; label?: unknown }
  ): PageEdit | null {
    if (!host) return null
    const op = payload.op as PageEditOp
    if (!OPS.includes(op)) return null
    const selector = typeof payload.selector === 'string' ? payload.selector.trim() : ''
    if (!selector || selector.length > MAX_SELECTOR) return null
    const value =
      op === 'text' && typeof payload.value === 'string'
        ? payload.value.slice(0, MAX_VALUE)
        : undefined
    if (op === 'text' && value === undefined) return null
    const path =
      op === 'text' && typeof payload.path === 'string' ? payload.path.slice(0, 1024) : undefined
    const label =
      typeof payload.label === 'string' && payload.label.trim()
        ? payload.label.trim().slice(0, MAX_LABEL)
        : undefined

    const site = (this.file.data.sites[host] ??= { host, enabled: true, edits: [] })
    // Re-editing the same element replaces the old record instead of stacking a
    // second one — otherwise every rewrite of a headline would replay in order.
    const existing = site.edits.find(
      (e) => e.op === op && e.selector === selector && (op !== 'text' || e.path === path)
    )
    if (existing) {
      existing.value = value
      existing.label = label ?? existing.label
      existing.createdAt = Date.now()
      this.commit()
      return existing
    }
    if (site.edits.length >= MAX_EDITS_PER_SITE) return null
    const edit: PageEdit = { id: genId(), op, selector, value, path, label, createdAt: Date.now() }
    site.edits.push(edit)
    this.commit()
    return edit
  }

  remove(host: string, id: string): void {
    const site = this.forHost(host)
    if (!site) return
    const before = site.edits.length
    site.edits = site.edits.filter((e) => e.id !== id)
    if (site.edits.length === before) return
    if (site.edits.length === 0) delete this.file.data.sites[host]
    this.commit()
  }

  clear(host: string): void {
    if (!this.file.data.sites[host]) return
    delete this.file.data.sites[host]
    this.commit()
  }

  setEnabled(host: string, on: boolean): void {
    const site = this.forHost(host)
    if (!site || site.enabled === on) return
    site.enabled = on
    this.commit()
  }

  private commit(): void {
    this.file.save()
    this.emit('changed')
  }

  flush(): void {
    this.file.saveNow()
  }
}

export const pageEditsStore = new PageEditsStore()
