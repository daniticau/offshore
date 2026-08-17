import { app, safeStorage, session, type Cookie, type CookiesSetDetails, type Session } from 'electron'
import { promises as fs, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { getDomain } from 'tldts-experimental'
import {
  ADBLOCK_LIST_URLS,
  PRIVACY_NEVER_TOUCH,
  type ExpiredSite,
  type TabPrivacyInfo
} from '@shared/types'
import { HARNESS_ACTIVE } from './bootstrap'
import { passwordVault } from './passwords'
import { JsonFile, bookmarksStore, settingsStore } from './stores'

/**
 * Harbor — the smart privacy manager. Four concerns, one file:
 *
 * 1. Consent auto-answer plumbing (rules payload + per-tab status registry);
 *    the content half lives in src/preload/consent.ts.
 * 2. Tracker-cookie stripping: the request-side decision runs inside the
 *    existing onBeforeSendHeaders callback (sessions.ts — Electron allows one
 *    listener per event and Ghostery owns onBeforeRequest/onHeadersReceived),
 *    and the response side is a post-write scrub on ses.cookies 'changed'.
 * 3. The tide: an engagement map (registrable domain → UTC day of last
 *    top-level visit, nothing else, recorded only while the tide is on)
 *    drives auto-expiry of cookies from sites you've stopped visiting, with
 *    an undo stash (values safeStorage-encrypted at rest).
 * 4. Per-site report data for the SiteInfo panel (assembled in ipc.ts).
 *
 * The never-breaks-logins posture: PRIVACY_NEVER_TOUCH beats every list,
 * documents/media/webSockets are never stripped, first-party is never stripped,
 * and an unknown request context falls closed (don't touch).
 */

const DAY = 86_400_000
const ENGAGEMENT_CAP = 2000
/** The widest tideDays the settings allow — the cap's eviction floor. */
const MAX_TIDE_DAYS = 90
const STASH_CAP = 40
const STASH_MAX_AGE = 14 * DAY

function dayStart(ts: number): number {
  return ts - (ts % DAY)
}

export function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith('.' + entry))
}

/** getDomain covers real hosts; the ?? covers localhost, IPs and single labels. */
export function registrableDomain(host: string): string {
  return getDomain(host) ?? host
}

/** The slice of onBeforeSendHeaders details the strip decision reads. */
export interface StripDetails {
  url: string
  resourceType: string
  referrer?: string
  frame?: { top?: { url: string } | null } | null
}

interface EngagementFile {
  version: 1
  createdAt: number
  lastSweepAt: number
  hosts: Record<string, number>
}

interface StashEntry {
  domain: string
  expiredAt: number
  partition: string
  /** With `enc`, each cookie's `value` is a safeStorage ciphertext (base64). */
  cookies: Cookie[]
  enc?: boolean
}

/** Stash-at-rest crypto, mirroring the password vault (passwords.ts). */
function stashCryptoAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encValue(value: string): string {
  return safeStorage.encryptString(value).toString('base64')
}

function decValue(value: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return null
  }
}

function cookieHost(c: Cookie): string {
  return (c.domain ?? '').replace(/^\./, '')
}

function cookieUrl(c: Cookie): string {
  return `${c.secure ? 'https' : 'http'}://${cookieHost(c)}${c.path ?? '/'}`
}

