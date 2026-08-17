/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { ipcRenderer } from 'electron'

/**
 * The Focus engine: strip a page's distractions in place — ads, cookie nags,
 * sticky bars, comments, recommendation rails, autoplay — and compact the
 * layout so the hiding leaves no holes. One switch, flipped by main over
 * 'focus:apply'; per-site memory lives in src/main/focus.ts. No in-page UI.
 *
 * Two rules inherited from the retired page editor, restated because they are
 * the whole shape of the file:
 *
 * 1. No stylesheets. A <style> tag answers to the page's Content-Security-
 *    Policy; writing through the CSSOM (el.style.setProperty) does not. Every
 *    change is a property assignment, saved first, so off = the page we found.
 *
 * 2. Nothing is applied once. Pages re-render constantly, so sweeps are
 *    idempotent, debounced behind a MutationObserver, and re-asserted on a
 *    slow interval for pages that restyle without DOM churn.
 */

const MARK = 'data-offshore-focus' // 'hidden' | 'cascade' | 'restyled' | 'paused'
const SWEEP_DEBOUNCE = 240
const RESWEEP_INTERVAL = 4000
const MAX_HIDES_PER_SWEEP = 400

/** Structural signatures of ads, comments and rails — hidden on sight. */
const TIER1 = [
  'aside',
  '[role="complementary"]',
  'ins.adsbygoogle',
  '[data-ad-slot]',
  '[data-ad-client]',
  '[id^="div-gpt-ad"]',
  '[id^="google_ads"]',
  '[aria-label="advertisement" i]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication"]',
  'iframe[src*="adsystem"]',
  'iframe[src*="taboola.com"]',
  'iframe[src*="outbrain.com"]',
  '#comments',
  '#disqus_thread',
  '#respond'
].join(', ')

/**
 * Name-based candidates. The selector is only a fast prefilter — substring
 * alone hides "commentary" and "broadcast-header", which is exactly the bug
 * class the old cleaner's list had — so every match is token-verified below.
 */
const TIER2_PREFILTER = [
  '[class*="sidebar" i]',
  '[id*="sidebar" i]',
  '[class*="related" i]',
  '[class*="recommend" i]',
  '[class*="newsletter" i]',
  '[class*="subscribe" i]',
  '[class*="promo" i]',
  '[class*="sponsor" i]',
  '[class*="advert" i]',
  '[id*="advert" i]',
  '[class*="social" i]',
  '[class*="share" i]',
  '[class*="trending" i]',
  '[class*="popular" i]',
  '[class*="cookie" i]',
  '[id*="cookie" i]',
  '[class*="consent" i]',
  '[id*="consent" i]',
  '[class*="gdpr" i]',
  '[class*="comment" i]',
  '[id*="comment" i]',
  '[class*="taboola" i]',
  '[class*="outbrain" i]',
  '[class~="ad" i]',
  '[class~="ads" i]',
  '[class^="ad-" i]',
  '[class*=" ad-" i]',
  '[class$="-ad" i]',
  '[class*="-ad " i]',
  '[id^="ad-" i]'
].join(', ')

/**
 * Deliberately excluded: 'banner' (hero banners), 'popup'/'modal'/'overlay'
 * (login and lightbox flows — overlays are handled geometrically in tier 3),
 * 'paywall' (not ours to fight), 'nav'/'header'/'menu' (a focused page stays
 * navigable).
 */
const NOISE_TOKENS = new Set([
  'sidebar',
  'related',
  'recommend',
  'recommended',
  'recommendations',
  'recs',
  'newsletter',
  'subscribe',
  'subscription',
  'promo',
  'promos',
  'promotion',
  'sponsor',
  'sponsored',
  'advert',
  'adverts',
  'advertisement',
  'advertising',
  'ad',
  'ads',
  'adsense',
  'adslot',
  'social',
  'share',
  'sharing',
  'sharebar',
  'trending',
  'popular',
  'cookie',
  'cookies',
  'consent',
  'gdpr',
  'comment',
  'comments',
  'disqus',
  'taboola',
  'outbrain'
])

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR'])
const CONTENT_TAGS = new Set([
  'IMG',
  'PICTURE',
  'VIDEO',
  'AUDIO',
  'IFRAME',
  'CANVAS',
  'SVG',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'OBJECT',
  'EMBED',
  'HR'
])

