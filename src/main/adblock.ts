import { app, ipcMain, type Session } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { ADBLOCK_LIST_URLS, type Settings } from '@shared/types'
import { settingsStore, shieldStatsStore } from './stores'

/**
 * The built-in Shield: ad/tracker/malware blocking on the Ghostery engine,
 * running the full uBlock Origin default list set (uBO filter syntax).
 *
 * - Enabled lists come from settings.adblock.lists (changing them = full rebuild)
 * - customRules/allowlist changes apply incrementally via engine.update —
 *   no network refetch, no blocking gap
 * - Blocking is enabled in every prepared session partition (shared profile
 *   plus each separate-login space)
 */

/** Bump when the engine config changes, so old disk caches stop matching. */
const ENGINE_SCHEMA = 1
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

      // The cache is keyed on the enabled list set (plus a schema counter), so
      // toggling lists can never serve a stale engine, and a set change busts
      // the old key instead of overwriting in place.
      const ids = Object.entries(s.adblock.lists)
        .filter(([, on]) => on)
        .map(([id]) => id)
        .sort()
      const urls = ids.flatMap((id) => ADBLOCK_LIST_URLS[id] ?? [])
      const key = createHash('sha1').update(`${ENGINE_SCHEMA}:${ids.join(',')}`).digest('hex').slice(0, 12)
      const userData = app.getPath('userData')
      const cachePath = join(userData, `adblock-engine-${key}.bin`)

      let blocker: ElectronBlocker
      let fetched = 0
      if (urls.length === 0) {
        // no lists at all — an empty engine still carries custom rules + allowlist
        blocker = ElectronBlocker.parse('', { enableCompression: true })
      } else {
        // Per-list tolerance: one dead URL costs that list, never the engine.
        const settled = await Promise.allSettled(
          urls.map((u) =>
            fetch(u, { signal: AbortSignal.timeout(20_000) }).then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`)
              return r.text()
            })
          )
        )
        const texts: string[] = []
        settled.forEach((res, i) => {
          if (res.status === 'fulfilled') texts.push(res.value)
          else console.warn('[adblock] list fetch failed:', urls[i], res.reason)
        })
        fetched = texts.length
        if (texts.length > 0) {
          blocker = ElectronBlocker.parse(texts.join('\n'), { enableCompression: true })
          try {
            await fs.writeFile(cachePath, blocker.serialize())
            // stale keys (and the legacy unkeyed cache) go with the build
            for (const f of await fs.readdir(userData)) {
              if (/^adblock-engine.*\.bin$/.test(f) && join(userData, f) !== cachePath) {
                await fs.rm(join(userData, f), { force: true })
              }
            }
          } catch (err) {
            console.warn('[adblock] engine cache write failed:', err)
          }
        } else {
          try {
            blocker = ElectronBlocker.deserialize(await fs.readFile(cachePath)) as ElectronBlocker
          } catch {
            // do NOT null this.blocker — the old engine keeps working
            console.warn('[adblock] offline and no cache for this list set — keeping current engine')
            return
          }
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
          // inside the guard: the lifetime number matches what users can
          // attribute to tabs — tabless blocks (service workers) go uncounted
          shieldStatsStore.add(1)
        }
      })

      // Swap engines: disable the old one only after the new one is ready
      const old = this.blocker
      this.blocker = blocker
      for (const ses of this.sessions) {
        if (old && old !== blocker && old.isBlockingEnabled(ses)) old.disableBlockingInSession(ses)
        if (!blocker.isBlockingEnabled(ses)) this.safeEnable(blocker, ses)
      }
      console.log(`[adblock] engine active: ${ids.length} lists, ${fetched} fetched, key ${key}`)
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