class Harbor {
  private classifier: FiltersEngine | null = null
  private building = false
  private engagement = new JsonFile<EngagementFile>('engagement.json', {
    version: 1,
    createdAt: dayStart(Date.now()),
    lastSweepAt: 0,
    hosts: {}
  })
  private stash = new JsonFile<{ entries: StashEntry[] }>('expired-cookies.json', { entries: [] }, {
    // cookie values are live session tokens — owner-only, like the vault
    mode: 0o600
  })
  private sessions = new WeakSet<Session>()
  /** webContents id -> tracker cookies kept out of its requests */
  private strips = new Map<number, number>()
  /** webContents id -> tracker cookies deleted from the jar by the scrub */
  private scrubs = new Map<number, number>()
  /** webContents id -> current top-level registrable domain (open-tab evidence). */
  private tabTops = new Map<number, string>()
  /** registrable domain -> last webContents id whose stripped request hit it,
   *  so a response-side scrub can be pinned on the page that summoned it. */
  private lastRequester = new Map<string, number>()
  /** Domains mid-restore(): the scrub must not eat what the undo re-sets. */
  private restoring = new Set<string>()
  /** Flow-only classifier seeds — see the exported hooks section. */
  private testTrackers = new Set<string>()
  private consent = new Map<number, { state: TabPrivacyInfo['consent']; cmp?: string }>()
  private rules: unknown | null = null
  onCountChanged: ((tabId: number) => void) | null = null
  /** How many times the consent:eval fallback carried an eval (0 = webFrame path). */
  consentEvalFallbacks = 0

  async init(): Promise<void> {
    this.pruneStash()
    // Tide scheduling stays out of the launch path, and out of the harness
    // entirely — the harbor flow drives sweep() with an injected clock, and a
    // wall-clock sweep racing it would make the flow's asserts weather-dependent.
    if (!HARNESS_ACTIVE) {
      setTimeout(() => void this.sweepIfDue(), 60_000)
      setInterval(() => void this.sweepIfDue(), 6 * 60 * 60 * 1000)
    }
    // The classifier serves cookieGuard and nothing else — no list fetch for a
    // feature that's off. Flipping the toggle on calls ensureClassifier().
    const wantClassifier = (): boolean => settingsStore.get().privacy.cookieGuard
    setInterval(() => {
      if (!this.classifier && wantClassifier()) void this.buildClassifier()
    }, 6 * 60 * 60 * 1000)
    if (wantClassifier()) await this.buildClassifier()
  }

  /** cookieGuard just switched on mid-session: build without waiting 6 hours. */
  ensureClassifier(): void {
    if (!this.classifier) void this.buildClassifier()
  }

  flush(): void {
    this.engagement.saveNow()
    this.stash.saveNow()
  }

  // ---------------- consent ----------------

  /** The autoconsent payload for a page, or null when Harbor stays out of it. */
  consentRulesFor(host: string): { config: Record<string, unknown>; rules: unknown } | null {
    const s = settingsStore.get().privacy
    if (!s.consentAuto) return null
    if (s.disabledSites.includes(registrableDomain(host))) return null
    if (!this.rules) {
      try {
        const req = createRequire(__filename)
        this.rules = JSON.parse(
          readFileSync(req.resolve('@duckduckgo/autoconsent/rules/rules.json'), 'utf-8')
        )
      } catch (err) {
        console.warn('[harbor] consent rules unavailable:', err)
        return null
      }
    }
    return {
      config: {
        enabled: true,
        autoAction: 'optOut',
        enablePrehide: true,
        enableCosmeticRules: true,
        isMainWorld: false,
        logs: {
          lifecycle: false,
          rulesteps: false,
          detectionsteps: false,
          evals: false,
          errors: false,
          messages: false,
          waits: false
        }
      },
      rules: this.rules
    }
  }

  /** Sanitized consent:status transitions; 'handled' is never downgraded. */
  noteConsent(tabId: number, type: string, cmp?: string, result?: boolean): void {
    const cur = this.consent.get(tabId)
    const next = { state: cur?.state ?? ('none' as const), cmp: cur?.cmp }
    if (type === 'cmpDetected' || type === 'popupFound') {
      if (next.state !== 'handled') next.state = 'found'
      if (cmp) next.cmp = cmp
    } else if (type === 'autoconsentError' || (type === 'optOutResult' && result !== true)) {
      if (next.state !== 'handled') next.state = 'failed'
    } else if (type === 'autoconsentDone' || (type === 'optOutResult' && result === true)) {
      next.state = 'handled'
      if (cmp) next.cmp = cmp
    }
    this.consent.set(tabId, next)
  }