let on = false
let observer: MutationObserver | null = null
let sweepTimer: number | null = null
let intervalTimer: number | null = null
/** New hides this sweep, against MAX_HIDES_PER_SWEEP. */
let hides = 0

/** Every inline style we changed, so off = exactly the page we found. */
const saved = new Map<HTMLElement, Map<string, { value: string; priority: string }>>()
/** Autoplay is paused once per element — if the reader presses play, it plays. */
const pausedOnce = new WeakSet<HTMLMediaElement>()

function setProp(el: HTMLElement, prop: string, value: string): void {
  let props = saved.get(el)
  if (!props) {
    props = new Map()
    saved.set(el, props)
  }
  if (!props.has(prop)) {
    props.set(prop, {
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop)
    })
  }
  el.style.setProperty(prop, value, 'important')
}

/** Off = the page as served (autoplay excepted; a reload restores that). */
function restoreAll(): void {
  for (const [el, props] of saved) {
    for (const [prop, prior] of props) {
      if (prior.value) el.style.setProperty(prop, prior.value, prior.priority)
      else el.style.removeProperty(prop)
    }
  }
  saved.clear()
  for (const el of document.querySelectorAll(`[${MARK}]`)) el.removeAttribute(MARK)
}

/** Never hide the reading itself, the page's frame, or Offshore's own surfaces. */
function offLimits(el: Element, scope: HTMLElement | null): boolean {
  if (el === document.body || el === document.documentElement) return true
  if (el.id.startsWith('offshore-') || el.tagName.toLowerCase().startsWith('offshore-')) return true
  if (scope && (el === scope || el.contains(scope))) return true
  return el.hasAttribute(MARK)
}

function hide(el: HTMLElement): void {
  if (hides >= MAX_HIDES_PER_SWEEP) return
  hides += 1
  setProp(el, 'display', 'none')
  el.setAttribute(MARK, 'hidden')
}

function tokensOf(el: Element): string[] {
  return `${el.getAttribute('class') ?? ''} ${el.id}`.toLowerCase().split(/[^a-z0-9]+/)
}

// ---------------- phase A: strip ----------------

function pauseAutoplay(): void {
  for (const el of document.querySelectorAll('video, audio')) {
    if (!(el instanceof HTMLMediaElement) || pausedOnce.has(el)) continue
    if ((el.autoplay || el.hasAttribute('autoplay')) && !el.paused) {
      pausedOnce.add(el)
      try {
        el.pause()
      } catch {
        /* media in a bad state pauses itself */
      }
      el.autoplay = false
      el.removeAttribute('autoplay')
      if (!el.hasAttribute(MARK)) el.setAttribute(MARK, 'paused')
    }
  }
}

function stripTier2(scope: HTMLElement | null): void {
  // body-level numbers, computed at most once per sweep
  let scopeTextLen = -1
  let docArea = -1
  let bodyTextLen = -1
  for (const el of document.querySelectorAll(TIER2_PREFILTER)) {
    if (!(el instanceof HTMLElement) || offLimits(el, scope)) continue
    if (!tokensOf(el).some((t) => NOISE_TOKENS.has(t))) continue
    if (scope && scope.contains(el)) {
      // in-article promo boxes are fair game; an article that happens to live
      // inside <div class="social-article"> is not
      if (scopeTextLen < 0) scopeTextLen = scope.innerText.length
      if (el.innerText.length > 0.4 * scopeTextLen) continue
    } else if (!scope) {
      // app-like page: never take most of the document on a name alone
      if (docArea < 0) {
        docArea = document.documentElement.scrollWidth * document.documentElement.scrollHeight
        bodyTextLen = document.body.innerText.length
      }
      const r = el.getBoundingClientRect()
      if (docArea > 0 && r.width * r.height >= 0.6 * docArea) continue
      if (bodyTextLen > 0 && el.innerText.length >= 0.5 * bodyTextLen) continue
    }
    hide(el)
  }
}

