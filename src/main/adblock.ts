import { app, ipcMain, type Session } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { ADBLOCK_LIST_URLS, type Settings } from '@shared/types'
import { settingsStore } from './stores'

/**
 * Customizable ad/tracker blocking built on the Ghostery engine
 * (uBlock Origin / EasyList filter syntax compatible).
 *
 * - Enabled lists come from settings.adblock.lists (changing them = full rebuild)
 * - customRules/allowlist changes apply incrementally via engine.update —
 *   no network refetch, no blocking gap
 * - Blocking is enabled in every prepared session partition (shared profile
 *   plus each separate-login space)
 */
class AdblockManager {
  private blocker: ElectronBlocker | null = null
  private sessions = new Set<Session>()
  private rebuilding = false
  private pendingRebuild = false
  private prevExtra = ''
  /** webContents id -> blocked request count */
  readonly counts = new Map<number, number>()
  onCountChanged: ((tabId: number, count: number) => void) | null = null

  async init(): Promise<void> {
    settingsStore.on('changed', (next: Settings, prev: Settings) => {
      if (next.adblock.enabled !== prev.adblock.enabled) {
        void this.rebuild()
        return
      }
      if (JSON.stringify(next.adblock.lists) !== JSON.stringify(prev.adblock.lists)) {
        void this.rebuild()
        return
      }
      const nextExtra = this.extraRules(next).trim()
      const prevExtra = this.extraRules(prev).trim()
      if (nextExtra !== prevExtra) this.applyExtras(nextExtra)
    })
    await this.rebuild()
  }

  /**
   * The Ghostery BlockingContext registers GLOBAL ipcMain handlers on every
   * enable and would throw for the second session. The handlers are identical
   * for one engine instance, so drop them first and let enable re-register.
   */
  private safeEnable(blocker: ElectronBlocker, ses: Session): void {
    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters')
    ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled')
    blocker.enableBlockingInSession(ses)
  }

  /** Register a session partition for blocking (idempotent). */
  attachSession(ses: Session): void {
    if (this.sessions.has(ses)) return
    this.sessions.add(ses)
    if (this.blocker && !this.blocker.isBlockingEnabled(ses)) {
      this.safeEnable(this.blocker, ses)
    }
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

  private parseExtras(txt: string): ReturnType<ReturnType<typeof ElectronBlocker.parse>['getFilters']> {
    if (!txt.trim()) return { networkFilters: [], cosmeticFilters: [] }
    return ElectronBlocker.parse(txt.trim()).getFilters()
  }

  /** Diff custom rules + allowlist into the live engine without a rebuild. */
  private applyExtras(nextExtra: string): void {
    if (!this.blocker) return
    try {
      const prev = this.parseExtras(this.prevExtra)
      const next = this.parseExtras(nextExtra)
      const prevNet = new Map(prev.networkFilters.map((f) => [f.getId(), f]))
      const prevCos = new Map(prev.cosmeticFilters.map((f) => [f.getId(), f]))
      const nextNetIds = new Set(next.networkFilters.map((f) => f.getId()))
      const nextCosIds = new Set(next.cosmeticFilters.map((f) => f.getId()))
      this.blocker.update({
        newNetworkFilters: next.networkFilters.filter((f) => !prevNet.has(f.getId())),
        newCosmeticFilters: next.cosmeticFilters.filter((f) => !prevCos.has(f.getId())),
        removedNetworkFilters: [...prevNet.keys()].filter((id) => !nextNetIds.has(id)),
        removedCosmeticFilters: [...prevCos.keys()].filter((id) => !nextCosIds.has(id))
      })
      this.prevExtra = nextExtra
    } catch (err) {
      console.warn('[adblock] incremental update failed, rebuilding:', err)
      void this.rebuild()
    }
  }

  async rebuild(): Promise<void> {
    if (this.rebuilding) {
      this.pendingRebuild = true
      return
    }
    this.rebuilding = true
    try {
      const s = settingsStore.get()
      if (!s.adblock.enabled) {
        for (const ses of this.sessions) {
          if (this.blocker?.isBlockingEnabled(ses)) this.blocker.disableBlockingInSession(ses)
        }
        this.blocker = null
        return
      }

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
        const { networkFilters, cosmeticFilters } = this.parseExtras(extra)
        blocker.update({ newNetworkFilters: networkFilters, newCosmeticFilters: cosmeticFilters })
      }
      this.prevExtra = extra

      blocker.on('request-blocked', (request) => {
        const tabId = request.tabId
        if (typeof tabId === 'number' && tabId > 0) {
          const next = (this.counts.get(tabId) ?? 0) + 1
          this.counts.set(tabId, next)
          this.onCountChanged?.(tabId, next)
        }
      })

      // Swap engines: disable the old one only after the new one is ready
      const old = this.blocker
      this.blocker = blocker
      for (const ses of this.sessions) {
        if (old && old !== blocker && old.isBlockingEnabled(ses)) old.disableBlockingInSession(ses)
        if (!blocker.isBlockingEnabled(ses)) this.safeEnable(blocker, ses)
      }
      console.log(`[adblock] engine active with ${urls.length} lists in ${this.sessions.size} session(s)`)
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