  // ---------------- per-tab state ----------------

  tabPrivacy(tabId: number): TabPrivacyInfo | undefined {
    const stripped = this.strips.get(tabId) ?? 0
    const scrubbed = this.scrubs.get(tabId) ?? 0
    const consent = this.consent.get(tabId)
    if (!stripped && !scrubbed && (!consent || consent.state === 'none')) return undefined
    return {
      cookiesStripped: stripped,
      cookiesScrubbed: scrubbed,
      consent: consent?.state ?? 'none',
      cmp: consent?.cmp
    }
  }

  countStripped(tabId: number | undefined, url?: string): void {
    if (typeof tabId !== 'number' || tabId <= 0) return
    this.strips.set(tabId, (this.strips.get(tabId) ?? 0) + 1)
    if (url) {
      try {
        this.noteRequester(registrableDomain(new URL(url).hostname), tabId)
      } catch {
        /* unparseable url — the strip still counts */
      }
    }
    this.onCountChanged?.(tabId)
  }

  private noteRequester(domain: string, tabId: number): void {
    // re-insert so Map order stays LRU-ish; the cap keeps this map small
    this.lastRequester.delete(domain)
    this.lastRequester.set(domain, tabId)
    if (this.lastRequester.size > 200) {
      const oldest = this.lastRequester.keys().next().value
      if (oldest !== undefined) this.lastRequester.delete(oldest)
    }
  }

  /** A jar deletion has no tab context of its own — pin it on the tab open on
   *  the domain (blockSites case) or the page whose request last summoned it. */
  private countScrubbed(domain: string): void {
    let tabId: number | undefined
    for (const [id, d] of this.tabTops) {
      if (d === domain) {
        tabId = id
        break
      }
    }
    tabId ??= this.lastRequester.get(domain)
    if (typeof tabId !== 'number') return
    this.scrubs.set(tabId, (this.scrubs.get(tabId) ?? 0) + 1)
    this.onCountChanged?.(tabId)
  }

  resetTab(tabId: number): void {
    this.strips.delete(tabId)
    this.scrubs.delete(tabId)
    this.consent.delete(tabId)
    // noteTopVisit re-fills this the moment the new document is a real site
    this.tabTops.delete(tabId)
  }

  dropTab(tabId: number): void {
    this.strips.delete(tabId)
    this.scrubs.delete(tabId)
    this.consent.delete(tabId)
    this.tabTops.delete(tabId)
  }

  // ---------------- classifier ----------------

  classifierReady(): boolean {
    return this.classifier !== null
  }

  private async buildClassifier(): Promise<void> {
    if (this.building) return
    this.building = true
    try {
      // A second, tracking-only engine — classification, never blocking — so
      // the Shield's exceptions and on/off state can't mask tracker identity.
      const urls = [
        ...(ADBLOCK_LIST_URLS['easyprivacy'] ?? []),
        ...(ADBLOCK_LIST_URLS['peter-lowe'] ?? [])
      ]
      this.classifier = await FiltersEngine.fromLists(fetch, urls, { enableCompression: true }, {
        path: join(app.getPath('userData'), 'harbor-classifier.bin'),
        read: fs.readFile,
        write: fs.writeFile
      })
      console.log('[harbor] classifier ready')
    } catch (err) {
      // no cache, no network: cookieGuard classifies nothing list-based until
      // the 6h retry lands (blockSites still work)
      console.warn('[harbor] classifier unavailable for now:', err)
    } finally {
      this.building = false
    }
  }

  classifyRequest(url: string, sourceUrl: string, type: string): boolean {
    if (!this.classifier) return false
    try {
      return this.classifier.match(
        Request.fromRawDetails({ url, sourceUrl, type: type as never })
      ).match
    } catch {
      return false
    }
  }

