/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { contextBridge, ipcRenderer } from 'electron'
import type { OffshoreInternalApi } from '@shared/bridge'
import { SLOP_BLOCK_TIERS } from '@shared/types'
import { initFocus } from './focus'

/**
 * Preload attached to every tab (and tracked popup). Four concerns:
 *
 * 1. The privileged offshoreInternal bridge — exposed ONLY on Offshore's own
 *    pages (offshore:// in prod, the exact dev-server origin in dev). Main
 *    re-verifies the sender frame on every call; this gate is defense in depth.
 * 2. Gesture pings — feed the popup blocker's transient-activation model.
 * 3. Password capture + autofill — credentials only ever travel over dedicated
 *    channels that main validates against the sender frame's real origin.
 * 4. The Focus engine (see focus.ts) — dormant until main flips it on.
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
  focus: {
    sites: () => invoke('focus:sites'),
    forget: (host: string) => invoke('focus:forget', host),
    forgetAll: () => invoke('focus:forget-all')
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
  // real pages get the Focus engine; Offshore's own pages have widgets instead
  initFocus()
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
// chip in the address bar, edge bars on the flagged blocks, and the site
// panel's verdict line. Nothing leaves the machine.

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
// *which sentences*. Each prose block is scored alone and barred yellow →
// orange → red by how hard it leans on the tells. The bar is a slim edge
// stripe painted as a background layer through the CSSOM (page CSP never gets
// a say), and the mark is a data attribute.

const SLOP_MARK = 'data-offshore-slop'
/**
 * Mid-tone warms that read on white and near-black pages alike. Alphas sit
 * below the spec'd start values: on zero-padding blocks the first glyph's
 * side bearing kisses the stripe, and softer paint keeps that a gutter
 * accent rather than a collision (the sanctioned dial — never width).
 */
const TIER_BAR: Record<string, string> = {
  yellow: 'rgba(212, 158, 66, 0.55)',
  orange: 'rgba(224, 122, 51, 0.68)',
  red: 'rgba(219, 68, 55, 0.8)'
}
/** The bar: a 3px stripe with soft-fading caps, painted as a background layer. */
function barImage(tier: string): string {
  const c = TIER_BAR[tier] ?? TIER_BAR.yellow
  return `linear-gradient(to bottom, transparent 0%, ${c} 12%, ${c} 88%, transparent 100%)`
}

/** What main says the settings want: mark at all (detector), bar the marks. */
let slopStyle = { mark: true, bars: true }

const BAR_PROPS = ['background-image', 'background-size', 'background-repeat', 'background-position'] as const
const barred = new Map<HTMLElement, Record<string, { value: string; priority: string }>>()

/**
 * Our paint, recognized by its own hand: the exact stripe geometry plus the
 * important priority no page inline style would carry. An SPA re-render can
 * clone a barred element — the clone arrives wearing the paint but unknown to
 * `barred`, and without this check the never-clobber rule below would mistake
 * our own bar for page art (or leave it stranded when the bars switch off).
 */
function wearsOurBar(el: HTMLElement): boolean {
  return (
    el.style.getPropertyValue('background-size') === '3px 100%' &&
    el.style.getPropertyPriority('background-image') === 'important' &&
    el.style.getPropertyValue('background-image').includes('linear-gradient')
  )
}

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

function barOne(el: HTMLElement): void {
  const tier = el.getAttribute(SLOP_MARK) ?? 'yellow'
  if (barred.has(el)) {
    // tier may have shifted on a rescan — repaint, priors already saved
    el.style.setProperty('background-image', barImage(tier), 'important')
    return
  }
  if (wearsOurBar(el)) {
    // a clone of a block we painted — adopt it; the original's priors died
    // with the original element, and we only ever paint over an empty layer
    const saved: Record<string, { value: string; priority: string }> = {}
    for (const p of BAR_PROPS) saved[p] = { value: '', priority: '' }
    barred.set(el, saved)
    el.style.setProperty('background-image', barImage(tier), 'important')
    return
  }
  // a block that brings its own background image keeps it — the mark alone
  // carries the verdict there (never clobber page art)
  if (getComputedStyle(el).backgroundImage !== 'none') return
  const saved: Record<string, { value: string; priority: string }> = {}
  for (const p of BAR_PROPS) {
    saved[p] = { value: el.style.getPropertyValue(p), priority: el.style.getPropertyPriority(p) }
  }
  barred.set(el, saved)
  const rtl = getComputedStyle(el).direction === 'rtl'
  el.style.setProperty('background-image', barImage(tier), 'important')
  el.style.setProperty('background-size', '3px 100%', 'important')
  el.style.setProperty('background-repeat', 'no-repeat', 'important')
  el.style.setProperty('background-position', rtl ? 'right top' : 'left top', 'important')
}

function unbarOne(el: HTMLElement): void {
  const saved = barred.get(el)
  if (!saved) {
    // a cloned bar we never painted ourselves — take it off wholesale
    if (wearsOurBar(el)) for (const p of BAR_PROPS) el.style.removeProperty(p)
    return
  }
  barred.delete(el)
  for (const p of BAR_PROPS) {
    if (saved[p].value) el.style.setProperty(p, saved[p].value, saved[p].priority)
    else el.style.removeProperty(p)
  }
}

/** Score each block, wear the marks, and bar them if the settings say so. */
function washBlocks(blocks: ProseBlock[]): { total: number; marked: number; heavy: number } {
  const flagged = new Set<HTMLElement>()
  let heavy = 0
  if (slopStyle.mark) {
    for (const block of blocks) {
      // nested prose (a flagged li's inner p, and vice versa) wears one bar, the
      // outermost — blocks arrive in document order, so ancestors are seen first
      if (block.el.parentElement?.closest(`[${SLOP_MARK}]`)) continue
      const s = scoreBlock(block)
      const tier = SLOP_BLOCK_TIERS.find((t) => s >= t.min)
      if (!tier) continue
      flagged.add(block.el)
      if (tier.tier === 'red') heavy += 1
      block.el.setAttribute(SLOP_MARK, tier.tier)
      if (slopStyle.bars) barOne(block.el)
      else unbarOne(block.el)
    }
  }
  // marks from the last pass that didn't survive this one come off entirely
  for (const el of document.querySelectorAll<HTMLElement>(`[${SLOP_MARK}]`)) {
    if (flagged.has(el)) continue
    unbarOne(el)
    el.removeAttribute(SLOP_MARK)
  }
  return { total: blocks.length, marked: flagged.size, heavy }
}

ipcRenderer.on('slop:style', (_e, style: { mark?: boolean; bars?: boolean }) => {
  const next = { mark: style?.mark !== false, bars: style?.bars !== false }
  const changed = next.mark !== slopStyle.mark || next.bars !== slopStyle.bars
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
    const blocks = washBlocks(sample.blocks)
    ipcRenderer.send('slop:report', { score, words: sample.words, signals, blocks })
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
