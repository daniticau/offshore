/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { ipcRenderer } from 'electron'
import type { PageEdit, PageModes } from '@shared/types'

/**
 * The slop scan (internal.ts) tells the Page Cleaner when block marks change,
 * so Clean mode can put freshly flagged prose away without polling. Set by
 * initPageEdit; a no-op on documents that never got an editor.
 */
let marksChangedHook: (() => void) | null = null
export function slopMarksChanged(): void {
  marksChangedHook?.()
}

/**
 * The page editor: point at anything on a page, and change it — for good.
 *
 * This runs in every tab's isolated world, which is a strictly better place
 * for it than the extension sandbox this idea usually lives in: same DOM as
 * the page, none of its scripts able to see or stop us, no store, no
 * permissions screen. Main keeps the ledger (src/main/pageedits.ts); this
 * file is everything else — the picking UI, the selector craft, and the
 * replaying of old decisions onto new documents.
 *
 * Three ops. 'hide' removes an element from the page (display:none, not
 * removal, so undo is instant and cheap). 'text' rewrites an element's
 * content in place. 'focus' hides every sibling along the element's ancestor
 * chain — the page becomes that one thing.
 *
 * Two rules the whole file bends around:
 *
 * 1. No stylesheets. A <style> tag injected into the document answers to the
 *    page's Content-Security-Policy, and strict sites would arrive with a
 *    broken editor. Writing through the CSSOM (el.style.setProperty) is not
 *    policed by CSP — so every pixel of UI here is styled by assignment, and
 *    the whole overlay lives in a closed shadow root where page CSS cannot
 *    reach it either.
 *
 * 2. Nothing is applied once. Modern pages re-render themselves constantly,
 *    and a deleted element that comes back in thirty seconds makes the
 *    feature a lie. Every op is idempotent, marked with a data attribute,
 *    and re-asserted by a MutationObserver whenever the page churns.
 */

const MARK = 'data-offshore-edit'
const TEXT_MARK = 'data-offshore-text'

/** Sea-blue, Offshore's default accent — legible over light and dark pages. */
const ACCENT = '#3ba4d0'
const ACCENT_SOFT = 'rgba(59, 164, 208, 0.12)'
/** The dark glass every floating piece is made of — the app's own #10181E. */
const INK = 'rgba(16, 24, 30, 0.94)'
const EDGE = '1px solid rgba(255, 255, 255, 0.14)'
const FONT = '500 12.5px/1.35 -apple-system, BlinkMacSystemFont, system-ui, sans-serif'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE'])
const BAD_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE'])

interface HiddenSet {
  op: 'hide' | 'focus'
  els: Map<HTMLElement, { display: string; priority: string }>
}
interface Rewritten {
  op: 'text'
  el: HTMLElement
  original: string
}
type Applied = HiddenSet | Rewritten