  /** Domain-level: would this registrable domain be a tracker as a third party?
   *  Hostname-anchored filters (||domain^) match this synthetic fetch; path-
   *  specific EasyPrivacy rules deliberately do not — conservative by design. */
  isTrackerDomain(domain: string): boolean {
    if (this.testTrackers.has(domain)) return true
    return this.classifyRequest(`https://${domain}/`, 'https://offshore-probe.invalid/', 'script')
  }

  // ---------------- request-side strip decision ----------------

  shouldStripRequest(details: StripDetails): boolean {
    const s = settingsStore.get().privacy
    if (!s.cookieGuard) return false
    if (!/^https?:\/\//.test(details.url)) return false
    const type = details.resourceType
    // The never-breaks-logins core: SSO/checkout travel as documents (top-level
    // redirects + challenge iframes) and always keep their cookies; media and
    // webSocket stay untouchable so DRM segment auth can never lose a cookie.
    if (type === 'mainFrame' || type === 'subFrame' || type === 'webSocket' || type === 'media') {
      return false
    }
    let reqHost: string
    try {
      reqHost = new URL(details.url).hostname
    } catch {
      return false
    }
    // exemptions beat classification, always
    if (hostMatches(reqHost, PRIVACY_NEVER_TOUCH)) return false
    let topUrl = ''
    try {
      topUrl = details.frame?.top?.url ?? ''
    } catch {
      topUrl = ''
    }
    if (!/^https?:\/\//.test(topUrl)) topUrl = details.referrer ?? ''
    if (!/^https?:\/\//.test(topUrl)) return false // unknown context: never strip
    let topHost: string
    try {
      topHost = new URL(topUrl).hostname
    } catch {
      return false
    }
    const reqDomain = registrableDomain(reqHost)
    const topDomain = registrableDomain(topHost)
    if (reqDomain === topDomain) return false // first-party, absolute
    if (s.disabledSites.includes(topDomain)) return false
    if (s.keepSites.includes(reqDomain)) return false
    if (s.blockSites.includes(reqDomain)) return true
    return this.classifyRequest(details.url, topUrl, type)
  }

  // ---------------- response-side scrub ----------------

  /** Idempotent per session, like adblock.attachSession. Catches what header
   *  stripping cannot: document.cookie writes and Set-Cookie responses. */
  attachSession(ses: Session): void {
    if (this.sessions.has(ses)) return
    this.sessions.add(ses)
    ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
      // removals re-fire 'changed' with removed=true — this line is the recursion guard
      if (removed || !settingsStore.get().privacy.cookieGuard) return
      const host = cookieHost(cookie)
      if (hostMatches(host, PRIVACY_NEVER_TOUCH)) return
      const domain = registrableDomain(host)
      // restore() is mid-flight for this domain — the writes are the undo itself
      if (this.restoring.has(domain)) return
      const s = settingsStore.get().privacy
      if (s.keepSites.includes(domain) || s.disabledSites.includes(domain)) return
      if (!s.blockSites.includes(domain)) {
        // domain-level classification only: a mixed-use domain that matches
        // nothing but path rules never loses a session cookie here
        if (!this.isTrackerDomain(domain)) return
        // First-party evidence beats classification (blockSites is the user's
        // own verdict and skips this): the lists flag analytics vendors whose
        // dashboards have real logins — a tab open on the domain, or a visit
        // within the tide horizon, means the user is *on* this site, and the
        // posture says first-party is never stripped.
        if (this.isOpenTopDomain(domain)) return
        const last = this.engagement.data.hosts[domain]
        if (last !== undefined && Date.now() - last <= s.tideDays * DAY) return
      }
      void ses.cookies.remove(cookieUrl(cookie), cookie.name).catch(() => {})
      this.countScrubbed(domain)
    })
  }

  // ---------------- engagement map ----------------

  noteTopVisit(url: string, tabId?: number): void {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return
    }
    if (!host) return
    const domain = registrableDomain(host)
    // the open-tab ledger (scrub evidence, live sweep checks) is in-memory
    // state about what is on screen right now — no toggle governs it
    if (typeof tabId === 'number') this.tabTops.set(tabId, domain)
    // the engagement map exists for the tide; with the tide off, nothing is
    // written down
    if (!settingsStore.get().privacy.tide) return
    this.touch(domain)
  }

