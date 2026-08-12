import { clipboard, safeStorage, systemPreferences } from 'electron'
import type { PasswordMeta, PasswordsStatus } from '@shared/types'
import { JsonFile, genId } from './stores'

/**
 * Local password vault.
 *
 * - Username AND password are encrypted at rest via safeStorage (macOS Keychain-
 *   backed AES key); only the origin/host stay cleartext for lookups.
 * - Autofill matches on exact origin (scheme+host+port) — never lookalikes.
 * - Per-profile MRU: each entry remembers when it was last used per session
 *   partition, so a school space and a home space each autofill their own account.
 * - No query API is ever exposed to web content; fills are pushed by main.
 */

interface VaultEntry {
  id: string
  origin: string
  host: string
  usernameEnc: string
  passwordEnc: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
  timesUsed: number
  /** partition -> last used timestamp */
  profileLastUsed: Record<string, number>
}

interface PasswordsFile {
  v: 1
  entries: VaultEntry[]
  /** origins the user said never to ask about */
  neverSave: string[]
}

interface PendingOffer {
  offerId: string
  origin: string
  host: string
  username: string
  password: string
  kind: 'new' | 'update'
  tabId: number
  partition: string
  expires: number
}

const OFFER_TTL = 5 * 60 * 1000

function enc(value: string): string {
  return safeStorage.encryptString(value).toString('base64')
}

function dec(value: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return ''
  }
}

class PasswordVault {
  private file: JsonFile<PasswordsFile> | null = null
  /** keyed by `${origin}|${username}` so a second submit replaces the first */
  private pendingOffers = new Map<string, PendingOffer>()

  private get data(): PasswordsFile {
    if (!this.file) {
      this.file = new JsonFile<PasswordsFile>(
        'passwords.json',
        { v: 1, entries: [], neverSave: [] },
        { mode: 0o600 }
      )
    }
    return this.file.data
  }

  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  status(): PasswordsStatus {
    let canTouchId = false
    try {
      canTouchId = systemPreferences.canPromptTouchID()
    } catch {
      /* not macOS or unavailable */
    }
    return { available: this.available(), canTouchId }
  }

  private save(): void {
    this.file?.save()
  }

  private findForOrigin(origin: string): VaultEntry[] {
    return this.data.entries.filter((e) => e.origin === origin)
  }

  /** Best credential to autofill for an origin within a given profile partition. */
  pickForFill(origin: string, partition: string): { username: string; password: string; id: string } | null {
    if (!this.available()) return null
    const entries = this.findForOrigin(origin)
    if (!entries.length) return null
    const byProfile = entries
      .filter((e) => e.profileLastUsed[partition])
      .sort((a, b) => (b.profileLastUsed[partition] ?? 0) - (a.profileLastUsed[partition] ?? 0))
    const pick = byProfile[0] ?? entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
    return { id: pick.id, username: dec(pick.usernameEnc), password: dec(pick.passwordEnc) }
  }

  private markUsed(id: string, partition: string): void {
    const e = this.data.entries.find((x) => x.id === id)
    if (!e) return
    const now = Date.now()
    e.lastUsedAt = now
    e.timesUsed += 1
    e.profileLastUsed[partition] = now
    this.save()
  }

  /**
   * Evaluate a submitted credential. Returns a pending offer when the chrome
   * should ask to save/update, or null when nothing needs to happen.
   */
  considerCandidate(
    origin: string,
    host: string,
    username: string,
    password: string,
    tabId: number,
    partition: string
  ): PendingOffer | null {
    if (!this.available()) return null
    if (this.data.neverSave.includes(origin)) return null
    const existing = this.findForOrigin(origin).find((e) => dec(e.usernameEnc) === username)
    if (existing) {
      if (dec(existing.passwordEnc) === password) {
        this.markUsed(existing.id, partition)
        return null
      }
      return this.stageOffer({ origin, host, username, password, kind: 'update', tabId, partition })
    }
    return this.stageOffer({ origin, host, username, password, kind: 'new', tabId, partition })
  }

  private stageOffer(o: Omit<PendingOffer, 'offerId' | 'expires'>): PendingOffer {
    this.prunePending()
    const offer: PendingOffer = { ...o, offerId: genId(), expires: Date.now() + OFFER_TTL }
    this.pendingOffers.set(`${o.origin}|${o.username}`, offer)
    return offer
  }

  private prunePending(): void {
    const now = Date.now()
    for (const [k, o] of this.pendingOffers) {
      if (o.expires < now) this.pendingOffers.delete(k)
    }
  }

  resolveOffer(offerId: string, action: 'save' | 'never' | 'dismiss'): void {
    this.prunePending()
    const key = [...this.pendingOffers.entries()].find(([, o]) => o.offerId === offerId)?.[0]
    if (!key) return
    const offer = this.pendingOffers.get(key)!
    const partition = offer.partition
    this.pendingOffers.delete(key)
    if (action === 'never') {
      if (!this.data.neverSave.includes(offer.origin)) {
        this.data.neverSave.push(offer.origin)
        this.save()
      }
      return
    }
    if (action !== 'save') return
    const now = Date.now()
    const existing = this.findForOrigin(offer.origin).find((e) => dec(e.usernameEnc) === offer.username)
    if (existing) {
      existing.passwordEnc = enc(offer.password)
      existing.updatedAt = now
      existing.lastUsedAt = now
      existing.profileLastUsed[partition] = now
    } else {
      this.data.entries.push({
        id: genId(),
        origin: offer.origin,
        host: offer.host,
        usernameEnc: enc(offer.username),
        passwordEnc: enc(offer.password),
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
        timesUsed: 1,
        profileLastUsed: { [partition]: now }
      })
    }
    this.save()
  }

  list(): PasswordMeta[] {
    if (!this.available()) return []
    return this.data.entries
      .map((e) => ({
        id: e.id,
        origin: e.origin,
        host: e.host,
        username: dec(e.usernameEnc),
        createdAt: e.createdAt,
        lastUsedAt: e.lastUsedAt
      }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  /** Reveal gated behind Touch ID when available; a null return means denied/unavailable. */
  async reveal(id: string): Promise<string | null> {
    const e = this.data.entries.find((x) => x.id === id)
    if (!e || !this.available()) return null
    if (!(await this.authorize('reveal the saved password'))) return null
    return dec(e.passwordEnc)
  }

  /** Copy without the password ever entering a renderer. */
  async copy(id: string): Promise<boolean> {
    const e = this.data.entries.find((x) => x.id === id)
    if (!e || !this.available()) return false
    if (!(await this.authorize('copy the saved password'))) return false
    clipboard.writeText(dec(e.passwordEnc))
    setTimeout(() => {
      // Best-effort clipboard clear if it still holds our value
      if (clipboard.readText() === dec(e.passwordEnc)) clipboard.writeText('')
    }, 45_000)
    return true
  }

  private async authorize(reason: string): Promise<boolean> {
    try {
      if (systemPreferences.canPromptTouchID()) {
        await systemPreferences.promptTouchID(reason)
        return true
      }
    } catch {
      return false
    }
    // No biometrics on this machine: shoulder-surf friction only, allow through.
    return true
  }

  delete(id: string): void {
    const before = this.data.entries.length
    this.data.entries = this.data.entries.filter((e) => e.id !== id)
    if (this.data.entries.length !== before) this.save()
  }

  neverList(): string[] {
    return [...this.data.neverSave]
  }

  removeNever(origin: string): void {
    this.data.neverSave = this.data.neverSave.filter((o) => o !== origin)
    this.save()
  }

  flush(): void {
    this.file?.saveNow()
  }
}

export const passwordVault = new PasswordVault()
