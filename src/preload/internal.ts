/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { contextBridge, ipcRenderer } from 'electron'
import type { OffshoreInternalApi } from '@shared/bridge'
import { SLOP_BLOCK_TIERS } from '@shared/types'
import { initPageEdit, slopMarksChanged } from './pageedit'

/**
 * Preload attached to every tab (and tracked popup). Four concerns:
 *
 * 1. The privileged offshoreInternal bridge — exposed ONLY on Offshore's own
 *    pages (offshore:// in prod, the exact dev-server origin in dev). Main
 *    re-verifies the sender frame on every call; this gate is defense in depth.
 * 2. Gesture pings — feed the popup blocker's transient-activation model.
 * 3. Password capture + autofill — credentials only ever travel over dedicated
 *    channels that main validates against the sender frame's real origin.
 * 4. The page editor (see pageedit.ts) — dormant until main flips it on.
 */

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

// ---------------- 1. privileged bridge (internal pages only) ----------------

const devOrigin =
  process.argv.find((a) => a.startsWith('--offshore-dev-origin='))?.split('=')[1] ?? ''

function isInternalDocument(): boolean {
  if (location.protocol === 'offshore:') return true
  if (devOrigin) {
    try {
      return location.origin === devOrigin
    } catch {
      return false
    }
  }
  return false
}

const api: OffshoreInternalApi = {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch: unknown) => invoke('settings:set', patch)
  },
  bookmarks: {
    list: () => invoke('bookmarks:list'),
    addFolder: (title: string, parentId: string | null) =>
      invoke('bookmarks:add-folder', title, parentId),
    update: (id: string, patch: { title?: string; url?: string }) =>
      invoke('bookmarks:update', id, patch),
    remove: (id: string) => invoke('bookmarks:remove', id)
  },
  extensions: {
    list: () => invoke('extensions:list'),
    uninstall: (id: string) => invoke('extensions:uninstall', id)
  },
  passwords: {
    status: () => invoke('passwords:status'),
    list: () => invoke('passwords:list'),
    reveal: (id: string) => invoke('passwords:reveal', id),
    copy: (id: string) => invoke('passwords:copy', id),
    delete: (id: string) => invoke('passwords:delete', id),
    neverList: () => invoke('passwords:never-list'),
    removeNever: (origin: string) => invoke('passwords:remove-never', origin)
  },
  brief: {
    weather: () => invoke('brief:weather'),
    geocode: (q: string) => invoke('brief:geocode', q)
  },
  history: {
    clear: () => invoke('history:clear')
  },
  pageEdits: {
    list: () => invoke('pageedit:list'),
    clear: (host: string) => invoke('pageedit:clear-host', host),
    setEnabled: (host: string, on: boolean) => invoke('pageedit:set-host-enabled', host, on)
  },
  privacy: {
    clearSiteData: () => invoke('privacy:clear-site-data')
  },
  app: {
    info: () => invoke('app:info')
  },
  open: (url: string) => invoke('internal:open', url),
  /** Fires when the chrome asks the new-tab page to enter widget edit mode. */
  onEditWidgets: (cb: () => void) => {
    ipcRenderer.on('widgets:edit', () => cb())
  },
  /**
   * The home screen's search panel. The page says when it has been dismissed so
   * the sidebar's New Tab row can stop pretending to be a tab, and listens for
   * the same news travelling the other way (the ✕ in the chrome).
   */
  home: {
    setSearch: (open: boolean) => invoke('home:set-search', open),
    onSearch: (cb: (open: boolean) => void) => {
      ipcRenderer.on('home:search', (_e, open: boolean) => cb(!!open))
    },
    /**
     * "There is something on screen now." A new tab is swapped in on this, not
     * on the document being parsed — the document is parsed while the page is
     * still blank, and swapping then is what flashes the backdrop at you.
     */
    painted: () => ipcRenderer.send('home:painted'),
    /** What the omnibox would offer for the same half-typed word. */
    suggest: (input: string) => invoke('home:suggest', input)
  }
}