  /** Is this registrable domain the top-level site of any open tab? */
  isOpenTopDomain(domain: string): boolean {
    for (const d of this.tabTops.values()) if (d === domain) return true
    return false
  }

  /** The optional clock is the test flow's; a write only happens when the day changes. */
  touch(domain: string, at = Date.now()): void {
    const day = dayStart(at)
    const hosts = this.engagement.data.hosts
    if (hosts[domain] === day) return
    hosts[domain] = day
    const keys = Object.keys(hosts)
    if (keys.length > ENGAGEMENT_CAP) {
      keys.sort((a, b) => hosts[a] - hosts[b])
      // The cap may only evict entries already outside the widest tide horizon:
      // the sweep reads absence as staleness, so evicting a within-horizon
      // entry would break the tideDays promise. An all-live map runs over the
      // cap instead — self-limiting, one string and one number per site.
      const horizon = day - MAX_TIDE_DAYS * DAY
      for (const k of keys.slice(0, keys.length - ENGAGEMENT_CAP)) {
        if (hosts[k] >= horizon) break // ascending sort: the rest are live too
        delete hosts[k]
      }
    }
    this.engagement.save()
  }

  lastVisit(domain: string): number | null {
    return this.engagement.data.hosts[domain] ?? null
  }

  engagementCreatedAt(): number {
    return this.engagement.data.createdAt
  }

  // -- plain exported hooks the harbor flow drives directly (pageedits precedent) --

  engagementSeed(domain: string, at: number): void {
    this.touch(domain, at)
  }

  engagementSetCreatedAt(at: number): void {
    this.engagement.data.createdAt = dayStart(at)
    this.engagement.save()
  }

  engagementDelete(domain: string): void {
    delete this.engagement.data.hosts[domain]
    this.engagement.save()
  }

  /** Flow-only: make isTrackerDomain flag a fixture domain without the network. */
  trackerSeed(domain: string): void {
    this.testTrackers.add(domain)
  }

  trackerSeedClear(): void {
    this.testTrackers.clear()
  }

  /** A fresh map earns a fresh grace period. */
  clearEngagement(): void {
    this.engagement.data = { version: 1, createdAt: dayStart(Date.now()), lastSweepAt: 0, hosts: {} }
    this.engagement.saveNow()
  }

  // ---------------- the tide ----------------

  private async sweepIfDue(): Promise<void> {
    const now = Date.now()
    if (now - this.engagement.data.lastSweepAt < DAY) return
    await this.sweep(now).catch((err) => console.warn('[harbor] tide sweep failed:', err))
  }