/** Viewport-riding overlays: cookie nags, newsletter strips, floating prompts. */
function stripTier3(scope: HTMLElement | null): void {
  for (const el of document.querySelectorAll('body > *, body > * > *')) {
    if (!(el instanceof HTMLElement) || offLimits(el, scope)) continue
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
    if (cs.display === 'none') continue
    const r = el.getBoundingClientRect()
    const viewport = Math.max(1, innerWidth) * Math.max(1, innerHeight)
    const wide = r.width >= innerWidth * 0.8 && r.height >= 32
    const big = (r.width * r.height) / viewport >= 0.04
    if (wide || big) hide(el)
  }
}

// ---------------- phase B: compact ("no holes") ----------------

function ownText(el: Element): boolean {
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && /\S/.test(n.textContent ?? '')) return true
  }
  return false
}

function contentless(el: Element, memo: Map<Element, boolean>): boolean {
  const hit = memo.get(el)
  if (hit !== undefined) return hit
  const tag = el.tagName.toUpperCase()
  const mark = el.getAttribute(MARK)
  let out: boolean
  if (mark === 'hidden' || mark === 'cascade') out = true
  else if (SKIP_TAGS.has(tag)) out = true
  else if (el instanceof HTMLElement && getComputedStyle(el).display === 'none') out = true
  else if (ownText(el)) out = false
  else if (CONTENT_TAGS.has(tag)) out = false
  else out = [...el.children].every((c) => contentless(c, memo))
  memo.set(el, out)
  return out
}

function compact(scope: HTMLElement | null): void {
  const memo = new Map<Element, boolean>()
  // B1: an emptied wrapper — padding, borders, min-heights — goes with its rail
  for (const el of document.querySelectorAll(`[${MARK}="hidden"], [${MARK}="cascade"]`)) {
    let p = el.parentElement
    while (p && !offLimits(p, scope)) {
      if (!contentless(p, memo)) break
      setProp(p, 'display', 'none')
      p.setAttribute(MARK, 'cascade')
      p = p.parentElement
    }
  }
  // B2: containers holding a hidden direct child may be holding a dead column
  const containers = new Set<HTMLElement>()
  for (const el of document.querySelectorAll(`[${MARK}="hidden"], [${MARK}="cascade"]`)) {
    if (el.parentElement) containers.add(el.parentElement)
  }
  for (const A of containers) relayout(A)
}