if (isInternalDocument()) {
  contextBridge.exposeInMainWorld('offshoreInternal', api)
} else if (/^https?:$/.test(location.protocol)) {
  // real pages get the editor; Offshore's own pages have widgets instead
  initPageEdit()
}

// ---------------- 2. gesture pings (popup blocker) ----------------

let lastPing = 0
function ping(): void {
  const t = Date.now()
  if (t - lastPing > 400) {
    lastPing = t
    ipcRenderer.send('gesture:activity')
  }
}
window.addEventListener('pointerdown', ping, { capture: true, passive: true })
window.addEventListener('keydown', ping, { capture: true, passive: true })

// ---------------- 3. password capture + autofill ----------------

interface Candidate {
  username: string
  password: string
  capturedAt: number
}

let lastCandidate: Candidate | null = null
let lastEditedPassword: HTMLInputElement | null = null
let sentRecently = 0

function isOtp(el: HTMLInputElement): boolean {
  if ((el.autocomplete || '').includes('one-time-code')) return true
  return /\b(otp|2fa|totp|mfa|code)\b/i.test(`${el.name} ${el.id}`)
}

function visible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el.getClientRects().length > 0
}

/**
 * The field most likely holding the username for a password input: prefer
 * fields before it in the document, then ones whose name/autocomplete says so.
 * Capture wants a field with a value in it; fill wants one whether or not the
 * user typed anything yet — the same walk otherwise, so it lives here once.
 */
function usernameFor(pw: HTMLInputElement, requireValue: boolean): HTMLInputElement | null {
  const scope: ParentNode = pw.form ?? document
  const cands = [...scope.querySelectorAll<HTMLInputElement>(
    'input[type=text], input[type=email], input[type=tel], input:not([type])'
  )].filter((el) => visible(el) && (!requireValue || el.value))
  if (!cands.length) return null
  const before = cands.filter(
    (el) => pw.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING
  )
  const pool = before.length ? before : cands
  const preferred = pool.filter(
    (el) =>
      /username|email/.test(el.autocomplete || '') ||
      /user|email|login|acct|account|id/i.test(`${el.name} ${el.id}`)
  )
  const list = preferred.length ? preferred : pool
  return list[list.length - 1] ?? null
}

function currentPasswordField(): HTMLInputElement | null {
  if (lastEditedPassword && lastEditedPassword.isConnected && lastEditedPassword.value) {
    return lastEditedPassword
  }
  const pws = [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].filter(
    (el) => visible(el) && el.value && !isOtp(el)
  )
  return pws[pws.length - 1] ?? null
}

function snapshot(): void {
  const pw = currentPasswordField()
  if (!pw || isOtp(pw)) return
  if (!pw.value || pw.value.length > 512) return
  const user = usernameFor(pw, true)
  lastCandidate = {
    username: (user?.value ?? '').slice(0, 256),
    password: pw.value,
    capturedAt: Date.now()
  }
}

function submitCandidate(): void {
  if (!lastCandidate) return
  const now = Date.now()
  if (now - sentRecently < 2000) return
  if (now - lastCandidate.capturedAt > 30_000) return
  sentRecently = now
  ipcRenderer.send('passwords:candidate', {
    username: lastCandidate.username,
    password: lastCandidate.password
  })
}

document.addEventListener(
  'input',
  (e) => {
    const t = e.target as HTMLInputElement | null
    if (t && t.tagName === 'INPUT' && t.type === 'password' && t.value) {
      lastEditedPassword = t
    }
  },
  { capture: true, passive: true }
)

document.addEventListener(
  'submit',
  (e) => {
    const form = e.target as HTMLFormElement | null
    if (form && form.querySelector?.('input[type=password]')) {
      snapshot()
      submitCandidate()
    }
  },
  { capture: true, passive: true }
)

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Enter') return
    const t = e.target as HTMLElement | null
    if (!t) return
    const inPasswordContext =
      (t as HTMLInputElement).type === 'password' ||
      !!t.closest?.('form')?.querySelector?.('input[type=password]')
    if (inPasswordContext) {
      // Snapshot before frameworks clear the fields, send shortly after
      snapshot()
      setTimeout(submitCandidate, 150)
    }
  },
  { capture: true, passive: true }
)

