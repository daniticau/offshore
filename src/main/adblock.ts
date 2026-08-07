import { app, session, type Session } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { ADBLOCK_LIST_URLS, type Settings } from '@shared/types'
import { settingsStore } from './stores'

/**
 * Customizable ad/tracker blocking built on the Ghostery engine
 * (uBlock Origin / EasyList filter syntax compatible).
 *
 * - Enabled lists come from settings.adblock.lists
 * - settings.adblock.customRules are appended verbatim
 * - settings.adblock.allowlist hostnames get @@ exception rules
 */
class AdblockManager {
  private blocker: ElectronBlocker | null = null
  private enabledIn: Session | null = null
  private rebuilding = false
  private pendingRebuild = false
  /** webContents id -> blocked request count */
  readonly counts = new Map<number, number>()
  onCountChanged: ((tabId: number, count: number) => void) | null = null

  async init(ses: Session): Promise<void> {
    this.enabledIn = ses
    settingsStore.on('changed', (next: Settings, prev: Settings) => {
      const a = JSON.stringify(next.adblock)
      const b = JSON.stringify(prev.adblock)
      if (a !== b) void this.rebuild()
    })
    await this.rebuild()
  }

  private listUrls(s: Settings): string[] {
    return Object.entries(s.adblock.lists)
      .filter(([, on]) => on)
      .flatMap(([id]) => ADBLOCK_LIST_URLS[id] ?? [])
  }

  private extraRules(s: Settings): string {
    const allow = s.adblock.allowlist
      .map((host) => `@@||${host}^$document\n@@||${host}^`)
      .join('\n')
    return `${s.adblock.customRules}\n${allow}`
  }

  async rebuild(): Promise<void> {
    if (this.rebuilding) {
      this.pendingRebuild = true
      return
    }
    this.rebuilding = true
    try {
      const s = settingsStore.get()
      if (this.blocker && this.enabledIn && this.blocker.isBlockingEnabled(this.enabledIn)) {
        this.blocker.disableBlockingInSession(this.enabledIn)
      }
      this.blocker = null
      if (!s.adblock.enabled) return

      const cachePath = join(app.getPath('userData'), 'adblock-engine.bin')
      const urls = this.listUrls(s)
      let blocker: ElectronBlocker
      try {
        blocker = await ElectronBlocker.fromLists(fetch, urls, { enableCompression: true }, {
          path: cachePath,
          read: fs.readFile,
          write: fs.writeFile
        })
      } catch (err) {
        console.warn('[adblock] list fetch failed, falling back to cache/none:', err)
        try {
          blocker = ElectronBlocker.deserialize(await fs.readFile(cachePath)) as ElectronBlocker
        } catch {
          return
        }
      }

      const extra = this.extraRules(s).trim()
      if (extra) {
        const { networkFilters, cosmeticFilters } = ElectronBlocker.parse(extra).getFilters()
        blocker.update({ newNetworkFilters: networkFilters, newCosmeticFilters: cosmeticFilters })
      }

      blocker.on('request-blocked', (request) => {
        const tabId = request.tabId
        if (typeof tabId === 'number' && tabId > 0) {
          const next = (this.counts.get(tabId) ?? 0) + 1
          this.counts.set(tabId, next)
          this.onCountChanged?.(tabId, next)
        }
      })

      const ses = this.enabledIn ?? session.defaultSession
      blocker.enableBlockingInSession(ses)
      this.blocker = blocker
      console.log(`[adblock] engine active with ${urls.length} lists`)
    } finally {
      this.rebuilding = false
      if (this.pendingRebuild) {
        this.pendingRebuild = false
        void this.rebuild()
      }
    }
  }

  resetCount(tabId: number): void {
    this.counts.set(tabId, 0)
    this.onCountChanged?.(tabId, 0)
  }

  dropTab(tabId: number): void {
    this.counts.delete(tabId)
  }

  isActive(): boolean {
    return this.blocker !== null
  }

  /** Toggle blocking for a hostname; returns true if now allowlisted (blocking off). */
  toggleSite(host: string): boolean {
    const s = settingsStore.get()
    const list = new Set(s.adblock.allowlist)
    let allowlisted: boolean
    if (list.has(host)) {
      list.delete(host)
      allowlisted = false
    } else {
      list.add(host)
      allowlisted = true
    }
    settingsStore.set({ adblock: { ...s.adblock, allowlist: [...list] } })
    return allowlisted
  }
}

export const adblock = new AdblockManager()