/** Single-survivor relayout, and dead-track removal for grids. */
function relayout(A: HTMLElement): void {
  if (A === document.documentElement) return
  const cs = getComputedStyle(A)
  if (cs.display === 'none') return
  const flexRow =
    (cs.display === 'flex' || cs.display === 'inline-flex') &&
    (cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse')
  const grid = cs.display === 'grid' || cs.display === 'inline-grid'
  if (!flexRow && !grid) return
  const visible = [...A.children].filter((c): c is HTMLElement => {
    if (!(c instanceof HTMLElement)) return false
    const k = getComputedStyle(c)
    // absolutely positioned children never held a track
    return k.display !== 'none' && k.position !== 'absolute' && k.position !== 'fixed'
  })
  if (visible.length === 1) {
    // the classic hole: the rail died and the survivor kept its column width
    const survivor = visible[0]
    setProp(A, 'display', 'block')
    A.setAttribute(MARK, 'restyled')
    const after = getComputedStyle(A)
    const cw = A.clientWidth - parseFloat(after.paddingLeft) - parseFloat(after.paddingRight)
    const sw = survivor.getBoundingClientRect().width
    if (cw > 0 && sw < 0.9 * cw) {
      const k = getComputedStyle(survivor)
      if (k.maxWidth !== 'none') {
        // a capped column centers, reader-style
        setProp(survivor, 'margin-left', 'auto')
        setProp(survivor, 'margin-right', 'auto')
      } else {
        setProp(survivor, 'width', 'auto')
        if (k.float !== 'none') setProp(survivor, 'float', 'none')
      }
      survivor.setAttribute(MARK, 'restyled')
    }
    return
  }
  if (visible.length >= 2 && grid) reflowGrid(A, cs, visible)
}

function reflowGrid(A: HTMLElement, cs: CSSStyleDeclaration, visible: HTMLElement[]): void {
  // computed style on a laid-out grid is a resolved px list; bail on anything else
  const tracks = cs.gridTemplateColumns.split(' ')
  if (tracks.length < 2 || !tracks.every((t) => /^\d+(\.\d+)?px$/.test(t))) return
  const widths = tracks.map((t) => parseFloat(t))
  const gap = parseFloat(cs.columnGap) || 0
  const ranges: [number, number][] = []
  let x = 0
  for (const w of widths) {
    ranges.push([x, x + w])
    x += w + gap
  }
  const aRect = A.getBoundingClientRect()
  const padEdge = aRect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)
  const occupied = widths.map(() => false)
  let allAuto = true
  for (const c of visible) {
    if (getComputedStyle(c).gridColumnStart !== 'auto') allAuto = false
    const r = c.getBoundingClientRect()
    const l = r.left - padEdge
    const rr = r.right - padEdge
    ranges.forEach(([a, b], i) => {
      if (Math.min(rr, b) - Math.max(l, a) >= 8) occupied[i] = true
    })
  }
  if (occupied.every(Boolean)) return
  if (allAuto) {
    // pure auto-placement: drop the dead tracks outright. The resolved list has
    // no fr left in it, so the widest survivor gets the flex put back by hand —
    // the freed width goes where the 1fr it usually was would have taken it.
    const kept = widths.filter((_, i) => occupied[i])
    if (!kept.length) return
    const widest = kept.indexOf(Math.max(...kept))
    setProp(
      A,
      'grid-template-columns',
      kept.map((w, i) => (i === widest ? `minmax(${w}px, 1fr)` : `${w}px`)).join(' ')
    )
  } else {
    // explicit placements: zero the dead tracks, keep the count so
    // grid-column: 3 still means what it meant
    setProp(
      A,
      'grid-template-columns',
      widths.map((w, i) => (occupied[i] ? `${w}px` : '0px')).join(' ')
    )
  }
  A.setAttribute(MARK, 'restyled')
}

// ---------------- the sweep ----------------

function sweep(): void {
  if (!on || !document.body) return
  try {
    // SPA churn must not grow the save map forever
    for (const el of [...saved.keys()]) {
      if (!el.isConnected) saved.delete(el)
    }
    const scope = document.querySelector<HTMLElement>('article, main, [role="main"]')
    hides = 0
    pauseAutoplay()
    for (const el of document.querySelectorAll(TIER1)) {
      if (el instanceof HTMLElement && !offLimits(el, scope)) hide(el)
    }
    stripTier2(scope)
    stripTier3(scope)
    compact(scope)
  } catch {
    /* Focus must never break a page */
  }
}

function schedule(): void {
  if (sweepTimer == null) {
    sweepTimer = window.setTimeout(() => {
      sweepTimer = null
      sweep()
    }, SWEEP_DEBOUNCE)
  }
}

function start(): void {
  sweep()
  observer ??= new MutationObserver(schedule)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  // a page that rewrites inline styles without DOM churn (carousel scripts,
  // cookie libs re-showing their banner by style flip) evades childList — a
  // slow idempotent re-sweep catches it without observing attribute storms
  intervalTimer ??= window.setInterval(schedule, RESWEEP_INTERVAL)
}

function stop(): void {
  observer?.disconnect()
  observer = null
  if (intervalTimer != null) {
    clearInterval(intervalTimer)
    intervalTimer = null
  }
  if (sweepTimer != null) {
    clearTimeout(sweepTimer)
    sweepTimer = null
  }
  restoreAll()
}

export function initFocus(): void {
  ipcRenderer.on('focus:apply', (_e, next: boolean) => {
    const want = next === true
    if (want === on) {
      if (on) schedule() // re-assert
      return
    }
    on = want
    if (on) start()
    else stop()
  })
}
