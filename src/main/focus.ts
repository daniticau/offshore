import { EventEmitter } from 'events'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { JsonFile } from './stores'

/**
 * Per-site memory for the Focus built-in: one boolean per host, nothing else.
 * The engine lives in the page preload (src/preload/focus.ts); main only keeps
 * this ledger and tells documents which way the switch points.
 *
 * 'changed' carries the host that flipped, so ipc.ts can bring live tabs in
 * line without this file (or tabs.ts) ever importing the window registry.
 */

interface FocusFile {
  version: 1
  /** Only hosts where Focus is ON are stored; absence = off. */
  sites: Record<string, { on: true; updatedAt: number }>
}

class FocusStore extends EventEmitter {
  private file = new JsonFile<FocusFile>('focus.json', { version: 1, sites: {} })

  constructor() {
    super()
    this.migrateFromPageEdits()
  }

  /** One-time import: sites whose Page Cleaner had Focus on stay focused.
   *  Everything else in the retired ledger (manual edits, Clean mode) is
   *  discarded, and the old file is deleted so it can't be imported twice. */
  private migrateFromPageEdits(): void {
    const old = join(app.getPath('userData'), 'page-edits.json')
    if (!existsSync(old)) return
    try {
      const parsed = JSON.parse(readFileSync(old, 'utf-8')) as {
        sites?: Record<string, { modes?: { focus?: boolean } }>
      }
      for (const [host, site] of Object.entries(parsed.sites ?? {})) {
        if (site?.modes?.focus === true && !this.file.data.sites[host]) {
          this.file.data.sites[host] = { on: true, updatedAt: Date.now() }
        }
      }
      this.file.save()
    } catch {
      /* an unreadable ledger migrates as empty */
    }
    try {
      rmSync(old)
    } catch {
      /* leave it; absence check reruns next boot */
    }
  }

  isOn(host: string): boolean {
    return !!this.file.data.sites[host]
  }

  set(host: string, on: boolean): void {
    if (!host || this.isOn(host) === on) return
    if (on) this.file.data.sites[host] = { on: true, updatedAt: Date.now() }
    else delete this.file.data.sites[host]
    this.file.save()
    this.emit('changed', host)
  }

  sites(): string[] {
    return Object.keys(this.file.data.sites).sort()
  }

  clearAll(): void {
    if (!this.sites().length) return
    this.file.data.sites = {}
    this.file.save()
    this.emit('changed')
  }

  flush(): void {
    this.file.saveNow()
  }
}

export const focusStore = new FocusStore()