document.addEventListener(
  'pointerdown',
  () => {
    // SPA logins: a click may fire the request with no form submit at all.
    // Snapshot whenever a non-empty password field exists at click time.
    if (currentPasswordField()) {
      snapshot()
      setTimeout(submitCandidate, 400)
    }
  },
  { capture: true, passive: true }
)

window.addEventListener('beforeunload', () => {
  if (lastCandidate && Date.now() - lastCandidate.capturedAt < 30_000) submitCandidate()
})

// ---- autofill ----

function setNative(el: HTMLInputElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

ipcRenderer.on('passwords:fill', (_e, creds: { username?: string; password?: string }) => {
  const username = String(creds?.username ?? '')
  const password = String(creds?.password ?? '')
  if (!password) return

  const tryFill = (): boolean => {
    const pw = [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].find(
      (el) => visible(el) && !isOtp(el) && el.value === ''
    )
    if (!pw) return false
    const user = usernameFor(pw, false)
    if (user && username && user.value === '') setNative(user, username)
    setNative(pw, password)
    return true
  }

  if (tryFill()) return
  // Client-rendered login forms: watch for the fields to appear
  const observer = new MutationObserver(() => {
    if (tryFill()) observer.disconnect()
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  setTimeout(() => observer.disconnect(), 15_000)
})


// ---------------- 4. AI-slop detector (pure heuristics, zero AI, zero network) ----------------
//
// Offshore's core promise is the web without slop. This is deliberately NOT a
// model: it's a deterministic prose scan for the tells of machine-generated
// filler — stock phrases, formulaic transitions, uniform structure. It runs
// locally on at most ~20k characters and reports a 0–100 score with its
// receipts (which tells, how many) to main, which owns what happens next: a
// chip in the address bar, and for heavy pages a veil main asks this preload
// to raise. Nothing leaves the machine.

// Straight-apostrophe forms only — the text is normalized before matching.
const SLOP_PHRASES = [
  'delve into',
  'delving into',
  "let's dive in",
  'dive deep into',
  'deep dive into',
  "in today's fast-paced",
  'ever-evolving landscape',
  'ever-evolving world',
  'ever-changing landscape',
  'digital landscape',
  'navigate the complexities',
  'navigating the complexities',
  'unlock the potential',
  'unlock the power',
  'unleash the',
  'game-changer',
  'game changer',
  'revolutionize the way',
  'seamlessly integrate',
  'seamless integration',
  'elevate your',
  'embark on a journey',
  'embark on this journey',
  'a testament to',
  'stands as a testament',
  'rich tapestry',
  'vibrant tapestry',
  'treasure trove',
  'a myriad of',
  'a plethora of',
  'beacon of',
  'holistic approach',
  'leverage the power',
  'harness the power',
  "it's important to note",
  "it's worth noting",
  'it is important to note',
  'it is worth noting',
  'in conclusion,',
  'in summary,',
  'to sum up,',
  'at the end of the day',
  'when it comes to',
  'in the realm of',
  'in the world of',
  'look no further',
  'crucial role in',
  'pivotal role in',
  'plays a vital role',
  'cannot be overstated',
  'significant strides',
  'comprehensive guide',
  'ultimate guide',
  "let's explore",
  "let's take a closer look",
  "it's no secret that",
  'without further ado',
  'in this article, we',
  'in this blog post',
  "whether you're a",
  'so, what are you waiting for',
  'say goodbye to',
  "we've got you covered",
  "you've come to the right place",
  'to the next level',
  'the bottom line is',
  'in this day and age',
  'actionable insights',
  'nestled in',
  'bustling',
  'boasts a',
  'must-visit',
  'hidden gem',
  'the possibilities are endless'
]

const SLOP_STARTERS =
  /(^|[.!?]\s+)(However|Moreover|Furthermore|Additionally|Overall|Ultimately|Importantly|Notably|Firstly|Secondly|Lastly|In essence|In short)[, ]/g

/** Headings machine articles reach for on the way out the door. */
const SLOP_HEADINGS =
  /^(in\s+)?(conclusion|final thoughts|key takeaways|the bottom line|wrapping (it\s+)?up|in a nutshell|summing up)\b/i

interface ProseBlock {
  el: HTMLElement
  text: string
  words: number
}

interface ProseSample {
  text: string
  words: number
  /** word count of each paragraph, for the uniformity check */
  paraWords: number[]
  /** the prose elements themselves, for the block-by-block wash */
  blocks: ProseBlock[]
  scope: ParentNode
}

function collectProse(): ProseSample | null {
  const roots = document.querySelectorAll('article, main, [role="main"]')
  const scope: ParentNode = roots.length ? roots[0] : document.body
  if (!scope) return null
  const parts: string[] = []
  const paraWords: number[] = []
  const blocks: ProseBlock[] = []
  let total = 0
  for (const p of scope.querySelectorAll('p, li, h2, h3, blockquote')) {
    const t = (p as HTMLElement).innerText
    if (!t || t.length < 30) continue
    parts.push(t)
    const words = t.split(/\s+/).length
    if (p.tagName === 'P') paraWords.push(words)
    // only real prose runs get washed — a heading or stub line never does,
    // and a list item only counts through its own text, not its sublist's
    if (p.tagName !== 'H2' && p.tagName !== 'H3' && words >= 20) {
      blocks.push({ el: p as HTMLElement, text: t, words })
    }
    total += t.length
    if (total > 20_000) break
  }
  const text = parts.join('\n')
  return { text, words: text ? text.split(/\s+/).length : 0, paraWords, blocks, scope }
}

interface WeighedSignal {
  label: string
  count: number
  weight: number
}

function scoreSlop(sample: ProseSample): { score: number; signals: { label: string; count: number }[] } {
  const { text, words, paraWords, scope } = sample
  const lower = text.toLowerCase().replace(/[’‘]/g, "'")
  const per1k = 1000 / words
  const signals: WeighedSignal[] = []

  // -- the prose itself --
  let hits = 0
  for (const phrase of SLOP_PHRASES) {
    let idx = lower.indexOf(phrase)
    let count = 0
    while (idx !== -1 && count < 4) {
      count += 1
      idx = lower.indexOf(phrase, idx + phrase.length)
    }
    if (count > 0) {
      hits += count
      signals.push({ label: `“${phrase.replace(/,$/, '')}”`, count, weight: count * 9 * per1k })
    }
  }
  const starters = (text.match(SLOP_STARTERS) ?? []).length
  if (starters > 2) {
    signals.push({
      label: 'formulaic transitions (However, Moreover…)',
      count: starters,
      weight: (starters - 2) * 3.5 * per1k
    })
  }
  const notOnly = (lower.match(/not only\b[\s\S]{0,80}?\bbut also\b/g) ?? []).length
  if (notOnly > 0) {
    signals.push({ label: 'not only … but also', count: notOnly, weight: notOnly * 8 * per1k })
  }
  const emDashes = (text.match(/—/g) ?? []).length
  const emWeight = Math.max(0, emDashes * per1k - 3) * 1.2
  if (emWeight > 0) signals.push({ label: 'em-dash habit', count: emDashes, weight: emWeight })

  // -- the shape of the piece --
  let structural = 0
  let closers = 0
  let emojiHeads = 0
  for (const h of scope.querySelectorAll('h2, h3')) {
    const t = ((h as HTMLElement).innerText ?? '').trim()
    if (SLOP_HEADINGS.test(t)) closers += 1
    if (/^\p{Extended_Pictographic}/u.test(t)) emojiHeads += 1
  }
  if (closers > 0) {
    const w = Math.min(10, closers * 5)
    structural += w
    signals.push({ label: 'conclusion-shaped headings', count: closers, weight: w })
  }
  if (emojiHeads >= 3) {
    const w = Math.min(10, emojiHeads * 2)
    structural += w
    signals.push({ label: 'emoji-headed sections', count: emojiHeads, weight: w })
  }
  const boldLed = scope.querySelectorAll('li > strong:first-child, li > b:first-child').length
  if (boldLed >= 4) {
    structural += 7
    signals.push({ label: 'boldface listicle', count: boldLed, weight: 7 })
  }
  if (paraWords.length >= 8) {
    const mean = paraWords.reduce((a, b) => a + b, 0) / paraWords.length
    const sd = Math.sqrt(paraWords.reduce((a, b) => a + (b - mean) ** 2, 0) / paraWords.length)
    if (mean > 20 && sd / mean < 0.32) {
      structural += 8
      signals.push({ label: 'uniform paragraph rhythm', count: paraWords.length, weight: 8 })
    }
  }

  const density =
    hits * 9 * per1k +
    Math.max(0, starters - 2) * 3.5 * per1k +
    notOnly * 8 * per1k +
    emWeight
  const score = Math.round(Math.min(100, density + structural))
  signals.sort((a, b) => b.weight - a.weight)
  return { score, signals: signals.slice(0, 8).map(({ label, count }) => ({ label, count })) }
}

// ---- the wash: flagged prose wears its score, block by block ----
//
// The page-level verdict says "this page reads like filler"; the wash says
// *which sentences*. Each prose block is scored alone and tinted yellow →
// orange → red by how hard it leans on the tells. The tint is a low-alpha
// background written through the CSSOM (page CSP never gets a say), and the
// mark is a data attribute the Page Cleaner's Clean mode hides by.

const SLOP_MARK = 'data-offshore-slop'
const TIER_WASH: Record<string, string> = {
  yellow: 'rgba(250, 204, 21, 0.16)',
  orange: 'rgba(249, 115, 22, 0.16)',
  red: 'rgba(239, 68, 68, 0.17)'
}

/** What main says the settings want: mark at all (detector), tint the marks. */
let slopStyle = { mark: true, tint: true }
const washed = new Map<HTMLElement, { bg: string; priority: string }>()

/**
 * A block's score runs on a different scale from the page's: hits per hundred
 * words, not per thousand, tuned so one stock phrase in an honest paragraph
 * stays unmarked, two make yellow, and a paragraph built out of the phrasebook
 * goes red. The floor keeps a short block from riding one phrase into a tier.
 */
function scoreBlock(block: ProseBlock): number {
  const lower = block.text.toLowerCase().replace(/[’‘]/g, "'")
  const per100 = 100 / Math.max(block.words, 80)
  let hits = 0
  for (const phrase of SLOP_PHRASES) {
    let idx = lower.indexOf(phrase)
    let count = 0
    while (idx !== -1 && count < 4) {
      count += 1
      idx = lower.indexOf(phrase, idx + phrase.length)
    }
    hits += count
  }
  const starters = (block.text.match(SLOP_STARTERS) ?? []).length
  const notOnly = (lower.match(/not only\b[\s\S]{0,80}?\bbut also\b/g) ?? []).length
  return Math.round(Math.min(100, hits * 25 * per100 + starters * 8 * per100 + notOnly * 20 * per100))
}

function tintOne(el: HTMLElement): void {
  if (washed.has(el)) return
  washed.set(el, {
    bg: el.style.getPropertyValue('background-color'),
    priority: el.style.getPropertyPriority('background-color')
  })
  const tier = el.getAttribute(SLOP_MARK) ?? 'yellow'
  el.style.setProperty('background-color', TIER_WASH[tier] ?? TIER_WASH.yellow, 'important')
}

function untintOne(el: HTMLElement): void {
  const saved = washed.get(el)
  if (!saved) return
  washed.delete(el)
  if (saved.bg) el.style.setProperty('background-color', saved.bg, saved.priority)
  else el.style.removeProperty('background-color')
}

/** Score each block, wear the marks, and tint them if the settings say so. */
function washBlocks(blocks: ProseBlock[]): void {
  const flagged = new Set<HTMLElement>()
  if (slopStyle.mark) {
    for (const block of blocks) {
      const s = scoreBlock(block)
      const tier = SLOP_BLOCK_TIERS.find((t) => s >= t.min)
      if (!tier) continue
      flagged.add(block.el)
      block.el.setAttribute(SLOP_MARK, tier.tier)
      if (slopStyle.tint) tintOne(block.el)
      else untintOne(block.el)
    }
  }
  // marks from the last pass that didn't survive this one come off entirely
  for (const el of document.querySelectorAll<HTMLElement>(`[${SLOP_MARK}]`)) {
    if (flagged.has(el)) continue
    untintOne(el)
    el.removeAttribute(SLOP_MARK)
  }
  // Clean mode hides by these marks — tell it the ground shifted
  slopMarksChanged()
}

ipcRenderer.on('slop:style', (_e, style: { mark?: boolean; tint?: boolean }) => {
  const next = { mark: style?.mark !== false, tint: style?.tint !== false }
  const changed = next.mark !== slopStyle.mark || next.tint !== slopStyle.tint
  slopStyle = next
  // flipping a switch takes effect on the page you're looking at, not the next one
  if (changed) {
    if (!slopStyle.mark) washBlocks([])
    else runSlopScan(0)
  }
})

let slopRetry: ReturnType<typeof setTimeout> | null = null
function runSlopScan(retriesLeft = 2): void {
  if (!/^https?:$/.test(location.protocol) || isInternalDocument()) return
  try {
    const sample = collectProse()
    if (!sample || sample.words < 150) {
      // client-rendered pages fill in late — look again shortly, then let it go
      if (retriesLeft > 0) {
        if (slopRetry) clearTimeout(slopRetry)
        slopRetry = setTimeout(() => runSlopScan(retriesLeft - 1), 1600)
      }
      return
    }
    const { score, signals } = scoreSlop(sample)
    washBlocks(sample.blocks)
    ipcRenderer.send('slop:report', { score, words: sample.words, signals })
  } catch {
    /* scoring must never break a page */
  }
}

if (document.readyState === 'complete') {
  setTimeout(() => runSlopScan(), 700)
} else {
  window.addEventListener('load', () => setTimeout(() => runSlopScan(), 700), { once: true })
}

// Main hears about in-page navigations (SPA route changes) and asks for a
// fresh verdict; the old one stands until the new one lands, so an anchor
// jump never flickers the chip.
let slopRescan: ReturnType<typeof setTimeout> | null = null
ipcRenderer.on('slop:rescan', () => {
  if (slopRescan) clearTimeout(slopRescan)
  slopRescan = setTimeout(() => runSlopScan(), 1000)
})

// ---------------- 5. the veil (raised over heavy slop, on main's say-so) ----------------
//
// "So you don't read it before you know" — the page loads, the scan reports,
// and if the score clears the veil line main sends 'slop:veil'. The page blurs
// behind a small card: read anyway, or spare the site forever. The overlay is
// a courtesy, not a boundary — any page script could remove it, which is fine,
// because the reader it serves is the one in front of the window.

let veilHost: HTMLElement | null = null

function dropVeil(): void {
  veilHost?.remove()
  veilHost = null
}

function raiseVeil(score: number): void {
  if (veilHost || !document.documentElement) return
  const host = document.createElement('div')
  host.id = 'offshore-slop-veil'
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      .scrim {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(240, 246, 248, 0.55);
        backdrop-filter: blur(22px) saturate(0.8);
        -webkit-backdrop-filter: blur(22px) saturate(0.8);
        animation: veil-in 240ms ease-out;
      }
      .card {
        box-sizing: border-box;
        max-width: 440px;
        padding: 30px 32px 24px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.88);
        border: 0.5px solid rgba(9, 40, 54, 0.14);
        box-shadow: 0 24px 70px rgba(9, 40, 54, 0.22);
        color: #14323f;
        font-family: -apple-system, system-ui, sans-serif;
        text-align: center;
      }
      .glyph { color: #c98a3a; }
      h1 {
        margin: 10px 0 8px;
        font-family: ui-serif, Georgia, serif;
        font-weight: 500;
        font-size: 23px;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0 0 18px;
        font-size: 13px;
        line-height: 1.55;
        color: rgba(20, 50, 63, 0.72);
      }
      .row { display: flex; flex-direction: column; gap: 4px; align-items: center; }
      button {
        appearance: none;
        border: none;
        font: inherit;
        cursor: pointer;
        border-radius: 999px;
      }
      .read {
        padding: 9px 22px;
        font-size: 13.5px;
        font-weight: 600;
        color: #f4fafc;
        background: #14323f;
      }
      .read:hover { filter: brightness(1.18); }
      .allow {
        padding: 7px 14px;
        font-size: 12px;
        font-weight: 500;
        color: rgba(20, 50, 63, 0.6);
        background: transparent;
      }
      .allow:hover { color: rgba(20, 50, 63, 0.9); }
      .fine {
        margin: 14px 0 0;
        font-size: 11px;
        color: rgba(20, 50, 63, 0.45);
      }
      @media (prefers-color-scheme: dark) {
        .scrim { background: rgba(10, 18, 22, 0.6); }
        .card {
          background: rgba(24, 34, 40, 0.92);
          border-color: rgba(210, 235, 244, 0.14);
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
          color: #dcebf1;
        }
        p { color: rgba(220, 235, 241, 0.7); }
        .read { color: #10262f; background: #dcebf1; }
        .allow { color: rgba(220, 235, 241, 0.55); }
        .allow:hover { color: rgba(220, 235, 241, 0.9); }
        .fine { color: rgba(220, 235, 241, 0.4); }
      }
      @keyframes veil-in { from { opacity: 0; } }
    </style>
    <div class="scrim" role="dialog" aria-label="AI slop warning">
      <div class="card">
        <svg class="glyph" width="34" height="34" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 13c2-2.4 4-2.4 6 0s4 2.4 6 0" />
          <path d="M4 4l16 16" />
          <path d="M16 5.5l0.9 2.1 2.1 0.9-2.1 0.9-0.9 2.1-0.9-2.1-2.1-0.9 2.1-0.9z" />
        </svg>
        <h1>This page reads like AI slop</h1>
        <p>
          Slop score ${Math.round(score)}/100 — stock phrases and formula structure, counted
          by plain heuristics on this Mac. No AI involved, nothing sent anywhere.
        </p>
        <div class="row">
          <button class="read">Read anyway</button>
          <button class="allow">Always show this site</button>
        </div>
        <p class="fine">The veil has an off switch in Settings → Shield.</p>
      </div>
    </div>`
  const scrim = shadow.querySelector('.scrim') as HTMLElement
  // the page beneath must not scroll along while it is veiled
  scrim.addEventListener('wheel', (e) => e.preventDefault(), { passive: false })
  scrim.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false })
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dropVeil()
      ipcRenderer.send('slop:veil-lifted')
    }
  })
  shadow.querySelector('.read')?.addEventListener('click', () => {
    dropVeil()
    ipcRenderer.send('slop:veil-lifted')
  })
  shadow.querySelector('.allow')?.addEventListener('click', () => {
    dropVeil()
    ipcRenderer.send('slop:allow-site')
  })
  document.documentElement.appendChild(host)
  veilHost = host
  ;(shadow.querySelector('.read') as HTMLElement | null)?.focus()
}

ipcRenderer.on('slop:veil', (_e, on: boolean, score?: number) => {
  try {
    if (on) raiseVeil(Number(score) || 0)
    else dropVeil()
  } catch {
    /* the veil must never break a page either */
  }
})