  async sweep(now = Date.now()): Promise<{ swept: string[]; keptCount: number }> {
    const out = { swept: [] as string[], keptCount: 0 }
    const s = settingsStore.get().privacy
    if (!s.tide) return out
    // GRACE: the map must be old enough to witness a real absence — without
    // this, day one would nuke every login the user has
    if (now - this.engagement.data.createdAt < s.tideDays * DAY) return out

    const keep = new Set<string>(s.keepSites)
    const horizon = now - s.tideDays * DAY
    for (const [d, ts] of Object.entries(this.engagement.data.hosts)) {
      if (ts >= horizon) keep.add(d)
    }
    // a tab kept open for six weeks is engagement, even without navigations
    const { windows } = await import('./windows')
    for (const w of windows) {
      for (const tab of w.tabs.tabs) {
        try {
          const u = tab.wc.getURL()
          if (/^https?:/.test(u)) keep.add(registrableDomain(new URL(u).hostname))
        } catch {
          /* tab mid-teardown */
        }
      }
    }
    // a saved password is a declared relationship; a bookmark is declared intent
    if (passwordVault.available()) {
      for (const e of passwordVault.list()) keep.add(registrableDomain(e.host))
    }
    for (const n of bookmarksStore.list()) {
      if (n.type !== 'bookmark' || !n.url) continue
      try {
        keep.add(registrableDomain(new URL(n.url).hostname))
      } catch {
        /* malformed bookmark url */
      }
    }
    for (const h of PRIVACY_NEVER_TOUCH) keep.add(registrableDomain(h))
    const block = new Set(s.blockSites)

    // only prepared jars are swept; a closed space's jar gets its sweep the
    // next time the space opens
    const { preparedEntries } = await import('./sessions')
    let cookieCount = 0
    for (const [partition, ses] of preparedEntries()) {
      const byDomain = new Map<string, Cookie[]>()
      for (const c of await ses.cookies.get({})) {
        const d = registrableDomain(cookieHost(c))
        const list = byDomain.get(d) ?? []
        list.push(c)
        byDomain.set(d, list)
      }
      for (const [domain, cookies] of byDomain) {
        // The doom decision is live, not the snapshot's: this loop awaits, and
        // a navigation or visit landing mid-sweep must rescue its domain — the
        // engagement map (touch() keeps it current) and the open-tab ledger
        // are both re-read here, at the moment before destruction.
        const last = this.engagement.data.hosts[domain]
        const live = last !== undefined && last >= horizon
        if (!block.has(domain) && (keep.has(domain) || live || this.isOpenTopDomain(domain))) {
          out.keptCount += 1
          continue
        }
        // re-read the jar at doom time so the stash holds current values, not
        // the partition snapshot's — a login racing the sweep stays undoable
        let current = cookies
        try {
          current = (await ses.cookies.get({ domain })).filter(
            (c) => registrableDomain(cookieHost(c)) === domain
          )
        } catch {
          /* keep the snapshot */
        }
        // the platform promise beats even blockSites, cookie by cookie
        const doomed = current.filter((c) => !hostMatches(cookieHost(c), PRIVACY_NEVER_TOUCH))
        if (!doomed.length) continue
        this.stashEntry(domain, now, partition, doomed)
        for (const c of doomed) await ses.cookies.remove(cookieUrl(c), c.name).catch(() => {})
        for (const origin of [`https://${domain}`, `https://www.${domain}`]) {
          await ses
            .clearStorageData({
              origin,
              storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'websql']
            })
            .catch(() => {})
        }
        if (!out.swept.includes(domain)) out.swept.push(domain)
        cookieCount += doomed.length
      }
    }
    this.engagement.data.lastSweepAt = dayStart(now)
    this.engagement.save()
    if (out.swept.length) {
      console.log(`[harbor] tide: swept ${out.swept.length} site(s), ${cookieCount} cookie(s)`)
    }
    return out
  }

  /** Targeted expiry (blockSites turning on): stash first, so undo works. */
  async expireDomain(domain: string): Promise<void> {
    const now = Date.now()
    const { preparedEntries } = await import('./sessions')
    for (const [partition, ses] of preparedEntries()) {
      const doomed = (await ses.cookies.get({})).filter(
        (c) =>
          registrableDomain(cookieHost(c)) === domain &&
          !hostMatches(cookieHost(c), PRIVACY_NEVER_TOUCH)
      )
      if (!doomed.length) continue
      this.stashEntry(domain, now, partition, doomed)
      for (const c of doomed) await ses.cookies.remove(cookieUrl(c), c.name).catch(() => {})
      for (const origin of [`https://${domain}`, `https://www.${domain}`]) {
        await ses
          .clearStorageData({
            origin,
            storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'websql']
          })
          .catch(() => {})
      }
    }
  }

  // ---------------- the undo stash ----------------

  private pruneStash(): void {
    const cutoff = Date.now() - STASH_MAX_AGE
    const entries = this.stash.data.entries.filter((e) => e.expiredAt >= cutoff)
    while (entries.length > STASH_CAP) entries.shift()
    if (entries.length !== this.stash.data.entries.length) {
      this.stash.data.entries = entries
      this.stash.save()
    }
  }

  private stashEntry(domain: string, at: number, partition: string, cookies: Cookie[]): void {
    // Values are live session tokens that just left Chromium's encrypted jar —
    // at rest they get the vault's safeStorage treatment, never plaintext when
    // the machine can do better (the file is 0600 either way).
    const enc = stashCryptoAvailable()
    const stored = enc ? cookies.map((c) => ({ ...c, value: encValue(c.value) })) : cookies
    this.stash.data.entries.push({ domain, expiredAt: at, partition, cookies: stored, enc })
    this.pruneStash()
    this.stash.save()
  }

  /** Domains only, counts only — cookie values never leave main. */
  expiredList(): ExpiredSite[] {
    const byDomain = new Map<string, ExpiredSite>()
    for (const e of this.stash.data.entries) {
      const cur = byDomain.get(e.domain)
      byDomain.set(e.domain, {
        domain: e.domain,
        expiredAt: Math.max(cur?.expiredAt ?? 0, e.expiredAt),
        cookieCount: (cur?.cookieCount ?? 0) + e.cookies.length
      })
    }
    return [...byDomain.values()].sort((a, b) => b.expiredAt - a.expiredAt)
  }

  /** Cookies come back; anything the site stored is gone for good. */
  async restore(domain: string): Promise<boolean> {
    const entries = this.stash.data.entries.filter((e) => e.domain === domain)
    if (!entries.length) return false
    // Restoring is the user asking for this site's cookies back. A standing
    // block would hand every one straight back to the scrub — the block was
    // what expired them, so the restore lifts it.
    const s = settingsStore.get().privacy
    if (s.blockSites.includes(domain)) {
      settingsStore.set({
        privacy: { ...s, blockSites: s.blockSites.filter((d) => d !== domain) }
      })
    }
    // And the scrub must not eat the undo mid-flight (a tide-swept domain the
    // classifier flags would otherwise be re-scrubbed on every set).
    this.restoring.add(domain)
    const failed = new Set<StashEntry>()
    let all = true
    try {
      for (const e of entries) {
        const ses = session.fromPartition(e.partition)
        let ok = true
        for (const c of e.cookies) {
          const value = e.enc ? decValue(c.value) : c.value
          if (value === null) {
            // ciphertext from another machine/keychain — unrecoverable
            ok = false
            continue
          }
          const details: CookiesSetDetails = {
            url: cookieUrl(c),
            name: c.name,
            value,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly
          }
          if (!c.hostOnly && c.domain) details.domain = c.domain
          if (typeof c.expirationDate === 'number') details.expirationDate = c.expirationDate
          if (c.sameSite && !(c.sameSite === 'no_restriction' && !c.secure)) {
            details.sameSite = c.sameSite
          }
          const set = await ses.cookies.set(details).then(
            () => true,
            () => false
          )
          ok &&= set
        }
        if (!ok) failed.add(e)
        all &&= ok
      }
      // the sets' 'changed' events deliver asynchronously — hold the guard
      // until they have had their turn
      await new Promise((r) => setTimeout(r, 250))
    } finally {
      this.restoring.delete(domain)
    }
    // only consume what actually came back; a failed entry stays undoable
    this.stash.data.entries = this.stash.data.entries.filter(
      (e) => e.domain !== domain || failed.has(e)
    )
    this.stash.save()
    return all
  }

  stashDelete(domain: string): void {
    this.stash.data.entries = this.stash.data.entries.filter((e) => e.domain !== domain)
    this.stash.save()
  }

  clearStash(): void {
    this.stash.data.entries = []
    this.stash.saveNow()
  }
}

export const harbor = new Harbor()
