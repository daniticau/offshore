/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload attached to every tab (and tracked popup). Three concerns:
 *
 * 1. The privileged offshoreInternal bridge — exposed ONLY on Offshore's own
 *    pages (offshore:// in prod, the exact dev-server origin in dev). Main
 *    re-verifies the sender frame on every call; this gate is defense in depth.
 * 2. Gesture pings — feed the popup blocker's transient-activation model.
 * 3. Password capture + autofill — credentials only ever travel over dedicated
 *    channels that main validates against the sender frame's real origin.
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

const api = {
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
    move: (id: string, parentId: string | null, index: number) =>
      invoke('bookmarks:move', id, parentId, index),
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
    painted: () => ipcRenderer.send('home:painted')
  }
}

if (isInternalDocument()) {
  contextBridge.exposeInMainWorld('offshoreInternal', api)
}

export type OffshoreInternalApi = typeof api

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

function usernameFor(pw: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = pw.form ?? document
  const cands = [...scope.querySelectorAll<HTMLInputElement>(
    'input[type=text], input[type=email], input[type=tel], input:not([type])'
  )].filter((el) => visible(el) && el.value)
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
  const user = usernameFor(pw)
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
    const user = (() => {
      const scope: ParentNode = pw.form ?? document
      const cands = [...scope.querySelectorAll<HTMLInputElement>(
        'input[type=text], input[type=email], input[type=tel], input:not([type])'
      )].filter((el) => visible(el))
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
    })()
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
// once per page, locally, on at most ~20k characters, and reports a 0–100
// score to the chrome, which shows a tiny badge. Nothing leaves the machine.

const SLOP_PHRASES = [
  'delve into',
  'delving into',
  "let's dive in",
  'dive deep into',
  'deep dive into',
  'in today’s fast-paced',
  "in today's fast-paced",
  'ever-evolving landscape',
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
  'it’s important to note',
  "it's important to note",
  'it’s worth noting',
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
  'significant strides',
  'comprehensive guide',
  'ultimate guide',
  'let’s explore',
  "let's explore",
  'without further ado',
  'in this article, we',
  'in this blog post',
  'whether you’re a',
  "whether you're a",
  'so, what are you waiting for',
  'nestled in',
  'bustling',
  'boasts a',
  'must-visit',
  'hidden gem',
  'the possibilities are endless'
]

const SLOP_STARTERS =
  /(^|[.!?]\s+)(However|Moreover|Furthermore|Additionally|Overall|Ultimately|Importantly|Notably|Firstly|Secondly|Lastly|In essence|In short)[, ]/g

function collectProse(): string {
  const roots = document.querySelectorAll('article, main, [role="main"]')
  const scope: ParentNode = roots.length ? roots[0] : document.body
  if (!scope) return ''
  const parts: string[] = []
  let total = 0
  for (const p of scope.querySelectorAll('p, li, h2, h3')) {
    const t = (p as HTMLElement).innerText
    if (!t || t.length < 30) continue
    parts.push(t)
    total += t.length
    if (total > 20_000) break
  }
  return parts.join('\n')
}

function scoreSlop(text: string): { score: number; signals: string[] } {
  const words = text.split(/\s+/).length
  if (words < 150) return { score: 0, signals: [] }
  const lower = text.toLowerCase()
  const signals: string[] = []
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
      if (signals.length < 6) signals.push(phrase.trim())
    }
  }
  const starters = (text.match(SLOP_STARTERS) ?? []).length
  const notOnly = (lower.match(/not only\b[\s\S]{0,80}?\bbut also\b/g) ?? []).length
  const emDashes = (text.match(/—/g) ?? []).length
  const per1k = 1000 / words
  const density =
    hits * 9 * per1k + Math.max(0, starters - 2) * 3.5 * per1k + notOnly * 8 * per1k + Math.max(0, emDashes * per1k - 3) * 1.2
  const score = Math.round(Math.min(100, density * 10))
  return { score, signals }
}

function runSlopScan(): void {
  if (!/^https?:$/.test(location.protocol)) return
  try {
    const { score, signals } = scoreSlop(collectProse())
    if (score >= 25) ipcRenderer.send('slop:report', { score, signals })
  } catch {
    /* scoring must never break a page */
  }
}

if (document.readyState === 'complete') {
  setTimeout(runSlopScan, 1200)
} else {
  window.addEventListener('load', () => setTimeout(runSlopScan, 1200), { once: true })
}