export function initPageEdit(): void {
  // ---------------- state ----------------

  /** The site's ledger, as main last sent it. */
  const edits = new Map<string, PageEdit>()
  /** What each edit has actually done to this document, so it can be undone. */
  const applied = new Map<string, Applied>()
  /** Edits made in this document, newest last — what ⌘Z walks back. */
  let sessionOrder: string[] = []

  let mode = false
  let selectedEl: HTMLElement | null = null
  let textEditing: { el: HTMLElement; original: string; selector: string; label: string } | null =
    null

  let observer: MutationObserver | null = null
  let scanTimer: number | null = null

  // ---------------- applying the ledger ----------------

  function queryAll(selector: string): HTMLElement[] {
    try {
      return [...document.querySelectorAll<HTMLElement>(selector)]
    } catch {
      return []
    }
  }

  function ours(el: Element | null): boolean {
    return !!el && (el === ui?.host || ui?.host.contains(el) === true)
  }

  function hideOne(id: string, el: HTMLElement, slot: HiddenSet): void {
    if (slot.els.has(el)) return
    slot.els.set(el, {
      display: el.style.getPropertyValue('display'),
      priority: el.style.getPropertyPriority('display')
    })
    el.style.setProperty('display', 'none', 'important')
    el.setAttribute(MARK, id)
  }

  function unhideOne(el: HTMLElement, saved: { display: string; priority: string }): void {
    el.removeAttribute(MARK)
    if (saved.display) el.style.setProperty('display', saved.display, saved.priority)
    else el.style.removeProperty('display')
  }

  function applyEdit(edit: PageEdit): void {
    if (edit.op === 'hide') {
      const slot = (applied.get(edit.id) as HiddenSet | undefined) ?? { op: 'hide' as const, els: new Map() }
      for (const el of queryAll(edit.selector)) {
        if (ours(el) || el === document.body || el === document.documentElement) continue
        hideOne(edit.id, el, slot)
      }
      if (slot.els.size) applied.set(edit.id, slot)
      return
    }

    if (edit.op === 'focus') {
      const anchor = queryAll(edit.selector)[0]
      if (!anchor || ours(anchor)) return
      const slot = (applied.get(edit.id) as HiddenSet | undefined) ?? { op: 'focus' as const, els: new Map() }
      let cur: HTMLElement | null = anchor
      while (cur && cur !== document.body && cur.parentElement) {
        for (const sib of cur.parentElement.children) {
          if (sib === cur || !(sib instanceof HTMLElement)) continue
          if (SKIP_TAGS.has(sib.tagName) || ours(sib) || sib.hasAttribute(MARK)) continue
          hideOne(edit.id, sib, slot)
        }
        cur = cur.parentElement
      }
      if (slot.els.size) applied.set(edit.id, slot)
      return
    }

    // text — content edits stay on the page they were written on
    if (edit.path && edit.path !== location.pathname) return
    const el = queryAll(edit.selector)[0]
    if (!el || ours(el)) return
    if (el.getAttribute(TEXT_MARK) === edit.id) return
    // never fight the human for an element they are typing in
    if (textEditing?.el === el || el.contains(document.activeElement)) return
    const original = el.innerHTML
    el.innerHTML = sanitize(edit.value ?? '')
    el.setAttribute(TEXT_MARK, edit.id)
    applied.set(edit.id, { op: 'text', el, original })
  }

  function revertEdit(id: string): void {
    const a = applied.get(id)
    if (!a) return
    applied.delete(id)
    if (a.op === 'text') {
      if (a.el.getAttribute(TEXT_MARK) === id) {
        a.el.removeAttribute(TEXT_MARK)
        a.el.innerHTML = a.original
      }
      return
    }
    for (const [el, saved] of a.els) unhideOne(el, saved)
  }

  function scan(): void {
    scanTimer = null
    // a page that rewrites <html>'s children can take our overlay with it
    if (ui && !ui.host.isConnected) document.documentElement.appendChild(ui.host)
    for (const edit of edits.values()) applyEdit(edit)
    applyModes()
  }

  /**
   * The observer is the persistence half of the feature: a virtual-DOM page
   * re-renders, the deleted thing comes back unmarked, and the next sweep
   * puts it away again. Sweeps are debounced and idempotent, so even a
   * chatty page costs a few querySelectors four times a second.
   */
  function watching(): boolean {
    return edits.size > 0 || modes.clean || modes.focus
  }

  function ensureObserver(): void {
    if (observer || !watching()) return
    observer = new MutationObserver(() => {
      if (scanTimer == null) scanTimer = window.setTimeout(scan, 240)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  function settleObserver(): void {
    if (observer && !watching()) {
      observer.disconnect()
      observer = null
    }
  }

  // ---------------- the Page Cleaner's modes ----------------
  //
  // Clean hides what the slop scan marked; Focus hides the furniture around
  // the content. Both are per-site switches main flips over 'pagemode:apply',
  // both hide with the same display:none-and-remember move the manual editor
  // uses, and both are re-asserted by the same observer, so a re-render can't
  // bring the clutter back.

  const MODE_MARK = 'data-offshore-mode'
  let modes: PageModes = { clean: false, focus: false }
  const hiddenByMode: Record<'clean' | 'focus', Map<HTMLElement, { display: string; priority: string }>> = {
    clean: new Map(),
    focus: new Map()
  }

  /** The signature of things that sit beside the reading, not in it. */
  const FOCUS_NOISE = [
    'aside',
    '[role="complementary"]',
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
    '[class*="consent" i]'
  ].join(', ')

  function modeHide(mode: 'clean' | 'focus', el: HTMLElement): void {
    const bucket = hiddenByMode[mode]
    if (bucket.has(el)) return
    bucket.set(el, {
      display: el.style.getPropertyValue('display'),
      priority: el.style.getPropertyPriority('display')
    })
    el.style.setProperty('display', 'none', 'important')
    el.setAttribute(MODE_MARK, mode)
  }

  function modeRestore(mode: 'clean' | 'focus'): void {
    const bucket = hiddenByMode[mode]
    for (const [el, saved] of bucket) {
      if (el.getAttribute(MODE_MARK) === mode) el.removeAttribute(MODE_MARK)
      if (saved.display) el.style.setProperty('display', saved.display, saved.priority)
      else el.style.removeProperty('display')
    }
    bucket.clear()
  }

  /** Never hide the reading itself, the page's frame, or anything of ours. */
  function offLimits(el: HTMLElement): boolean {
    if (ours(el) || el === document.body || el === document.documentElement) return true
    // Offshore's other in-page surfaces (the slop veil) are not page clutter
    if (el.id.startsWith('offshore-') || el.tagName.toLowerCase().startsWith('offshore-')) return true
    const scope = document.querySelector('article, main, [role="main"]')
    return !!scope && el.contains(scope)
  }

  function applyModes(): void {
    if (modes.clean) {
      for (const el of document.querySelectorAll<HTMLElement>('[data-offshore-slop]')) {
        if (!offLimits(el) && !el.hasAttribute(MARK)) modeHide('clean', el)
      }
    } else if (hiddenByMode.clean.size) {
      modeRestore('clean')
    }

    if (modes.focus) {
      for (const el of document.querySelectorAll<HTMLElement>(FOCUS_NOISE)) {
        if (!offLimits(el) && !el.hasAttribute(MARK)) modeHide('focus', el)
      }
      // overlays that ride the viewport — sticky bars, floating prompts. Only
      // the shallow layers are asked: that is where pages mount them.
      for (const el of document.querySelectorAll<HTMLElement>('body > *, body > * > *')) {
        if (offLimits(el) || el.hasAttribute(MODE_MARK) || el.hasAttribute(MARK)) continue
        const cs = getComputedStyle(el)
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
        if (cs.display === 'none') continue
        const r = el.getBoundingClientRect()
        const viewport = Math.max(1, innerWidth) * Math.max(1, innerHeight)
        const wide = r.width >= innerWidth * 0.8 && r.height >= 32
        const big = (r.width * r.height) / viewport >= 0.04
        if (wide || big) modeHide('focus', el)
      }
    } else if (hiddenByMode.focus.size) {
      modeRestore('focus')
    }
  }

  // ---------------- sanitizing ----------------

  /**
   * A rewritten element stores markup, not text — an edit that flattened the
   * links out of a paragraph would be a poor trade. But stored markup is
   * replayed on every visit, so anything that executes is stripped: on both
   * record and apply, in case the ledger on disk was ever touched by hand.
   */
  function sanitize(html: string): string {
    const tpl = document.createElement('template')
    tpl.innerHTML = html
    const walk = (node: Element | DocumentFragment): void => {
      for (const child of [...node.children]) {
        if (BAD_TAGS.has(child.tagName)) {
          child.remove()
          continue
        }
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase()
          if (name.startsWith('on') || name === 'srcdoc') child.removeAttribute(attr.name)
          else if (
            (name === 'href' || name === 'src' || name === 'action' || name === 'xlink:href') &&
            /^\s*javascript:/i.test(attr.value)
          ) {
            child.removeAttribute(attr.name)
          }
        }
        walk(child)
      }
    }
    walk(tpl.content)
    return tpl.innerHTML
  }

  // ---------------- selectors ----------------

  /**
   * The selector is the whole ballgame: it has to find this element again
   * next week, on a page the site has re-rendered, A/B-tested, and hashed
   * new class names onto. Ids that look machine-stamped (ember384, :r1a:,
   * trailing digit runs) are refused; classes are never trusted at all.
   * What's left: human-named ids, test hooks, aria labels — then a plain
   * structural path from the nearest stable ancestor down.
   */
  function stableId(id: string): boolean {
    return !!id && id.length < 80 && !/^\d|^(ember|radix|react|headlessui|:)/i.test(id) && !/\d{3,}/.test(id)
  }

  function unique(selector: string, el: Element): boolean {
    try {
      const m = document.querySelectorAll(selector)
      return m.length === 1 && m[0] === el
    } catch {
      return false
    }
  }

  function buildSelector(el: Element): string {
    if (stableId(el.id) && unique(`#${CSS.escape(el.id)}`, el)) return `#${CSS.escape(el.id)}`
    const tag = el.tagName.toLowerCase()
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-id', 'name', 'aria-label', 'itemprop']) {
      const v = el.getAttribute(attr)
      if (v && v.length < 80) {
        const sel = `${tag}[${attr}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
        if (unique(sel, el)) return sel
      }
    }
    const parts: string[] = []
    let cur: Element | null = el
    while (cur && cur !== document.documentElement) {
      const parent: Element | null = cur.parentElement
      if (cur !== el && stableId(cur.id) && unique(`#${CSS.escape(cur.id)}`, cur)) {
        parts.unshift(`#${CSS.escape(cur.id)}`)
        break
      }
      let part = cur.tagName.toLowerCase()
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur!.tagName)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
      }
      parts.unshift(part)
      cur = parent
    }
    return parts.join(' > ')
  }

  function labelFor(el: HTMLElement): string {
    const tag = el.tagName.toLowerCase()
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    return text ? `${tag} — “${text}”` : tag
  }

  // ---------------- the overlay ----------------

  interface UI {
    host: HTMLElement
    hoverBox: HTMLElement
    hoverTag: HTMLElement
    selBox: HTMLElement
    toolbar: HTMLElement
    pickButtons: HTMLElement
    textButtons: HTMLElement
    pill: HTMLElement
    undoBtn: HTMLButtonElement
  }
  let ui: UI | null = null

  function style(el: HTMLElement, s: Partial<CSSStyleDeclaration>): void {
    Object.assign(el.style, s)
  }

  function mk(parent: Node | null, s: Partial<CSSStyleDeclaration>, text?: string): HTMLElement {
    const el = document.createElement('div')
    style(el, s)
    if (text) el.textContent = text
    parent?.appendChild(el)
    return el
  }

  function btn(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.textContent = label
    style(b, {
      font: FONT,
      color: primary ? '#dff2fa' : 'rgba(255,255,255,0.85)',
      background: 'transparent',
      border: '0',
      borderRadius: '7px',
      padding: '7px 11px',
      cursor: 'pointer',
      whiteSpace: 'nowrap'
    })
    b.addEventListener('mouseenter', () => (b.style.background = 'rgba(255,255,255,0.12)'))
    b.addEventListener('mouseleave', () => (b.style.background = 'transparent'))
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    return b
  }

  function buildUi(): UI {
    const host = document.createElement('offshore-page-edit')
    // the host is a zero-size fixed point; everything real lives in its shadow
    style(host, { all: 'initial', position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '2147483647' })
    const root = host.attachShadow({ mode: 'closed' })

    const hoverBox = mk(root, {
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      border: `1.5px solid ${ACCENT}`,
      background: ACCENT_SOFT,
      borderRadius: '4px',
      boxSizing: 'border-box',
      zIndex: '1'
    })
    const hoverTag = mk(root, {
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      font: FONT,
      color: '#fff',
      background: INK,
      border: EDGE,
      padding: '3px 8px',
      borderRadius: '6px',
      maxWidth: '40vw',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      zIndex: '3'
    })
    const selBox = mk(root, {
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      border: `2px solid ${ACCENT}`,
      borderRadius: '4px',
      boxSizing: 'border-box',
      zIndex: '2'
    })

    const toolbar = mk(root, {
      position: 'fixed',
      display: 'none',
      alignItems: 'center',
      gap: '2px',
      background: INK,
      border: EDGE,
      borderRadius: '10px',
      padding: '3px',
      boxShadow: '0 10px 32px rgba(0, 0, 0, 0.38)',
      zIndex: '4'
    })
    const pickButtons = mk(toolbar, { display: 'flex', alignItems: 'center', gap: '2px' })
    const textButtons = mk(toolbar, { display: 'none', alignItems: 'center', gap: '2px' })
    pickButtons.append(
      btn('Hide', false, () => doHide()),
      btn('Edit text', false, () => startTextEdit()),
      btn('Focus', false, () => doFocus())
    )
    textButtons.append(
      btn('Save', true, () => commitText()),
      btn('Cancel', false, () => cancelText())
    )

    const pill = mk(root, {
      position: 'fixed',
      display: 'none',
      top: '14px',
      left: '50%',
      transform: 'translateX(-50%)',
      alignItems: 'center',
      gap: '4px',
      background: INK,
      border: EDGE,
      borderRadius: '12px',
      padding: '5px 6px 5px 14px',
      boxShadow: '0 12px 36px rgba(0, 0, 0, 0.4)',
      zIndex: '5'
    })
    mk(pill, { font: FONT, color: '#fff', marginRight: '2px' }, 'Editing this page')
    mk(pill, { font: FONT, color: 'rgba(255,255,255,0.55)', marginRight: '6px' }, 'click anything · ⌫ hides · esc when done')
    const undoBtn = btn('Undo', false, () => undo())
    const doneBtn = btn('Done', true, () => void ipcRenderer.invoke('pageedit:exit'))
    style(doneBtn, { background: 'rgba(255,255,255,0.1)' })
    doneBtn.addEventListener('mouseenter', () => (doneBtn.style.background = 'rgba(255,255,255,0.2)'))
    doneBtn.addEventListener('mouseleave', () => (doneBtn.style.background = 'rgba(255,255,255,0.1)'))
    pill.append(undoBtn, doneBtn)

    document.documentElement.appendChild(host)
    return { host, hoverBox, hoverTag, selBox, toolbar, pickButtons, textButtons, pill, undoBtn }
  }

  function placeBox(box: HTMLElement, r: DOMRect): void {
    style(box, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${Math.max(0, r.width)}px`,
      height: `${Math.max(0, r.height)}px`
    })
  }

  function placeTag(r: DOMRect, text: string): void {
    if (!ui) return
    ui.hoverTag.textContent = text
    const above = r.top >= 30
    style(ui.hoverTag, {
      display: 'block',
      left: `${Math.max(6, Math.min(r.left, innerWidth - 220))}px`,
      top: above ? `${r.top - 26}px` : `${Math.min(innerHeight - 26, r.bottom + 4)}px`
    })
  }

  function placeToolbar(r: DOMRect): void {
    if (!ui) return
    const tb = ui.toolbar
    tb.style.display = 'flex'
    const tw = tb.offsetWidth || 200
    const th = tb.offsetHeight || 34
    const x = Math.max(8, Math.min(r.left, innerWidth - tw - 8))
    let y = r.bottom + 8
    if (y + th > innerHeight - 8) y = Math.max(8, r.top - th - 8)
    style(tb, { left: `${x}px`, top: `${y}px` })
  }

  function updatePill(): void {
    if (!ui) return
    ui.undoBtn.style.opacity = sessionOrder.length ? '1' : '0.4'
    ui.undoBtn.style.cursor = sessionOrder.length ? 'pointer' : 'default'
  }

  // ---------------- picking ----------------

  /**
   * The element a pointer event is really about, surfaced to this document.
   * Component pages answer with nodes buried in their own shadow roots;
   * hiding half a web component's insides is fragile, so the pick walks out
   * to the shadow host — the whole widget — which is almost always the thing
   * being pointed at anyway.
   */
  function pickTarget(e: Event): HTMLElement | null {
    const path = e.composedPath()
    let el = path[0] instanceof Element ? (path[0] as Element) : null
    while (el) {
      const root = el.getRootNode()
      if (root === document) break
      el = root instanceof ShadowRoot ? root.host : null
    }
    if (!el || !(el instanceof HTMLElement)) return null
    if (ours(el) || el === document.body || el === document.documentElement) return null
    return el
  }

  function select(el: HTMLElement): void {
    selectedEl = el
    if (!ui) return
    ui.hoverBox.style.display = 'none'
    const r = el.getBoundingClientRect()
    placeBox(ui.selBox, r)
    placeTag(r, labelFor(el))
    placeToolbar(r)
  }

  function deselect(): void {
    selectedEl = null
    if (!ui) return
    ui.selBox.style.display = 'none'
    ui.toolbar.style.display = 'none'
    ui.hoverTag.style.display = 'none'
  }

  /** Boxes chase their elements through scrolls, resizes and reflows. */
  let repositionQueued = false
  function reposition(): void {
    if (repositionQueued) return
    repositionQueued = true
    requestAnimationFrame(() => {
      repositionQueued = false
      if (!ui) return
      const el = textEditing?.el ?? selectedEl
      if (!el || !el.isConnected) {
        if (mode) deselect()
        return
      }
      const r = el.getBoundingClientRect()
      if (!textEditing) {
        placeBox(ui.selBox, r)
        placeTag(r, labelFor(el))
      }
      placeToolbar(r)
    })
  }

  // ---------------- the ops ----------------

  async function commitOp(
    payload: { op: string; selector: string; value?: string; path?: string; label?: string },
    preApplied?: (edit: PageEdit) => void
  ): Promise<void> {
    const edit = (await ipcRenderer.invoke('pageedit:record', payload)) as PageEdit | null
    if (!edit) return
    edits.set(edit.id, edit)
    preApplied?.(edit)
    applyEdit(edit)
    sessionOrder.push(edit.id)
    ensureObserver()
    updatePill()
  }

  function doHide(): void {
    const el = selectedEl
    if (!el) return
    const selector = buildSelector(el)
    const label = labelFor(el)
    deselect()
    void commitOp({ op: 'hide', selector, label })
  }

  function doFocus(): void {
    const el = selectedEl
    if (!el) return
    const selector = buildSelector(el)
    const label = `focus on ${labelFor(el)}`
    deselect()
    void commitOp({ op: 'focus', selector, label })
  }

  function startTextEdit(): void {
    const el = selectedEl
    if (!el || !ui) return
    textEditing = { el, original: el.innerHTML, selector: buildSelector(el), label: labelFor(el) }
    ui.selBox.style.display = 'none'
    ui.hoverTag.style.display = 'none'
    ui.pickButtons.style.display = 'none'
    ui.textButtons.style.display = 'flex'
    el.setAttribute('contenteditable', 'true')
    el.style.setProperty('outline', `2px dashed ${ACCENT}`, 'important')
    el.style.setProperty('outline-offset', '2px', 'important')
    el.addEventListener('input', reposition)
    el.focus()
    placeToolbar(el.getBoundingClientRect())
  }

  function endTextEdit(): { el: HTMLElement; original: string; selector: string; label: string } | null {
    const t = textEditing
    if (!t || !ui) return null
    textEditing = null
    t.el.removeEventListener('input', reposition)
    t.el.removeAttribute('contenteditable')
    t.el.style.removeProperty('outline')
    t.el.style.removeProperty('outline-offset')
    ui.pickButtons.style.display = 'flex'
    ui.textButtons.style.display = 'none'
    deselect()
    return t
  }

  function commitText(): void {
    const t = endTextEdit()
    if (!t) return
    const html = t.el.innerHTML
    if (html === t.original) return
    const value = sanitize(html)
    t.el.innerHTML = value
    void commitOp(
      { op: 'text', selector: t.selector, value, path: location.pathname, label: t.label },
      (edit) => {
        // what undo should restore is the page's own words, not our rewrite
        t.el.setAttribute(TEXT_MARK, edit.id)
        applied.set(edit.id, { op: 'text', el: t.el, original: t.original })
      }
    )
  }

  function cancelText(): void {
    const t = endTextEdit()
    if (t) t.el.innerHTML = t.original
  }

  function undo(): void {
    const id = sessionOrder.pop()
    if (!id) return
    revertEdit(id)
    edits.delete(id)
    settleObserver()
    updatePill()
    void ipcRenderer.invoke('pageedit:remove', id)
  }

  // ---------------- edit mode ----------------

  const listeners: Array<[string, EventListener, AddEventListenerOptions]> = []
  function listen(type: string, fn: EventListener, opts: AddEventListenerOptions): void {
    window.addEventListener(type, fn, opts)
    listeners.push([type, fn, opts])
  }

  function fromOverlay(e: Event): boolean {
    return !!ui && e.composedPath().includes(ui.host)
  }

  function onMove(e: Event): void {
    if (!ui || textEditing) return
    if (fromOverlay(e)) {
      ui.hoverBox.style.display = 'none'
      if (!selectedEl) ui.hoverTag.style.display = 'none'
      return
    }
    const el = pickTarget(e)
    if (!el || el === selectedEl) {
      ui.hoverBox.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    placeBox(ui.hoverBox, r)
    if (!selectedEl) placeTag(r, labelFor(el))
  }

  /**
   * In edit mode the page goes quiet: clicks pick elements instead of
   * following links, and nothing is allowed through to the site's own
   * handlers. Everything except scrolling — reading your way down a page is
   * part of choosing what to change on it.
   */
  function onGate(e: Event): void {
    if (fromOverlay(e)) return
    // while a text edit is open, its element is a real editor — the human is
    // placing a caret and selecting words in there; a click anywhere else saves
    if (textEditing) {
      const path = e.composedPath()
      if (path.includes(textEditing.el)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.type === 'pointerdown') commitText()
      return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.type === 'pointerdown' && (e as PointerEvent).button === 0) {
      const el = pickTarget(e)
      if (el) select(el)
      else deselect()
    }
  }

  function onKey(e: Event): void {
    const k = e as KeyboardEvent
    if (textEditing) {
      if (k.key === 'Escape') {
        k.preventDefault()
        k.stopImmediatePropagation()
        cancelText()
      } else if (k.key === 'Enter' && (k.metaKey || k.ctrlKey)) {
        k.preventDefault()
        k.stopImmediatePropagation()
        commitText()
      }
      return
    }
    if (k.key === 'Escape') {
      k.preventDefault()
      k.stopImmediatePropagation()
      if (selectedEl) deselect()
      else void ipcRenderer.invoke('pageedit:exit')
    } else if ((k.key === 'Delete' || k.key === 'Backspace') && selectedEl) {
      k.preventDefault()
      k.stopImmediatePropagation()
      doHide()
    } else if (k.key === 'Enter' && selectedEl) {
      k.preventDefault()
      k.stopImmediatePropagation()
      startTextEdit()
    } else if (k.key.toLowerCase() === 'z' && (k.metaKey || k.ctrlKey) && !k.shiftKey) {
      k.preventDefault()
      k.stopImmediatePropagation()
      undo()
    }
  }

  function enterMode(): void {
    if (mode) return
    mode = true
    ui ??= buildUi()
    if (!ui.host.isConnected) document.documentElement.appendChild(ui.host)
    ui.pill.style.display = 'flex'
    updatePill()
    listen('pointermove', onMove, { capture: true, passive: true })
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick']) {
      listen(t, onGate, { capture: true })
    }
    listen('keydown', onKey, { capture: true })
    listen('scroll', reposition, { capture: true, passive: true })
    listen('resize', reposition, { passive: true })
  }

  function exitMode(): void {
    if (!mode) return
    mode = false
    if (textEditing) commitText()
    deselect()
    if (ui) {
      ui.pill.style.display = 'none'
      ui.hoverBox.style.display = 'none'
    }
    for (const [type, fn, opts] of listeners) window.removeEventListener(type, fn, opts)
    listeners.length = 0
  }

  // ---------------- wiring ----------------

  marksChangedHook = () => {
    if (modes.clean) applyModes()
  }

  ipcRenderer.on('pagemode:apply', (_e, next: Partial<PageModes>) => {
    modes = { clean: next?.clean === true, focus: next?.focus === true }
    applyModes()
    ensureObserver()
    settleObserver()
  })

  ipcRenderer.on('pageedit:mode', (_e, on: boolean) => {
    if (on) enterMode()
    else exitMode()
  })

  ipcRenderer.on('pageedit:apply', (_e, list: PageEdit[]) => {
    if (!Array.isArray(list)) return
    // the ledger arriving replaces the ledger held — including edits it dropped
    for (const id of [...applied.keys()]) {
      if (!list.some((e) => e && e.id === id)) revertEdit(id)
    }
    edits.clear()
    for (const e of list) {
      if (e && typeof e.id === 'string' && typeof e.selector === 'string') edits.set(e.id, e)
    }
    sessionOrder = sessionOrder.filter((id) => edits.has(id))
    updatePill()
    for (const edit of edits.values()) applyEdit(edit)
    ensureObserver()
    settleObserver()
  })

  ipcRenderer.on('pageedit:reset', () => {
    for (const id of [...applied.keys()]) revertEdit(id)
    edits.clear()
    sessionOrder = []
    updatePill()
    settleObserver()
  })
}
