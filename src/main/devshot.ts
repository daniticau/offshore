import { BrowserWindow, app, ipcMain, screen, session } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as nodeHttp from 'http'
import { ADBLOCK_LISTS, HOME_WIDGETS, SLOP_FLAG_MIN, SLOP_HEAVY_MIN, type SiteReport, type SlopReport } from '@shared/types'
import { TAB_PARTITION } from './sessions'
import { windows, type OffshoreWindow } from './windows'

/**
 * Headless design-verification harness (dev only).
 * OFFSHORE_SHOT=<dir> captures the chrome UI, the active page, and a composite
 * of both, then exits. OFFSHORE_SHOT_URL navigates the first tab there first.
 * OFFSHORE_SHOT_WAIT overrides the settle delay in ms.
 */
export function setupDevshot(): void {
  setupTestFlows()
  const dir = process.env['OFFSHORE_SHOT']
  if (!dir) return
  // with both armed the flow owns the run (and writes its own eyeball shots) —
  // two exits racing over one app is nobody's screenshot
  if (process.env['OFFSHORE_TEST_FLOW']) return
  const wait = Number(process.env['OFFSHORE_SHOT_WAIT'] || 3500)
  /** Quiet is the default: parked off-screen, the window needs a beat longer to settle. */
  const quiet = !process.env['OFFSHORE_TEST_FOREGROUND']
  console.log('[devshot] userData:', app.getPath('userData'), quiet ? '(quiet)' : '')

  void app.whenReady().then(() => {
    setTimeout(() => {
      void run().catch((err) => {
        console.error('[devshot] failed:', err)
        app.exit(1)
      })
    }, wait)
  })

  async function run(): Promise<void> {
    mkdirSync(dir!, { recursive: true })
    const w = await waitForWindow(20_000)
    if (!w) {
      console.error('[devshot] no window appeared within 20s')
      app.exit(1)
      return
    }
    const extId = process.env['OFFSHORE_TEST_EXT']
    if (extId) {
      const { installExtension } = await import('electron-chrome-web-store')
      const { tabSession } = await import('./sessions')
      try {
        await installExtension(extId, { session: tabSession() })
        console.log('[devshot] installed extension', extId)
      } catch (err) {
        console.error('[devshot] extension install failed:', err)
      }
      await delay(1500)
    }
    const url = process.env['OFFSHORE_SHOT_URL']
    if (url) {
      w.tabs.navigate(null, url)
      await delay(5000)
    }
    if (process.env['OFFSHORE_SHOT_EDIT']) {
      const t = w.tabs.activeTab
      t?.wc.send('widgets:edit')
      // click a widget so its style strip is in the capture
      await delay(600)
      await t?.wc
        .executeJavaScript(
          `(() => { const s = document.querySelectorAll('.widget-slot')[1]
             if (!s) return false
             const r = s.getBoundingClientRect()
             const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1 }
             s.dispatchEvent(new PointerEvent('pointerdown', o))
             s.dispatchEvent(new PointerEvent('pointerup', o))
             return true })()`
        )
        .catch(() => false)
      await delay(500)
    }
    if (process.env['OFFSHORE_TEST_BOOKMARK']) {
      const { bookmarksStore } = await import('./stores')
      const tab = w.tabs.activeTab
      if (tab) {
        bookmarksStore.toggle(tab.wc.getURL(), tab.wc.getTitle())
        w.tabs.pushState()
        await delay(300)
        console.log('[devshot] bookmarks:', JSON.stringify(bookmarksStore.list()))
      }
    }
    console.log(
      '[devshot] tabs:',
      JSON.stringify(w.tabs.state().tabs.map((t) => ({ id: t.id, url: t.url.slice(0, 60), active: t.id === w.tabs.activeTabId })))
    )
    // Ensure the view has painted and has a live surface before capturing
    surface(w)
    w.tabs.setActiveVisible(true)
    await delay(quiet ? 900 : 600)
    const tab = w.tabs.activeTab
    if (tab) {
      const pageImg = await tab.wc.capturePage()
      writeFileSync(join(dir!, 'page.png'), pageImg.toPNG())
      w.sendToChrome('devshot:composite', {
        dataUrl: pageImg.toDataURL(),
        bounds: w.contentBounds()
      })
      await new Promise<void>((resolve) => ipcMain.once('devshot:composite-done', () => resolve()))
      await delay(250)
    }
    const full = await w.win.webContents.capturePage()
    writeFileSync(join(dir!, 'full.png'), full.toPNG())
    if (tab) {
      const pd = await tab.wc
        .executeJavaScript(
          `JSON.stringify({state: document.readyState, len: document.body ? document.body.innerText.length : -1, url: location.href, vis: document.visibilityState})`
        )
        .catch((e) => `err: ${e}`)
      console.log('[devshot] page diag', pd)
    }
    /**
     * OFFSHORE_SHOT_CLICK=<css selector>: press something in the chrome and
     * photograph what it opened, into click.png.
     *
     * No composite here. A panel now stands on the page-freeze still the chrome
     * paints for itself (see OffshoreWindow.setOverlay), so a plain window
     * capture already shows page and panel together — while the devshot
     * composite, which rides above everything, would bury the panel.
     */
    const click = process.env['OFFSHORE_SHOT_CLICK']
    if (click) {
      w.sendToChrome('devshot:composite', null)
      await delay(150)
      const hit = await w.win.webContents
        .executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(click)})
             if (!el) return false
             el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
             el.click()
             return true })()`
        )
        .catch((e) => `err: ${e}`)
      console.log('[devshot] click', click, hit)
      await delay(1200)
      const after = await w.win.webContents
        .executeJavaScript(
          `JSON.stringify({
             freeze: [...document.querySelectorAll('.page-freeze')].map((i) => ({ w: i.clientWidth, h: i.clientHeight, done: i.complete })),
             panels: ['.cr-menu', '.profile-menu', '.dl-panel', '.htab-split'].map((s) => {
               const e = document.querySelector(s)
               if (!e) return [s, null]
               const r = e.getBoundingClientRect()
               return [s, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }]
             })
           })`
        )
        .catch((e) => `err: ${e}`)
      console.log('[devshot] after click', after)
      const shot = await w.win.webContents.capturePage()
      writeFileSync(join(dir!, 'click.png'), shot.toPNG())
      console.log(
        '[devshot] devtools:',
        JSON.stringify(w.tabs.state().devtools),
        'open:',
        w.tabs.activeTab?.wc.isDevToolsOpened(),
        'content:',
        JSON.stringify(w.contentBounds()),
        'page:',
        JSON.stringify(w.tabs.activeTab?.view.getBounds())
      )
    }
    /**
     * OFFSHORE_SHOT_HOVER=<css selector>: put the pointer on something and
     * photograph what that alone brings out, into hover.png — the peeking
     * sidebar at the window's edge, the copy-link button in the address bar.
     * React synthesises enter/leave from mouseover/mouseout, so that is what
     * goes out; a bare mouseenter would never reach it.
     */
    const hover = process.env['OFFSHORE_SHOT_HOVER']
    if (hover) {
      w.sendToChrome('devshot:composite', null)
      await delay(150)
      const hit = await w.win.webContents
        .executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(hover)})
             if (!el) return null
             el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
             el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
             const r = el.getBoundingClientRect()
             return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`
        )
        .catch((e) => `err: ${e}`)
      /*
       * The events above are for React, which synthesises enter/leave from
       * them. CSS :hover is not a DOM event at all, though — it is the real
       * pointer's position, and a dispatched MouseEvent never moves it. So
       * anything styled purely on :hover photographed as if untouched, which
       * made a working hover look broken. Put the actual pointer there too.
       */
      if (hit && typeof hit === 'object' && 'x' in hit) {
        const { x, y } = hit as { x: number; y: number }
        w.win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      }
      console.log('[devshot] hover', hover, JSON.stringify(hit))
      await delay(1400)
      const shot = await w.win.webContents.capturePage()
      writeFileSync(join(dir!, 'hover.png'), shot.toPNG())
      console.log(
        '[devshot] after hover — content:',
        JSON.stringify(w.contentBounds()),
        'page:',
        JSON.stringify(w.tabs.activeTab?.view.getBounds())
      )
    }
    if (process.env['OFFSHORE_SHOT_PALETTE']) {
      w.sendToChrome('devshot:composite', null)
      w.sendToChrome('omnibox:focus')
      await delay(700)
      const cd = await w.win.webContents
        .executeJavaScript(
          `JSON.stringify({omniboxFocused: !!document.activeElement?.classList?.contains('omni-input'), hasApi: typeof window.offshore !== 'undefined'})`
        )
        .catch((e) => `err: ${e}`)
      console.log('[devshot] chrome diag', cd)
      const palette = await w.win.webContents.capturePage()
      writeFileSync(join(dir!, 'palette.png'), palette.toPNG())
    }
    /**
     * OFFSHORE_SHOT_TYPE=<text>: put the cursor in the address bar the way ⌘L
     * does, type that, and photograph the dropdown into omnibox.png.
     */
    const typed = process.env['OFFSHORE_SHOT_TYPE']
    if (typed) {
      w.sendToChrome('devshot:composite', null)
      w.win.webContents.focus()
      w.sendToChrome('omnibox:focus')
      await delay(600)
      await w.win.webContents
        .executeJavaScript(
          `(() => { const el = document.querySelector('.omni-input')
             if (!el) return false
             Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(typed)})
             el.dispatchEvent(new Event('input', { bubbles: true }))
             return true })()`
        )
        .catch((e) => `err: ${e}`)
      await delay(1400)
      const rows = await w.win.webContents
        .executeJavaScript(`document.querySelectorAll('.omni-suggestion').length`)
        .catch(() => -1)
      console.log('[devshot] omnibox rows:', rows)
      const shot = await w.win.webContents.capturePage()
      writeFileSync(join(dir!, 'omnibox.png'), shot.toPNG())
    }
    console.log('[devshot] wrote screenshots to', dir)
    app.exit(0)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Get the window painting with a live surface for captures and checks — without
 * ever taking the keyboard or covering what the human is doing. Quiet (the
 * default) parks it off the side of the display, shown but inactive.
 *
 * "Shown" needs care on macOS. showInactive never marks the page views'
 * renderers visible — Electron only flips a WebContentsView's contents to
 * "shown" on the window's activating show — so a quiet run's pages would sit in
 * `hidden` visibility for the whole flow, and capturePage would hand back empty
 * stills: the freeze-frame dance loses its picture, and every "the page steps
 * aside" check with it. A show() with focusability switched off walks the same
 * marking path without ever touching the human's keyboard, and the visibility
 * sticks once granted. The park also keeps a 2px sliver of the window's edge on
 * the leftmost display rather than trusting AppKit, which quietly drags a
 * wholly off-screen window back to a 40px sliver of its own choosing.
 * OFFSHORE_TEST_FOREGROUND=1 brings back the old grab-everything behavior for
 * the rare check that needs genuine OS focus.
 */
function surface(w: OffshoreWindow): void {
  if (process.env['OFFSHORE_TEST_FOREGROUND']) {
    w.win.setAlwaysOnTop(true)
    w.win.show()
    app.focus({ steal: true })
    w.win.focus()
    w.win.moveTop()
    return
  }
  const [, wy] = w.win.getPosition()
  const { width } = w.win.getBounds()
  const left = screen
    .getAllDisplays()
    .reduce((min, d) => (d.bounds.x < min.bounds.x ? d : min))
  // keep the sliver inside that display's vertical range, or it occludes anyway
  const y = Math.min(Math.max(wy, left.bounds.y), left.bounds.y + left.bounds.height - 100)
  w.win.setPosition(left.bounds.x - width + 2, y)
  w.win.setFocusable(false)
  w.win.show()
  w.win.setFocusable(true)
}

/**
 * Poll until the page agrees, rather than sleeping a round number and hoping.
 * Returns what the probe last said, so a timeout reads as a plain failed check
 * instead of a thrown error in the middle of a flow.
 */
async function settle<T>(probe: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  for (;;) {
    last = await probe().catch(() => undefined)
    if (last) return last
    if (Date.now() > deadline) return last
    await delay(80)
  }
}

/** The harness arms before the first window exists, so poll for one. */
async function waitForWindow(timeoutMs: number): Promise<OffshoreWindow | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const w = windows.values().next().value
    if (w) return w
    if (Date.now() > deadline) return undefined
    await delay(200)
  }
}

/**
 * Scripted end-to-end checks (dev only):
 * OFFSHORE_TEST_FLOW=chrome|passwords|popups|spaces|headers|privacy|drm|split|widgets|lasttab|slop|focus|harbor|shield|morning
 * Writes [flowtest] PASS/FAIL lines to OFFSHORE_TEST_LOG (and stdout) and exits 0/1.
 */
function setupTestFlows(): void {
  const flow = process.env['OFFSHORE_TEST_FLOW']
  if (!flow) return
  let failures = 0

  // Electron's main-process stdout does not survive every launch path (piped
  // through electron-vite, detached, GUI-launched), so the transcript goes to a
  // file the caller can read. OFFSHORE_TEST_LOG picks the path.
  const logPath = process.env['OFFSHORE_TEST_LOG'] || join(app.getPath('temp'), `offshore-flow-${flow}.log`)
  try {
    writeFileSync(logPath, '')
  } catch {
    /* fall back to stdout only */
  }
  const say = (line: string): void => {
    console.log(line)
    try {
      appendFileSync(logPath, `${line}\n`)
    } catch {
      /* stdout already carried it */
    }
  }
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (!ok) failures += 1
    say(`[flowtest] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  say(`[flowtest] armed: ${flow} (log: ${logPath})`)
  void app.whenReady().then(() => {
    setTimeout(() => {
      say('[flowtest] starting')
      void runFlow().catch((err) => {
        say(`[flowtest] crashed: ${err instanceof Error ? err.stack : String(err)}`)
        app.exit(1)
      })
    }, 4000)
  })

  const KNOWN_FLOWS = [
    'chrome', 'passwords', 'popups', 'spaces', 'headers', 'privacy',
    'drm', 'split', 'widgets', 'lasttab', 'slop', 'focus', 'harbor', 'shield', 'morning'
  ]

  async function runFlow(): Promise<void> {
    if (!KNOWN_FLOWS.includes(flow ?? '')) {
      say(`[flowtest] unknown flow: ${flow}`)
      app.exit(1)
      return
    }
    const w = await waitForWindow(20_000)
    if (!w) {
      say('[flowtest] no window appeared within 20s')
      app.exit(1)
      return
    }
    const dev = process.env['ELECTRON_RENDERER_URL']

    if (flow === 'headers') {
      // onSendHeaders reports the headers Chromium actually put on the wire, after
      // our onBeforeSendHeaders injection — the real thing Google sees.
      const captured: Record<string, string> = {}
      const ses = session.fromPartition(TAB_PARTITION)
      ses.webRequest.onSendHeaders({ urls: ['https://www.google.com/*'] }, (details) => {
        if (details.resourceType !== 'mainFrame') return
        for (const [k, v] of Object.entries(details.requestHeaders)) captured[k.toLowerCase()] = String(v)
      })

      w.tabs.navigate(null, 'https://www.google.com/search?q=youtube')
      say('[flowtest] navigating to google')
      await delay(8000)
      say(`[flowtest] captured ${Object.keys(captured).length} request headers`)
      for (const k of ['user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'accept-language']) {
        say(`[flowtest] HDR ${k}: ${captured[k] ?? '(absent)'}`)
      }
      check('sec-ch-ua present', !!captured['sec-ch-ua'])
      check('sec-ch-ua-mobile present', !!captured['sec-ch-ua-mobile'])
      check('sec-ch-ua-platform present', !!captured['sec-ch-ua-platform'])
      check('accept-language has en', (captured['accept-language'] ?? '').includes('en'))
      check(
        'UA reduced to frozen form',
        /Chrome\/\d+\.0\.0\.0/.test(captured['user-agent'] ?? ''),
        captured['user-agent']
      )
      check('UA carries no Electron token', !/electron/i.test(captured['user-agent'] ?? ''))
      const gurl = w.tabs.activeTab!.wc.getURL()
      const gbody: string = await w.tabs
        .activeTab!.wc.executeJavaScript(`document.body ? document.body.innerText.slice(0, 300) : ''`)
        .catch(() => '')
      const sorry = /unusual traffic|not a robot|sending the requests/i.test(gbody) || gurl.includes('/sorry/')
      say(`[flowtest] google url: ${gurl}`)
      say(`[flowtest] google not-blocked: ${!sorry}`)
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'drm') {
      // Widevine only answers on a secure origin, so probe from a real https page
      w.tabs.navigate(null, 'https://example.com')
      await delay(5000)
      const probe: string = await w.tabs
        .activeTab!.wc.executeJavaScript(
          `navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
             initDataTypes: ['cenc'],
             audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
             videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
           }]).then(a => 'ok:' + a.keySystem).catch(e => 'fail:' + e.message)`
        )
        .catch((e) => `err: ${e}`)
      say(`[flowtest] widevine probe: ${probe}`)
      check('widevine key system available', probe === 'ok:com.widevine.alpha', probe)
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'split') {
      const t1 = w.tabs.activeTab!
      w.tabs.navigate(null, 'https://example.com')
      await delay(1500)
      w.tabs.toggleSplit()
      await delay(600)
      const pair = w.tabs.splitPair
      check('split pair formed', pair !== null, JSON.stringify(pair))
      const t2 = w.tabs.tabsIn(t1.spaceId).find((t) => t.id !== t1.id)
      check('partner tab created', !!t2)
      if (pair && t2) {
        const b1 = t1.view.getBounds()
        const b2 = t2.view.getBounds()
        say(`[flowtest] bounds a=${JSON.stringify(b1)} b=${JSON.stringify(b2)}`)
        check('views sit side by side', b1.width > 100 && b2.width > 100 && b2.x >= b1.x + b1.width)
        check('both views visible', t1.view.getVisible() && t2.view.getVisible(), `t1=${t1.view.getVisible()} t2=${t2.view.getVisible()}`)
        // activating the partner keeps the split
        w.tabs.activateTab(t2.id)
        await delay(300)
        check('activating partner keeps split', w.tabs.splitPair !== null)
        // closing the partner dissolves it
        w.tabs.closeTab(t2.id)
        await delay(300)
        check('closing a half exits split', w.tabs.splitPair === null)
        const b3 = t1.view.getBounds()
        check('survivor takes full width', b3.width > b1.width + 50, JSON.stringify(b3))
      }
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'widgets') {
      if (!HOME_WIDGETS) {
        // the widget board is deliberately parked (see HOME_WIDGETS in
        // shared/types) — a red run here would only be reporting the flag
        say('[flowtest] widgets are parked behind HOME_WIDGETS — nothing to check')
        say('[flowtest] done: ALL PASS')
        app.exit(0)
        return
      }
      await delay(1500)
      const tab = w.tabs.activeTab
      if (!tab) {
        say(`[flowtest] no active tab (tabs=${w.tabs.tabs.length})`)
        app.exit(1)
        return
      }
      tab.wc.send('widgets:edit')
      await delay(800)
      const d: string = await tab.wc
        .executeJavaScript(
          `JSON.stringify({
             done: !!document.querySelector('.we-done'),
             tray: document.querySelectorAll('.we-tray-add').length,
             jiggling: document.querySelectorAll('.jiggle').length,
             removers: document.querySelectorAll('.widget-remove').length
           })`
        )
        .catch((e) => `err: ${e}`)
      say(`[flowtest] edit mode: ${d}`)
      check('Done button shows', d.includes('"done":true'), d)
      check('add tray lists available widgets', /"tray":[1-9]/.test(d))
      check('widgets jiggle with remove badges', /"jiggling":[1-9]/.test(d) && /"removers":[1-9]/.test(d))
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'lasttab') {
      const before = BrowserWindow.getAllWindows().length
      const only = w.tabs.activeTab!
      w.tabs.closeTab(only.id)
      await delay(900)
      check('window still open', BrowserWindow.getAllWindows().length === before)
      check('zero tabs is allowed', w.tabs.tabs.length === 0, `tabs=${w.tabs.tabs.length}`)
      const eh: string = await w.win.webContents
        .executeJavaScript(
          `JSON.stringify({home: !!document.querySelector('.start'), search: !!document.querySelector('.start-search input')})`
        )
        .catch((e) => `err: ${e}`)
      say(`[flowtest] empty home: ${eh}`)
      // The zero-tab home carries no search panel of its own — the omnibox takes
      // the cursor instead (see EmptyHome in App.tsx).
      check('home screen shows without a search panel', eh.includes('"home":true') && eh.includes('"search":false'))
      // typing in the home search conjures the first tab
      w.tabs.navigate(null, 'example.com')
      await delay(1200)
      check('typing creates the first tab', w.tabs.tabs.length === 1)
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'morning') {
      /**
       * The morning brief end to end, offline: the keepHistory-off enable card
       * and its one-click round-trip, an Ollama-composed brief against a
       * fixture server (digest hygiene asserted on the wire: hosts + titles,
       * never a URL, never a cookie), YouTube RSS picks with the watched video
       * excluded, the day gate (second tab plain, reload keeps the claim,
       * per-day cache never recomposes), dismiss, the heuristic tier when
       * Ollama is genuinely unreachable, and the thin-history gate.
       */
      if (!process.env['OFFSHORE_CLEAN_PROFILE']) {
        // seeds and clears history, flips keepHistory — never against a
        // lived-in profile
        say('[flowtest] morning flow requires OFFSHORE_CLEAN_PROFILE')
        app.exit(1)
        return
      }
      const { settingsStore, historyStore } = await import('./stores')
      const { morningBrief } = await import('./morningbrief')
      const D = 86_400_000

      // ---- fixture server: YouTube handle page + RSS, and a fake Ollama ----
      interface Logged {
        method: string
        url: string
        cookie: string | null
        body: string
      }
      const reqLog: Logged[] = []
      const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString()
      const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <title>Fixture Channel</title>
 <author><name>Fixture Channel</name></author>
 <entry>
  <yt:videoId>fixvid00001</yt:videoId>
  <title>Fixture video one</title>
  <published>${iso(1 * D)}</published>
 </entry>
 <entry>
  <yt:videoId>fixvid00002</yt:videoId>
  <title>Fixture video two</title>
  <published>${iso(2 * D)}</published>
 </entry>
</feed>`
      const chatReply = JSON.stringify({
        message: {
          content: JSON.stringify({
            greeting: 'Fixture morning.',
            topics: [
              { label: 'sourdough starter', query: 'sourdough starter', why: 'three guides this week' }
            ],
            siteNotes: [{ host: 'news.ycombinator.com', why: 'your quiet regular' }]
          })
        },
        done: true
      })
      const server = nodeHttp.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          reqLog.push({
            method: req.method ?? '',
            url: req.url ?? '',
            cookie: req.headers.cookie ?? null,
            body
          })
          const path = (req.url ?? '/').split('?')[0]
          if (path === '/@fixturechannel') {
            res.setHeader('content-type', 'text/html')
            res.end('<html><head><script>var d={"channelId":"UCabcdefghijklmnopqrstuv"}</script></head><body>fixture channel</body></html>')
          } else if (path === '/feeds/videos.xml') {
            res.setHeader('content-type', 'application/atom+xml')
            res.end(feedXml)
          } else if (path === '/api/tags') {
            res.setHeader('content-type', 'application/json')
            res.end('{"models":[{"name":"llama3.2:3b","details":{"parameter_size":"3.2B"}}]}')
          } else if (path === '/api/chat') {
            res.setHeader('content-type', 'application/json')
            res.end(chatReply)
          } else {
            res.statusCode = 404
            res.end('')
          }
        })
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      // a port that answers nothing — bound once, closed, then used as the
      // "Ollama is gone" address (connection refused, instantly)
      const deadServer = nodeHttp.createServer()
      await new Promise<void>((r) => deadServer.listen(0, '127.0.0.1', r))
      const deadPort = (deadServer.address() as { port: number }).port
      await new Promise<void>((r) => deadServer.close(() => r()))

      const shotDir = process.env['OFFSHORE_SHOT']
      const shoot = async (tab: NonNullable<typeof w.tabs.activeTab>, name: string): Promise<void> => {
        if (!shotDir) return
        mkdirSync(shotDir, { recursive: true })
        surface(w)
        w.tabs.setActiveVisible(true)
        await delay(900)
        const img = await tab.wc.capturePage()
        writeFileSync(join(shotDir, name), img.toPNG())
        say(`[flowtest] wrote ${join(shotDir, name)}`)
      }

      // a clean profile opens on the welcome page; the brief belongs to real
      // new tabs, so step past onboarding first
      settingsStore.set({ onboarded: true })

      // The window must be up and painting before any start tab is probed —
      // a never-shown window starves the page of frames and the card checks
      // with it (the chrome flow surfaces early for the same reason).
      surface(w)
      w.tabs.setActiveVisible(true)

      // Warm the renderer: the first start-page request of a dev run compiles
      // the page, which can take longer than any sane settle. Absorb it on a
      // throwaway tab (its enable-card claim is wiped right after).
      const tWarm = w.tabs.createTab()
      await settle(
        async () =>
          ((await tWarm.wc.executeJavaScript(`!!document.querySelector('.start-grid')`)) === true
            ? true
            : undefined),
        60_000
      )
      w.tabs.closeTab(tWarm.id)
      await delay(400)

      // ---- 1. keepHistory off: the enable card, once, on the first tab ----
      morningBrief.wipe()
      const t1 = w.tabs.createTab()
      const card1 = await settle(
        async () =>
          ((await t1.wc.executeJavaScript(`!!document.querySelector('.morning-card.enable')`)) === true
            ? true
            : undefined),
        15_000
      )
      check('enable card shows when history is off', card1 === true)
      await shoot(t1, 'enable-card.png')

      // ---- 2. its one button flips the setting, and no brief materializes ----
      await t1.wc.executeJavaScript(`(document.querySelector('.morning-enable-btn')?.click(), true)`)
      const flipped = await settle(
        async () => (settingsStore.get().keepHistory === true ? true : undefined),
        6000
      )
      check("the card's button flips keepHistory on", flipped === true)
      const confirm1 = JSON.parse(
        (await t1.wc.executeJavaScript(
          `JSON.stringify({done: (document.querySelector('.morning-enable-done')?.textContent ?? ''),
                           sites: document.querySelectorAll('.morning-site').length})`
        )) as string
      ) as { done: string; sites: number }
      check(
        'confirmation line shows, no brief from an empty history',
        confirm1.done.includes('History is on') && confirm1.sites === 0,
        JSON.stringify(confirm1)
      )

      // ---- 3. fixture history + fake Ollama: the composed brief ----
      historyStore.clear()
      const now = Date.now()
      historyStore.inject([
        // revisit bait: frecent but 5 days adrift
        { url: 'https://news.ycombinator.com/item?id=1', title: 'An engine that runs on tides', visitCount: 3, lastVisit: now - 5 * D },
        { url: 'https://news.ycombinator.com/item?id=2', title: 'The forgotten harbor light', visitCount: 3, lastVisit: now - 5 * D },
        { url: 'https://news.ycombinator.com/item?id=3', title: 'On small boats', visitCount: 3, lastVisit: now - 5 * D },
        { url: 'https://news.ycombinator.com/', title: 'Hacker News', visitCount: 3, lastVisit: now - 5 * D },
        // same-day control: heavily visited today must NOT read as "revisit"
        { url: 'https://example.org/', title: 'Example Domain', visitCount: 9, lastVisit: now },
        // topic cluster: 3 entries, 2 hosts
        { url: 'https://bread.example/guide', title: 'Sourdough starter guide', visitCount: 2, lastVisit: now - 2 * D },
        { url: 'https://loaves.example/feeding', title: 'Feeding a sourdough starter', visitCount: 2, lastVisit: now - 2 * D },
        { url: 'https://bread.example/hydration', title: 'Sourdough starter hydration', visitCount: 2, lastVisit: now - 2 * D },
        // channel page (handle) + watched control
        { url: 'https://www.youtube.com/@fixturechannel', title: 'Fixture Channel - YouTube', visitCount: 4, lastVisit: now - 2 * D },
        { url: 'https://www.youtube.com/watch?v=fixvid00002', title: 'Fixture video two - YouTube', visitCount: 1, lastVisit: now - 2 * D },
        // padding to clear the 4-host / 8-entry thin gate
        { url: 'https://tides.example/', title: 'Tide almanac', visitCount: 1, lastVisit: now - 3 * D },
        { url: 'https://charts.example/', title: 'Coastal charts', visitCount: 1, lastVisit: now - 3 * D }
      ])
      morningBrief.wipe()
      process.env['OLLAMA_HOST'] = `http://127.0.0.1:${port}`
      process.env['OFFSHORE_TEST_YT_ORIGIN'] = `http://127.0.0.1:${port}`
      const composed = await morningBrief.composeForTest()
      say(`[flowtest] composed: ${JSON.stringify(composed && { source: composed.source, sites: composed.sites.length, topics: composed.topics.length, videos: composed.videos.length })}`)
      const countAfterCompose = morningBrief.composeCountForTest()

      const t2 = w.tabs.createTab()
      say(`[flowtest] tabs: t1=${t1.id} t2=${t2.id} all=${JSON.stringify(w.tabs.tabs.map((t) => t.id))}`)
      const probeBrief = async (tab: typeof t2): Promise<{
        card: boolean
        greeting: string
        sites: string[]
        topics: string[]
        videos: string[]
      } | undefined> => {
        const raw = (await tab.wc.executeJavaScript(
          `JSON.stringify({
             card: !!document.querySelector('.morning-card'),
             greeting: document.querySelector('.morning-greeting')?.textContent ?? '',
             sites: [...document.querySelectorAll('.morning-site')].map((r) => r.textContent),
             topics: [...document.querySelectorAll('.morning-topic')].map((r) => r.textContent),
             videos: [...document.querySelectorAll('.morning-video .morning-main')].map((r) => r.textContent)
           })`
        )) as string
        const p = JSON.parse(raw) as { card: boolean; greeting: string; sites: string[]; topics: string[]; videos: string[] }
        return p.card ? p : undefined
      }
      const brief = await settle(async () => probeBrief(t2), 12_000)
      say(`[flowtest] brief DOM: ${JSON.stringify(brief)}`)
      check('the brief renders on the first start tab', !!brief)
      check('Ollama composed the greeting', brief?.greeting === 'Fixture morning.', brief?.greeting)
      const hnRow = (brief?.sites ?? []).find((s) => s.includes('news.ycombinator.com'))
      check('revisit row surfaces the drifted site', !!hnRow)
      check('siteNote merged onto the heuristic row', (hnRow ?? '').includes('your quiet regular'), hnRow)
      const allRows = [...(brief?.sites ?? []), ...(brief?.topics ?? []), ...(brief?.videos ?? [])]
      check('a same-day site is not "revisit" bait', !allRows.some((r) => r.includes('example.org')))
      check(
        'topic cluster surfaced',
        (brief?.topics ?? []).some((t) => t.toLowerCase().includes('sourdough'))
      )
      check(
        'one RSS pick, the watched video excluded',
        brief?.videos.length === 1 && brief?.videos[0] === 'Fixture video one',
        JSON.stringify(brief?.videos)
      )
      check(
        'handle resolved over the fixture',
        reqLog.some((l) => l.url.startsWith('/@fixturechannel'))
      )
      check(
        'channel feed fetched over the fixture',
        reqLog.some((l) => l.url.startsWith('/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv'))
      )
      check(
        'no fetch carries a cookie',
        reqLog.every((l) => l.cookie === null),
        JSON.stringify(reqLog.filter((l) => l.cookie !== null).map((l) => l.url))
      )
      await shoot(t2, 'brief.png')

      // ---- 4. digest hygiene: hosts and titles reach the model, URLs never ----
      say(`[flowtest] fixture requests: ${JSON.stringify(reqLog.map((l) => `${l.method} ${l.url}`))}`)
      const chat = reqLog.find((l) => l.method === 'POST' && l.url === '/api/chat')
      check('the model was asked once', !!chat && reqLog.filter((l) => l.url === '/api/chat').length === 1)
      check('digest names the top host', (chat?.body ?? '').includes('news.ycombinator.com'))
      check(
        'no URL reaches the model',
        !!chat && !/https?:\/\//.test(chat.body) && !chat.body.includes('watch?v='),
        (chat?.body ?? '').slice(0, 160)
      )
      let digestShape = ''
      try {
        const req = JSON.parse(chat?.body ?? '{}') as { messages?: { role: string; content: string }[] }
        const digest = JSON.parse(req.messages?.find((m) => m.role === 'user')?.content ?? '{}') as Record<string, unknown>
        const hostRows = (digest.topHosts as Record<string, unknown>[]) ?? []
        digestShape = JSON.stringify({
          keys: Object.keys(digest).sort(),
          hostKeys: [...new Set(hostRows.flatMap((h) => Object.keys(h)))].sort(),
          titles: Array.isArray(digest.recentTitles) && (digest.recentTitles as unknown[]).every((t) => typeof t === 'string')
        })
      } catch {
        digestShape = 'unparseable'
      }
      check(
        'digest shape is exactly hosts+titles+day+part',
        digestShape ===
          JSON.stringify({
            keys: ['dayOfWeek', 'partOfDay', 'recentTitles', 'topHosts'],
            hostKeys: ['daysSinceLast', 'host', 'visits'],
            titles: true
          }),
        digestShape
      )

      // ---- 5. the day gate: a second tab is plain; a reload keeps the claim ----
      const t3 = w.tabs.createTab()
      await settle(
        async () => ((await t3.wc.executeJavaScript(`!!document.querySelector('.start-grid')`)) === true ? true : undefined),
        10_000
      )
      await delay(1200)
      const t3card = await t3.wc.executeJavaScript(`!!document.querySelector('.morning-card')`)
      check('second tab of the day is plain', t3card === false)
      t2.wc.reload()
      const briefBack = await settle(async () => probeBrief(t2), 12_000)
      check("a reload keeps the claimant's brief", briefBack?.greeting === 'Fixture morning.')
      check(
        'the day is served from cache, never recomposed',
        morningBrief.composeCountForTest() === countAfterCompose,
        `composes=${morningBrief.composeCountForTest()} vs ${countAfterCompose}`
      )

      // ---- 6. dismiss consumes the day ----
      await t2.wc.executeJavaScript(`(document.querySelector('.morning-dismiss')?.click(), true)`)
      const dismissed = await settle(
        async () => ((await morningBrief.status()).todayState === 'dismissed' ? true : undefined),
        6000
      )
      check('dismiss lands in the stamp', dismissed === true)
      const t4 = w.tabs.createTab()
      await settle(
        async () => ((await t4.wc.executeJavaScript(`!!document.querySelector('.start-grid')`)) === true ? true : undefined),
        10_000
      )
      await delay(1200)
      check(
        'dismiss consumes the day',
        (await t4.wc.executeJavaScript(`!!document.querySelector('.morning-card')`)) === false
      )

      // ---- 7. stamp rollover + Ollama genuinely gone: heuristics carry it ----
      morningBrief.resetDayForTest()
      process.env['OLLAMA_HOST'] = `http://127.0.0.1:${deadPort}`
      const t5 = w.tabs.createTab()
      const fallback = await settle(async () => probeBrief(t5), 15_000)
      say(`[flowtest] fallback DOM: ${JSON.stringify(fallback)}`)
      check('stamp rollover shows the brief again', !!fallback)
      check(
        'heuristic greeting, a plain sentence',
        !!fallback && fallback.greeting !== 'Fixture morning.' && fallback.greeting.endsWith('.'),
        fallback?.greeting
      )
      check(
        'topics survive without the model',
        (fallback?.topics ?? []).some((t) => t.toLowerCase().includes('sourdough'))
      )
      check('the cache says heuristics', morningBrief.cacheForTest()?.source === 'heuristics')

      // ---- 8. thin history stays quiet and does not burn the day ----
      morningBrief.resetDayForTest()
      historyStore.clear()
      const t6 = w.tabs.createTab()
      await settle(
        async () => ((await t6.wc.executeJavaScript(`!!document.querySelector('.start-grid')`)) === true ? true : undefined),
        10_000
      )
      await delay(1500)
      const t6card = await t6.wc.executeJavaScript(`!!document.querySelector('.morning-card')`)
      const thinState = (await morningBrief.status()).todayState
      check('a thin history shows nothing', t6card === false)
      check('…and the day is not stamped', thinState === 'unseen', thinState)

      // ---- 9. cleanup: nothing leaks into the next flow ----
      settingsStore.set({ keepHistory: false }) // auto-clears history + wipes morning
      morningBrief.wipe()
      delete process.env['OLLAMA_HOST']
      delete process.env['OFFSHORE_TEST_YT_ORIGIN']
      server.close()
      settingsStore.flush()
      historyStore.flush()
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'slop') {
      const { settingsStore } = await import('./stores')
      // this flow flips the slop keys live — reset them on the way in so the
      // flow can run twice, and again on the way out (a crashed run must not
      // leave the shared profile with the detector off or the host quieted)
      const resetSlop = (): void => {
        const s = settingsStore.get()
        if (!s.slop.detector || !s.slop.highlight || s.slop.quiet.includes('127.0.0.1')) {
          settingsStore.set({
            slop: { detector: true, highlight: true, quiet: s.slop.quiet.filter((h) => h !== '127.0.0.1') }
          })
        }
      }
      resetSlop()
      const heavyPara = `In today's fast-paced digital landscape, it's important to note that businesses must
        delve into the ever-evolving landscape of technology. Moreover, this comprehensive guide
        will help you unlock the potential of your workflow. Furthermore, when it comes to
        navigating the complexities of modern tools, a holistic approach stands as a testament
        to innovation. Additionally, let's explore the rich tapestry of options — a treasure
        trove of possibilities. Ultimately, this game-changer will revolutionize the way you
        work, and not only saves time but also elevates your results. In conclusion, embark on
        a journey to seamlessly integrate these solutions.`
      const honestPara = (i: number): string => `The tide came in around four. We hauled the skiff past the wrack line and Tom
        checked the traps while I sorted bait, cold to the wrist. Gulls worked the shallows
        where the creek cuts the flat. Paragraph ${i} of an ordinary account, written the way
        a person writes when they are just saying what happened that afternoon.`
      const sloppy = `<html><body><article>${Array.from({ length: 14 }, () => `
        <p>${heavyPara}</p>`).join('')}</article></body></html>`
      const clean = `<html><body><article>${Array.from({ length: 14 }, (_, i) => `
        <p>${honestPara(i)}</p>`).join('')}</article></body></html>`
      // ~94 honest words carrying exactly two non-overlapping phrasebook hits
      // (block score 2·25·(100/94) ≈ 53 → orange), and ~92 with exactly one
      // (25·(100/92) ≈ 27 → yellow) — see scoreBlock in preload/internal.ts
      const midPara = `The market opened at seven and the stalls went up in the usual order, fish first,
        then bread. We found a plethora of small things worth carrying home: netting needles,
        a brass cleat, two jars of beach plum jam. The old chandlery table was a treasure
        trove for anyone patient enough to dig, and Tom dug until the vendor laughed at him.
        We paid, argued about coffee, and walked back along the seawall while the fog burned
        off the water. The gulls had opinions about all of it and said so from the rail.`
      const lowPara = `Low tide left the flats bare past the second marker and we went out with rakes and
        a bucket apiece. There were a myriad of small crabs working the weed line, and the
        clams showed themselves the way they always do, two holes and a squirt. Tom kept
        count out loud until he lost the number and started over. By noon we had enough for
        chowder and a little extra for the neighbor who lends us her truck, so we called it
        a day and hosed off the gear at the spigot.`
      const mixed = `<html><body><article>
        ${Array.from({ length: 4 }, (_, i) => `<p id="slop${i}">${heavyPara}</p>`).join('\n')}
        <p id="mid0">${midPara}</p>
        <p id="low0">${lowPara}</p>
        ${Array.from({ length: 4 }, (_, i) => `<p id="honest${i}">${honestPara(i)}</p>`).join('\n')}
        <ul><li id="nest0">${heavyPara}<p id="nest1">${heavyPara}</p></li></ul>
        <p id="bg0" style="background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)">${heavyPara}</p>
        <p id="stub0">We delve into old maps.</p>
      </article></body></html>`
      const server = nodeHttp.createServer((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(req.url === '/slop' ? sloppy : req.url?.startsWith('/mixed') ? mixed : clean)
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      const tab = (): typeof w.tabs.activeTab => w.tabs.activeTab
      const inPage = (js: string): Promise<unknown> => tab()!.wc.executeJavaScript(js)
      const inChrome = (js: string): Promise<unknown> => w.win.webContents.executeJavaScript(js)
      // A navigation wipes the old verdict before the new one lands — wait out
      // both halves, or the probe reads the previous page's report.
      const freshReport = async (): Promise<SlopReport | undefined> => {
        await settle(async () => (tab()?.slop === undefined ? true : undefined), 8000)
        return settle(async () => tab()?.slop, 12_000)
      }

      // -- a heavy page gets scored and worn on the chrome --
      w.tabs.navigate(null, `http://127.0.0.1:${port}/slop`)
      const report = await freshReport()
      say(
        `[flowtest] slop page score: ${report?.score ?? 'none'} — ${(report?.signals ?? [])
          .slice(0, 3)
          .map((s) => `${s.label} ×${s.count}`)
          .join(', ')}`
      )
      check('slop page flagged', (report?.score ?? 0) >= SLOP_FLAG_MIN, `score=${report?.score}`)
      check('slop page scores heavy', (report?.score ?? 0) >= SLOP_HEAVY_MIN, `score=${report?.score}`)
      check('report carries its receipts', (report?.signals.length ?? 0) > 0)
      const census = report?.blocks
      check(
        'report counts its blocks',
        (census?.total ?? 0) >= 14 && (census?.marked ?? 0) >= 14 && (census?.heavy ?? 0) >= 14,
        JSON.stringify(census)
      )
      const noVeil = await inPage(`!document.getElementById('offshore-slop-veil')`)
      check('no veil ever again', !('veil' in ((report ?? {}) as object)) && noVeil === true)

      const chip = await settle(async () => {
        const raw = (await inChrome(
          `JSON.stringify({chip: !!document.querySelector('.slop-chip'),
                           score: document.querySelector('.slop-score')?.textContent ?? ''})`
        )) as string
        const p = JSON.parse(raw) as { chip: boolean; score: string }
        return p.chip ? p : undefined
      }, 4000)
      check('chip on the address bar carries the score', chip?.score === String(report?.score ?? ''), JSON.stringify(chip))
      const chipShape = JSON.parse(
        (await inChrome(
          `(() => { const c = document.querySelector('.slop-chip')
             const s = c ? c.querySelector('svg') : null
             return JSON.stringify({ w: c ? c.getBoundingClientRect().width : 0,
                                     svg: s ? s.getBoundingClientRect().width : 0 }) })()`
        )) as string
      ) as { w: number; svg: number }
      // the actions cluster squares its buttons at 24px — the chip must opt out
      // or the icon gets flex-squeezed to nothing beside the digits
      check('chip wears the icon beside the number', chipShape.svg >= 10 && chipShape.w > 28, JSON.stringify(chipShape))

      // -- the chip opens the report --
      await inChrome(`document.querySelector('.slop-chip')?.click()`)
      const panel = await settle(async () => {
        const raw = (await inChrome(
          `JSON.stringify({panel: !!document.querySelector('.slop-panel'),
                           signals: document.querySelectorAll('.slop-signal').length,
                           sections: document.querySelector('.slop-sections')?.textContent ?? '',
                           primary: !!document.querySelector('.slop-action.primary'),
                           ticks: document.querySelectorAll('.slop-meter-tick').length})`
        )) as string
        const p = JSON.parse(raw) as {
          panel: boolean
          signals: number
          sections: string
          primary: boolean
          ticks: number
        }
        return p.panel ? p : undefined
      }, 4000)
      check('chip opens the slop report', !!panel)
      check('report lists the tells it counted', (panel?.signals ?? 0) > 0, `signals=${panel?.signals}`)
      check(
        'report tallies the barred sections',
        /\d+ of \d+ prose sections/.test(panel?.sections ?? ''),
        JSON.stringify(panel?.sections)
      )
      check('no Read anyway, no primary action', panel?.primary === false)
      check('meter wears its two threshold ticks', panel?.ticks === 2, `ticks=${panel?.ticks}`)
      await inChrome(`window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`)
      const panelGone = await settle(
        async () => ((await inChrome(`!document.querySelector('.slop-panel')`)) ? true : undefined),
        4000
      )
      check('Escape closes the report', panelGone === true)

      // -- the engineered mix: tiers, geometry, dedup, page art, stubs --
      w.tabs.navigate(null, `http://127.0.0.1:${port}/mixed`)
      const mixedReport = await freshReport()
      check(
        'mixed census: 8 of 13 marked, 6 heavy',
        mixedReport?.blocks.total === 13 && mixedReport?.blocks.marked === 8 && mixedReport?.blocks.heavy === 6,
        JSON.stringify(mixedReport?.blocks)
      )
      const geoRaw = (await inPage(
        `JSON.stringify({
           redTier:   document.getElementById('slop0').getAttribute('data-offshore-slop'),
           midTier:   document.getElementById('mid0').getAttribute('data-offshore-slop'),
           lowTier:   document.getElementById('low0').getAttribute('data-offshore-slop'),
           img:       document.getElementById('slop0').style.backgroundImage,
           size:      document.getElementById('slop0').style.backgroundSize,
           rep:       document.getElementById('slop0').style.backgroundRepeat,
           pos:       document.getElementById('slop0').style.backgroundPosition,
           midColor:  document.getElementById('mid0').style.backgroundImage,
           honest:    document.getElementById('honest0').hasAttribute('data-offshore-slop'),
           honestImg: document.getElementById('honest0').style.backgroundImage,
           nestOuter: document.getElementById('nest0').hasAttribute('data-offshore-slop'),
           nestInner: document.getElementById('nest1').hasAttribute('data-offshore-slop'),
           bgKept:    document.getElementById('bg0').style.backgroundImage.includes('url('),
           bgMarked:  document.getElementById('bg0').hasAttribute('data-offshore-slop'),
           stub:      document.getElementById('stub0').hasAttribute('data-offshore-slop')
         })`
      )) as string
      say(`[flowtest] mixed geometry: ${geoRaw}`)
      const geo = JSON.parse(geoRaw) as {
        redTier: string | null
        midTier: string | null
        lowTier: string | null
        img: string
        size: string
        rep: string
        pos: string
        midColor: string
        honest: boolean
        honestImg: string
        nestOuter: boolean
        nestInner: boolean
        bgKept: boolean
        bgMarked: boolean
        stub: boolean
      }
      check('tiers graded per block', geo.redTier === 'red' && geo.midTier === 'orange' && geo.lowTier === 'yellow')
      check(
        'bar painted as an edge stripe',
        geo.img.includes('linear-gradient') && geo.size === '3px 100%' && geo.rep === 'no-repeat' && geo.pos === 'left top'
      )
      check(
        'tier carries its color',
        geo.img.includes('rgba(219, 68, 55') && geo.midColor.includes('rgba(224, 122, 51')
      )
      check('honest prose wears nothing', geo.honest === false && geo.honestImg === '')
      check('nested prose wears one bar', geo.nestOuter === true && geo.nestInner === false)
      check('page art never clobbered', geo.bgKept === true && geo.bgMarked === true)
      check('stubs stay uncollected', geo.stub === false)

      // eyeball artifact: the bars, photographed on the engineered mix
      const shotDir = process.env['OFFSHORE_SHOT']
      if (shotDir) {
        mkdirSync(shotDir, { recursive: true })
        surface(w)
        w.tabs.setActiveVisible(true)
        await delay(900)
        const img = await tab()!.wc.capturePage()
        writeFileSync(join(shotDir, 'mixed-bars.png'), img.toPNG())
        say(`[flowtest] wrote ${join(shotDir, 'mixed-bars.png')}`)
      }

      // -- an SPA re-render sheds every scored element; the rescan re-owns it --
      const preMarks = (await inPage(
        `(() => {
           const a = document.querySelector('article')
           const before = document.querySelectorAll('[data-offshore-slop]').length
           a.replaceChildren(...[...a.children].map((c) => c.cloneNode(true)))
           const p = document.createElement('p')
           p.id = 'spa0'
           p.textContent = ${JSON.stringify(heavyPara)}
           a.appendChild(p)
           history.pushState({}, '', '/mixed2')
           return before
         })()`
      )) as number
      const spa = await settle(async () => {
        const raw = (await inPage(
          `JSON.stringify({
             marks: document.querySelectorAll('[data-offshore-slop]').length,
             spaTier: document.getElementById('spa0')?.getAttribute('data-offshore-slop') ?? '',
             spaImg: document.getElementById('spa0')?.style.backgroundImage ?? ''})`
        )) as string
        const p = JSON.parse(raw) as { marks: number; spaTier: string; spaImg: string }
        return p.spaTier === 'red' ? p : undefined
      }, 12_000)
      check(
        'bars survive an SPA re-render',
        spa?.marks === preMarks + 1 && spa?.spaTier === 'red' && (spa?.spaImg ?? '').includes('linear-gradient'),
        `pre=${preMarks} ${JSON.stringify(spa)}`
      )

      // -- the switches act on the page you're looking at --
      const s1 = settingsStore.get()
      settingsStore.set({ slop: { ...s1.slop, highlight: false } })
      const barsOff = await settle(async () => {
        const raw = (await inPage(
          `JSON.stringify({img: document.getElementById('slop0').style.backgroundImage,
                           tier: document.getElementById('slop0').getAttribute('data-offshore-slop') ?? ''})`
        )) as string
        const p = JSON.parse(raw) as { img: string; tier: string }
        return p.img === '' ? p : undefined
      }, 8000)
      check('bars off, marks stay', barsOff?.img === '' && barsOff?.tier === 'red', JSON.stringify(barsOff))
      settingsStore.set({ slop: { ...settingsStore.get().slop, highlight: true } })
      const barsBack = await settle(
        async () =>
          ((await inPage(
            `document.getElementById('slop0').style.backgroundImage.includes('linear-gradient')`
          )) === true
            ? true
            : undefined),
        8000
      )
      check('bars return with the switch', barsBack === true)
      settingsStore.set({ slop: { ...settingsStore.get().slop, detector: false } })
      const stripped = await settle(async () => {
        const marks = (await inPage(`document.querySelectorAll('[data-offshore-slop]').length`)) as number
        const chipGone = (await inChrome(`!document.querySelector('.slop-chip')`)) as boolean
        return marks === 0 && tab()?.slop === undefined && chipGone ? true : undefined
      }, 8000)
      check('detector off strips everything', stripped === true)
      settingsStore.set({ slop: { ...settingsStore.get().slop, detector: true } })
      const rescored = await settle(async () => tab()?.slop, 12_000)
      check('detector back on re-scores', (rescored?.score ?? 0) >= SLOP_HEAVY_MIN, `score=${rescored?.score}`)

      // -- a quieted host: no chip, no bars, the verdict stands for SiteInfo --
      const sq = settingsStore.get().slop
      settingsStore.set({
        slop: { ...sq, quiet: [...sq.quiet.filter((h) => h !== '127.0.0.1'), '127.0.0.1'] }
      })
      const quieted = await settle(async () => {
        const marks = (await inPage(`document.querySelectorAll('[data-offshore-slop]').length`)) as number
        const chipGone = (await inChrome(`!document.querySelector('.slop-chip')`)) as boolean
        return marks === 0 && chipGone && (tab()?.slop?.score ?? 0) >= SLOP_FLAG_MIN ? true : undefined
      }, 8000)
      check('quiet host: no chip, no bars, verdict kept', quieted === true, `score=${tab()?.slop?.score}`)
      await inChrome(`document.querySelector('.omni-tune')?.click()`)
      const si = await settle(async () => {
        const raw = (await inChrome(
          `JSON.stringify({panel: !!document.querySelector('.site-info'),
                           text: [...document.querySelectorAll('.site-info .si-text')].map((t) => t.textContent).join('|'),
                           wake: [...document.querySelectorAll('.site-info .si-action')].some((b) => b.textContent === 'Wake')})`
        )) as string
        const p = JSON.parse(raw) as { panel: boolean; text: string; wake: boolean }
        return p.panel ? p : undefined
      }, 4000)
      check(
        'SiteInfo keeps the score and offers Wake',
        (si?.text ?? '').includes('Detector quiet here — would score') && si?.wake === true,
        JSON.stringify(si)
      )
      await inChrome(
        `[...document.querySelectorAll('.site-info .si-action')].find((b) => b.textContent === 'Wake')?.click()`
      )
      const woken = await settle(async () => {
        const chipBack = (await inChrome(`!!document.querySelector('.slop-chip')`)) as boolean
        return !settingsStore.get().slop.quiet.includes('127.0.0.1') && chipBack ? true : undefined
      }, 8000)
      check('Wake un-quiets and the chip returns', woken === true)
      await inChrome(`window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`)

      // -- honest prose stays untouched --
      w.tabs.navigate(null, `http://127.0.0.1:${port}/clean`)
      const cleanReport = await freshReport()
      say(`[flowtest] clean page score: ${cleanReport?.score ?? 'none'}`)
      check('honest prose not flagged', (cleanReport?.score ?? 0) < SLOP_FLAG_MIN, `score=${cleanReport?.score}`)
      const cleanChip = await inChrome(`!document.querySelector('.slop-chip')`)
      check('no chip on honest prose', cleanChip === true)
      const cleanMarks = await inPage(`document.querySelectorAll('[data-offshore-slop]').length`)
      check('no marks on honest pages', cleanMarks === 0, `marks=${cleanMarks}`)

      resetSlop()
      // flows leave over app.exit, which skips the debounced save — write now
      settingsStore.flush()
      server.close()
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'shield') {
      /**
       * The built-in Shield end to end, offline: an empty list set plus
       * fixture custom rules ride the same engine paths the real lists do —
       * network block, wire silence, per-tab and lifetime counts, cosmetic
       * hide, per-site allow, and the row in Settings → Extensions flipping
       * the whole engine live. No assertion depends on a live list fetch.
       */
      const { settingsStore, shieldStatsStore } = await import('./stores')
      const { adblock } = await import('./adblock')

      const hits = new Map<string, number>()
      const hit = (p: string): number => hits.get(p) ?? 0
      const page = `<html><body><div class="ad-banner">AD</div><p id="content">hello</p>
        <script src="/ads/ad.js"></script><img src="/track/pixel.gif"></body></html>`
      const server = nodeHttp.createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0]
        hits.set(path, (hits.get(path) ?? 0) + 1)
        if (path === '/ads/ad.js') {
          res.setHeader('content-type', 'text/javascript')
          res.end('window.adLoaded = true')
        } else if (path === '/track/pixel.gif') {
          res.setHeader('content-type', 'image/gif')
          res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'))
        } else {
          res.setHeader('content-type', 'text/html')
          res.end(page)
        }
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      const tab = (): typeof w.tabs.activeTab => w.tabs.activeTab
      const inPage = (js: string): Promise<unknown> => tab()!.wc.executeJavaScript(js)

      // proof the deep-merge delivered the full default set to this profile —
      // logged before the flow touches the lists, so a pre-seeded old-shape
      // settings.json shows its migration here
      say(`[flowtest] lists at boot: ${JSON.stringify(settingsStore.get().adblock.lists)}`)

      // -- 1. the default set is uBO's out-of-box lists (+ Harbor's cookie backstop) --
      const defaults = ADBLOCK_LISTS.filter((l) => l.defaultOn).map((l) => l.id).sort()
      const wanted = [
        'easylist', 'easylist-cookie', 'easyprivacy', 'peter-lowe', 'ublock-ads', 'ublock-badware',
        'ublock-privacy', 'ublock-quick-fixes', 'ublock-unbreak', 'urlhaus'
      ]
      check(
        "defaults match uBO's out-of-box set (+ easylist-cookie)",
        JSON.stringify(defaults) === JSON.stringify(wanted),
        defaults.join(',')
      )

      // -- setup: offline-deterministic engine — no lists, fixture custom rules --
      const before = settingsStore.get().adblock
      const statsBefore = shieldStatsStore.get().blockedTotal
      settingsStore.set({
        adblock: {
          enabled: true,
          lists: Object.fromEntries(ADBLOCK_LISTS.map((l) => [l.id, false])),
          customRules: '/ads/ad.js$script\n/track/pixel.gif$image\n127.0.0.1##.ad-banner',
          allowlist: []
        }
      })

      // rebuild is async with no exposed completion — navigate a tokened URL
      // and retry until the engine answers; only the judged load counts
      let nav = 0
      const loadPage = async (): Promise<void> => {
        nav += 1
        w.tabs.navigate(null, `http://127.0.0.1:${port}/page?t=${nav}`)
        await settle(
          async () =>
            ((await inPage(
              `location.search === '?t=${nav}' && document.readyState === 'complete'`
            )) === true
              ? true
              : undefined),
          8000
        )
        await delay(300)
      }
      const adLoaded = async (): Promise<boolean> => (await inPage('window.adLoaded === true')) === true
      const converge = async (want: boolean, tries: number): Promise<boolean> => {
        for (let i = 0; i < tries; i++) {
          await loadPage()
          if ((await adLoaded()) === want) return true
          await delay(1500)
        }
        return false
      }
      const engineUp = await converge(false, 12)
      say(`[flowtest] engine converged: ${engineUp}`)

      // -- 2–3. the judged load: blocked in the page, silent on the wire --
      hits.clear()
      await loadPage()
      check('known-bad script blocked', (await inPage('window.adLoaded === undefined')) === true)
      check(
        'blocked request never reached the wire',
        hit('/page') >= 1 && hit('/ads/ad.js') === 0 && hit('/track/pixel.gif') === 0,
        JSON.stringify([...hits])
      )

      // -- 4. the per-tab count reaches TabInfo --
      const counted = await settle(async () => {
        const n = adblock.counts.get(tab()!.id) ?? 0
        return n >= 2 ? n : undefined
      }, 4000)
      check('blocked count increments', (counted ?? 0) >= 2, `count=${counted ?? adblock.counts.get(tab()!.id)}`)

      // -- 5. the cosmetic rule hides the banner --
      const hidden = await settle(
        async () =>
          ((await inPage(`getComputedStyle(document.querySelector('.ad-banner')).display`)) === 'none'
            ? true
            : undefined),
        6000
      )
      check('cosmetic rule hides the banner', hidden === true)

      // -- 6. the lifetime ledger advances --
      const lifetime = await settle(async () => {
        const n = shieldStatsStore.get().blockedTotal
        return n >= statsBefore + 2 ? n : undefined
      }, 4000)
      check(
        'lifetime counter advances',
        (lifetime ?? 0) >= statsBefore + 2,
        `total=${shieldStatsStore.get().blockedTotal} before=${statsBefore}`
      )

      // -- 7. per-site allow un-breaks the page (and the count reads honest) --
      const allowed = adblock.toggleSite('127.0.0.1')
      const through = await converge(true, 6)
      const countAllowed = adblock.counts.get(tab()!.id) ?? 0
      check(
        'per-site allow lets the page through',
        allowed === true && through && countAllowed === 0,
        `allowed=${allowed} through=${through} count=${countAllowed}`
      )

      // -- 8. revoking the allow restores blocking --
      const revoked = adblock.toggleSite('127.0.0.1')
      const blockedAgain = await converge(false, 6)
      check('revoking allow restores blocking', revoked === false && blockedAgain, `revoked=${revoked}`)

      // -- 9. Shield worn as a built-in in Settings → Extensions --
      const openExtensions = async (): Promise<void> => {
        w.tabs.navigate(null, 'offshore://settings')
        await settle(
          async () =>
            ((await inPage(`!!document.querySelector('.settings-nav')`).catch(() => false)) === true
              ? true
              : undefined),
          10_000
        )
        await inPage(
          `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Extensions')?.click(), 0`
        )
      }
      await openExtensions()
      const row = await settle(async () => {
        const raw = (await inPage(
          `(() => {
             const t = [...document.querySelectorAll('.row-title')].find((el) => el.textContent.trim().startsWith('Shield'))
             return JSON.stringify({ title: !!t, sub: t?.querySelector('.row-sub')?.textContent ?? '' })
           })()`
        )) as string
        const p = JSON.parse(raw) as { title: boolean; sub: string }
        return p.title && p.sub.includes('blocked so far') ? p : undefined
      }, 10_000)
      check('Shield worn as a built-in', !!row, JSON.stringify(row))

      // -- 10. the row's toggle is the engine's switch, both directions, live --
      const clickShieldToggle = async (): Promise<void> => {
        await inPage(
          `[...document.querySelectorAll('.row-title')]
             .find((el) => el.textContent.trim().startsWith('Shield'))
             ?.closest('.row')?.querySelector('button.toggle')?.click(), 0`
        )
      }
      await clickShieldToggle()
      const offInStore = await settle(
        async () => (settingsStore.get().adblock.enabled === false ? true : undefined),
        6000
      )
      const engineOff = offInStore === true && (await converge(true, 6))
      check('extension row toggles the Shield off live', engineOff, `store=${offInStore}`)
      await openExtensions()
      await clickShieldToggle()
      const onInStore = await settle(
        async () => (settingsStore.get().adblock.enabled === true ? true : undefined),
        6000
      )
      // the row's on-flip restores the standard lists (a live fetch) — put the
      // flow back on its offline fixture set; rebuilds serialize, so the last
      // set wins no matter how slowly the list build lands
      settingsStore.set({
        adblock: {
          ...settingsStore.get().adblock,
          lists: Object.fromEntries(ADBLOCK_LISTS.map((l) => [l.id, false]))
        }
      })
      const engineBack = onInStore === true && (await converge(false, 20))
      check('extension row toggles the Shield back on live', engineBack, `store=${onInStore}`)

      say(`[flowtest] lifetime stats: ${JSON.stringify(shieldStatsStore.get())}`)

      // teardown: app.exit skips debounced saves, and mutated settings must
      // not leak into the next flow — restore, then write now
      settingsStore.set({ adblock: before })
      settingsStore.flush()
      shieldStatsStore.flush()
      server.close()
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'focus') {
      /**
       * The Focus built-in, end to end: strip (tiers, token tripwires),
       * compaction (the emptied grid track really goes to the content, the
       * comments hole closes), the observer against a page that fights back,
       * per-site persistence across a reload, a full live restore, and the
       * master switch. The grid fixture is built so naive hiding would leave
       * an obvious hole.
       */
      const prose = Array.from({ length: 10 }, (_, i) =>
        `The tide came in around four and we hauled the skiff past the wrack line. Tom checked
         the traps while I sorted bait, cold to the wrist, and the gulls worked the shallows
         where the creek cuts the flat. Sentence ${i} of a plain account of the afternoon.`
      ).join(' ')
      const gridPage = `<html><body>
        <div id="cookie" class="cookie-banner"
             style="position:fixed;bottom:0;left:0;right:0;height:64px;background:#222;color:#fff">
          We value your privacy</div>
        <div id="sticky" style="position:fixed;top:0;left:0;right:0;height:48px;background:#333;color:#fff">
          subscribe to our newsletter</div>
        <div id="shell" style="display:grid;grid-template-columns:220px 1fr 300px;gap:24px;padding:24px">
          <nav id="leftnav"><a href="#a">Section A</a><a href="#b">Section B</a></nav>
          <main id="content">
            <article id="story">
              <h1>An honest page</h1>
              <p id="p1">${prose}</p>
              <div id="inline-promo" class="promo-box" style="height:120px">Subscribe now!</div>
              <p id="p2">${prose}</p>
              <p class="commentary">A paragraph of commentary that must survive.</p>
              <div class="broadcast" id="tripwire-broadcast">Broadcast schedule (must survive)</div>
              <div class="badge" id="tripwire-badge">A badge (must survive)</div>
            </article>
            <section id="comments" style="min-height:400px"><h2>Comments</h2><p>hot takes</p></section>
          </main>
          <div id="railwrap" style="padding:24px;border-left:1px solid #ccc">
            <aside id="rail" class="sidebar">
              <div class="advert" id="ad1" style="height:600px">ad</div>
              <div class="related" id="rel">You may also like</div>
            </aside>
          </div>
        </div>
        <footer id="footer">colophon</footer>
        <script>
          setInterval(() => {                       // the page fights back
            if (!document.getElementById('sticky')) {
              const d = document.createElement('div')
              d.id = 'sticky'
              d.style.cssText = 'position:fixed;top:0;left:0;right:0;height:48px;background:#333'
              d.textContent = 'the bar is back'
              document.body.prepend(d)
            }
          }, 700)
        </script>
      </body></html>`
      const flexPage = `<html><body>
        <div id="row" style="display:flex;gap:24px">
          <main id="main" style="width:70%"><p>${prose}</p></main>
          <aside id="aside" class="sidebar" style="width:30%">rail</aside>
        </div>
      </body></html>`
      const plainPage = `<html><body>
        <article id="plainstory">
          <h1>Nothing to strip</h1>
          <p>${prose}</p>
          <p class="commentary">A paragraph of commentary that must survive.</p>
          <div class="broadcast">Broadcast schedule (must survive)</div>
          <div class="badge">A badge (must survive)</div>
        </article>
      </body></html>`
      const server = nodeHttp.createServer((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(req.url === '/flexcase' ? flexPage : req.url === '/plain' ? plainPage : gridPage)
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      const { focusStore } = await import('./focus')
      const { settingsStore } = await import('./stores')
      // this flow owns its host's Focus flag, coming and going
      focusStore.set('127.0.0.1', false)
      const tab = (): typeof w.tabs.activeTab => w.tabs.activeTab
      const inPage = (js: string): Promise<unknown> => tab()!.wc.executeJavaScript(js)
      const inChrome = (js: string): Promise<unknown> => w.win.webContents.executeJavaScript(js)

      // 1. the chip is on the bar, idle, and the pristine geometry is on record
      w.tabs.navigate(null, `http://127.0.0.1:${port}/`)
      const chipIdle = await settle(async () => {
        const raw = (await inChrome(
          `JSON.stringify({chip: !!document.querySelector('.focus-chip'),
                           active: !!document.querySelector('.focus-chip.active')})`
        )) as string
        const p = JSON.parse(raw) as { chip: boolean; active: boolean }
        return p.chip ? p : undefined
      }, 10_000)
      check('chip on the address bar, idle', chipIdle?.chip === true && chipIdle?.active === false, JSON.stringify(chipIdle))
      check('tab reports Focus off', tab()!.info().focusOn === false)
      const before = await settle(async () => {
        const raw = (await inPage(`(() => {
          const c = document.getElementById('content'), s = document.getElementById('shell')
          if (!c || !s) return ''
          return JSON.stringify({ contentW: c.getBoundingClientRect().width,
                                  cols: getComputedStyle(s).gridTemplateColumns })
        })()`)) as string
        return raw ? (JSON.parse(raw) as { contentW: number; cols: string }) : undefined
      }, 10_000)
      say(`[flowtest] pristine: ${JSON.stringify(before)}`)
      check('pristine geometry read', !!before && before.cols.split(' ').length === 3, JSON.stringify(before))

      // 2. the chip flips Focus on, for the site
      await inChrome(`document.querySelector('.focus-chip')?.click()`)
      const storeOn = await settle(async () => (focusStore.isOn('127.0.0.1') ? true : undefined), 4000)
      check('chip toggles Focus on for the site', storeOn === true)
      check('tab reports Focus on', tab()!.info().focusOn === true)
      const chipLit = await settle(
        () => inChrome(`!!document.querySelector('.focus-chip.active')`) as Promise<boolean>,
        4000
      )
      check('chip lights up', chipLit === true)

      // 3. strip: every tier lands, the reading stands
      const stripped = await settle(async () => {
        const raw = (await inPage(`(() => {
          const d = (id) => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'gone' }
          return JSON.stringify({
            ad1: d('ad1'), rel: d('rel'), rail: d('rail'), railwrap: d('railwrap'),
            cookie: d('cookie'), sticky: d('sticky'), promo: d('inline-promo'), comments: d('comments'),
            p1: d('p1'), p2: d('p2'), leftnav: d('leftnav'), story: d('story'), footer: d('footer')
          })
        })()`)) as string
        const p = JSON.parse(raw) as Record<string, string>
        return p.rail === 'none' && p.railwrap === 'none' && p.comments === 'none' ? p : undefined
      }, 8000)
      say(`[flowtest] stripped: ${JSON.stringify(stripped)}`)
      check('tier 2 hides the ads and the rail', stripped?.ad1 === 'none' && stripped?.rel === 'none' && stripped?.rail === 'none')
      check('an emptied wrapper cascades away', stripped?.railwrap === 'none')
      check('tier 3 hides the viewport riders', stripped?.cookie === 'none' && stripped?.sticky === 'none')
      check('the in-article promo goes too', stripped?.promo === 'none')
      check('comments are stripped', stripped?.comments === 'none')
      check(
        'the reading survives',
        stripped?.p1 === 'block' && stripped?.p2 === 'block' && stripped?.story === 'block' &&
          stripped?.leftnav === 'block' && stripped?.footer === 'block'
      )

      // 4. token verification spares near-miss names
      const tripwires = JSON.parse(
        (await inPage(`(() => {
          const ok = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.hasAttribute('data-offshore-focus')
          return JSON.stringify({
            commentary: ok(document.querySelector('.commentary')),
            broadcast: ok(document.getElementById('tripwire-broadcast')),
            badge: ok(document.getElementById('tripwire-badge'))
          })
        })()`)) as string
      ) as Record<string, boolean>
      check('tripwires survive token verification', tripwires.commentary && tripwires.broadcast && tripwires.badge, JSON.stringify(tripwires))

      // 5. compaction, horizontal: the dead 300px track (and its gap) goes to the content
      const focused = await settle(async () => {
        const raw = (await inPage(`JSON.stringify({
          contentW: document.getElementById('content').getBoundingClientRect().width,
          cols: getComputedStyle(document.getElementById('shell')).gridTemplateColumns
        })`)) as string
        const p = JSON.parse(raw) as { contentW: number; cols: string }
        return p.contentW - (before?.contentW ?? Infinity) >= 240 ? p : undefined
      }, 8000)
      say(`[flowtest] focused geometry: ${JSON.stringify(focused)}`)
      check(
        'the emptied track goes to the content',
        (focused?.contentW ?? 0) - (before?.contentW ?? Infinity) >= 240,
        `${before?.contentW} → ${focused?.contentW}`
      )
      check('the dead grid track is removed', (focused?.cols ?? '').split(' ').length === 2, focused?.cols)

      // 6. compaction, vertical: no 400px comments hole above the footer
      const vgap = Number(
        await inPage(
          `document.getElementById('footer').getBoundingClientRect().top - document.getElementById('story').getBoundingClientRect().bottom`
        )
      )
      check('no comments hole above the footer', vgap <= 150, `gap=${Math.round(vgap)}`)

      // 7. the page fights back; the observer puts the bar away again
      await inPage(`document.getElementById('sticky').remove(), 0`)
      const reasserted = await settle(async () => {
        const s = (await inPage(`(() => {
          const el = document.getElementById('sticky')
          return el ? getComputedStyle(el).display : 'gone'
        })()`)) as string
        return s === 'none' ? true : undefined
      }, 6000)
      check('a re-inserted sticky is re-hidden', reasserted === true)

      // 8. persistence: strip and compaction both replay on a fresh document
      tab()!.wc.reload()
      const replayed = await settle(async () => {
        const raw = (await inPage(`(() => {
          const rail = document.getElementById('rail'), c = document.getElementById('content')
          if (!rail || !c) return ''
          return JSON.stringify({ rail: getComputedStyle(rail).display, contentW: c.getBoundingClientRect().width })
        })()`).catch(() => '')) as string
        if (!raw) return undefined
        const p = JSON.parse(raw) as { rail: string; contentW: number }
        return p.rail === 'none' && Math.abs(p.contentW - (focused?.contentW ?? Infinity)) <= 24 ? p : undefined
      }, 10_000)
      check('strip and compaction replay on reload', !!replayed, JSON.stringify(replayed))

      // 9. live restore: off = exactly the page as served
      w.tabs.toggleFocus()
      const restored = await settle(async () => {
        const raw = (await inPage(`(() => {
          const d = (id) => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'gone' }
          return JSON.stringify({
            rail: d('rail'), railwrap: d('railwrap'), cookie: d('cookie'), sticky: d('sticky'),
            promo: d('inline-promo'), comments: d('comments'),
            contentW: document.getElementById('content').getBoundingClientRect().width,
            cols: getComputedStyle(document.getElementById('shell')).gridTemplateColumns,
            marks: document.querySelectorAll('[data-offshore-focus]').length
          })
        })()`)) as string
        const p = JSON.parse(raw) as { rail: string; marks: number }
        return p.rail === 'block' && p.marks === 0 ? (JSON.parse(raw) as Record<string, unknown>) : undefined
      }, 8000)
      say(`[flowtest] restored: ${JSON.stringify(restored)}`)
      check(
        'toggle off restores every element',
        restored?.rail === 'block' && restored?.railwrap === 'block' && restored?.cookie === 'block' &&
          restored?.sticky === 'block' && restored?.promo === 'block' && restored?.comments === 'block'
      )
      check(
        'geometry restored',
        Math.abs(Number(restored?.contentW) - (before?.contentW ?? Infinity)) <= 24 &&
          String(restored?.cols).split(' ').length === 3,
        JSON.stringify(restored)
      )
      check('zero marks left behind', restored?.marks === 0)
      check('the site leaves the ledger', !focusStore.isOn('127.0.0.1') && !focusStore.sites().includes('127.0.0.1'))

      // 10. flex survivor: the single survivor takes the row, and gives it back
      w.tabs.navigate(null, `http://127.0.0.1:${port}/flexcase`)
      await settle(async () => ((await inPage(`!!document.getElementById('row')`).catch(() => false)) ? true : undefined), 8000)
      w.tabs.toggleFocus()
      const flexed = await settle(async () => {
        const raw = (await inPage(`(() => {
          const aside = document.getElementById('aside'), main = document.getElementById('main'), row = document.getElementById('row')
          if (!aside || !main || !row) return ''
          return JSON.stringify({ aside: getComputedStyle(aside).display,
                                  mainW: main.getBoundingClientRect().width, rowW: row.clientWidth })
        })()`)) as string
        if (!raw) return undefined
        const p = JSON.parse(raw) as { aside: string; mainW: number; rowW: number }
        return p.aside === 'none' && p.mainW >= 0.9 * p.rowW ? p : undefined
      }, 8000)
      check('the flex survivor takes the row', !!flexed, JSON.stringify(flexed))
      w.tabs.toggleFocus()
      const unflexed = await settle(async () => {
        const raw = (await inPage(`JSON.stringify({
          aside: getComputedStyle(document.getElementById('aside')).display,
          mainW: document.getElementById('main').getBoundingClientRect().width,
          rowW: document.getElementById('row').clientWidth
        })`)) as string
        const p = JSON.parse(raw) as { aside: string; mainW: number; rowW: number }
        return p.aside !== 'none' && Math.abs(p.mainW - 0.7 * p.rowW) <= 24 ? p : undefined
      }, 8000)
      check('toggle off hands the width back', !!unflexed, JSON.stringify(unflexed))

      // 11. do no harm: an honest page comes through untouched
      w.tabs.navigate(null, `http://127.0.0.1:${port}/plain`)
      await settle(async () => ((await inPage(`!!document.getElementById('plainstory')`).catch(() => false)) ? true : undefined), 8000)
      const plainLen = Number(await inPage(`document.body.innerText.length`))
      w.tabs.toggleFocus()
      await delay(2000)
      const harm = JSON.parse(
        (await inPage(`JSON.stringify({
          marks: document.querySelectorAll('[data-offshore-focus]').length,
          len: document.body.innerText.length
        })`)) as string
      ) as { marks: number; len: number }
      check('an honest page is untouched', harm.marks === 0 && harm.len === plainLen, JSON.stringify({ ...harm, plainLen }))
      w.tabs.toggleFocus()

      // 12. the master switch acts on open pages; site memory survives it
      w.tabs.navigate(null, `http://127.0.0.1:${port}/`)
      await settle(async () => ((await inPage(`!!document.getElementById('rail')`).catch(() => false)) ? true : undefined), 8000)
      w.tabs.toggleFocus()
      await settle(async () => ((await inPage(`getComputedStyle(document.getElementById('rail')).display`)) === 'none' ? true : undefined), 8000)
      settingsStore.set({ focus: { enabled: false } })
      const masterOff = await settle(async () => {
        const railBack = (await inPage(`getComputedStyle(document.getElementById('rail')).display`)) === 'block'
        const chipGone = (await inChrome(`!document.querySelector('.focus-chip')`)) === true
        return railBack && chipGone ? true : undefined
      }, 8000)
      check('the master switch restores pages and hides the chip', masterOff === true)
      settingsStore.set({ focus: { enabled: true } })
      const masterBack = await settle(
        async () => ((await inPage(`getComputedStyle(document.getElementById('rail')).display`)) === 'none' ? true : undefined),
        8000
      )
      check('re-enabling honors the site memory', masterBack === true)

      focusStore.set('127.0.0.1', false)
      // flows leave over app.exit, which skips the debounced save — write now
      focusStore.flush()
      settingsStore.flush()
      server.close()
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'harbor') {
      /**
       * Harbor end to end: consent auto-answer through the real autoconsent
       * eval pipeline against a Cookiebot-shaped fixture, tracker-cookie
       * stripping (with a guard-off control run so the header check can never
       * pass vacuously), the never-touch and document exemptions, the tide
       * with an injected clock, the undo stash, the engagement file's shape,
       * and the per-site panel riding the freeze-frame contract.
       */
      if (!process.env['OFFSHORE_CLEAN_PROFILE']) {
        // the tide step forces the grace period open and sweeps the real jar —
        // never against a lived-in profile
        say('[flowtest] harbor flow requires OFFSHORE_CLEAN_PROFILE')
        app.exit(1)
        return
      }
      const { settingsStore, bookmarksStore } = await import('./stores')
      const { harbor } = await import('./harbor')
      const ses = session.fromPartition(TAB_PARTITION)
      const DAY = 86_400_000
      const origCreatedAt = harbor.engagementCreatedAt()

      const reqLog: string[] = []
      const trackedPage = (g: string, port: number): string => `<html><body>
        <p>An honest little page that happens to carry a third-party pixel.</p>
        <img src="http://127.0.0.1:${port}/pixel.gif?g=${g}">
        <script>fetch('http://127.0.0.1:${port}/beacon?g=${g}', { credentials: 'include' }).catch(() => {})</script>
      </body></html>`
      // Cookiebot-shaped fixture, mirrored from the pinned dynamic rule
      // (lib/cmps/cookiebot.ts + EVAL_COOKIEBOT_1..5): detection wants
      // window.Cookiebot with an open dialog, opt-out goes withdraw() then
      // hide(), self-test reads declined.
      const cmpPage = `<html><head><script>
        window.Cookiebot = {
          hasResponse: false, declined: false, dialog: { visible: true },
          withdraw() { this.declined = true; this.hasResponse = true; return true },
          hide() { document.getElementById('CybotCookiebotDialog').style.display = 'none';
                   this.dialog.visible = false; return true }
        }
      </script></head><body>
        <div id="CybotCookiebotDialog" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#123;color:#fff">
          We value your privacy</div>
        <p>A page with a cookie prompt on it.</p>
      </body></html>`
      const server = nodeHttp.createServer((req, res) => {
        const [path, query = ''] = (req.url ?? '/').split('?')
        if (path === '/pixel.gif' || path === '/beacon') {
          reqLog.push(`${path}?${query} ${req.headers.cookie ?? '(none)'}`)
          res.setHeader('set-cookie', 'track=1; Path=/')
          if (path === '/pixel.gif') {
            res.setHeader('content-type', 'image/gif')
            res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'))
          } else {
            // credentialed cross-origin fetch: without these the request still
            // arrives (that's what the log reads) but the console fills with noise
            res.setHeader('access-control-allow-origin', `http://localhost:${port}`)
            res.setHeader('access-control-allow-credentials', 'true')
            res.end('ok')
          }
          return
        }
        res.setHeader('content-type', 'text/html')
        if (path === '/cmp') res.end(cmpPage)
        else if (path === '/tracked') res.end(trackedPage(query.replace(/^g=/, '') || '0', port))
        else if (path === '/framed') res.end(`<html><body><iframe src="http://127.0.0.1:${port}/frame"></iframe></body></html>`)
        else if (path === '/frame') {
          res.setHeader('set-cookie', 'framecookie=1; Path=/')
          res.end('<html><body>frame</body></html>')
        } else res.end('<html><body>plain</body></html>')
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      const local = (p: string): string => `http://localhost:${port}${p}`
      const third = (p: string): string => `http://127.0.0.1:${port}${p}`
      const tab = (): typeof w.tabs.activeTab => w.tabs.activeTab
      const inPage = (js: string): Promise<unknown> => tab()!.wc.executeJavaScript(js)
      const inChrome = (js: string): Promise<unknown> => w.win.webContents.executeJavaScript(js)

      // the Shield is deliberately no part of Harbor (separate engine, separate
      // switch) — take it out of the fixture's way so no ad list can eat the
      // tracker requests this flow asserts on
      const shieldWasOn = settingsStore.get().adblock.enabled
      settingsStore.set({ adblock: { ...settingsStore.get().adblock, enabled: false } })

      const cleanup = async (): Promise<void> => {
        const s = settingsStore.get().privacy
        settingsStore.set({
          adblock: { ...settingsStore.get().adblock, enabled: shieldWasOn },
          privacy: {
            ...s,
            cookieGuard: true,
            blockSites: s.blockSites.filter((d) => d !== '127.0.0.1'),
            keepSites: s.keepSites.filter((d) => d !== 'localhost')
          }
        })
        for (const d of ['stale.example', 'fresh.example', 'kept.example']) {
          harbor.engagementDelete(d)
          harbor.stashDelete(d)
          for (const c of await ses.cookies.get({ url: `https://${d}/` })) {
            await ses.cookies.remove(`https://${d}${c.path ?? '/'}`, c.name).catch(() => {})
          }
        }
        harbor.engagementSetCreatedAt(origCreatedAt)
        settingsStore.flush()
        harbor.flush()
      }

      // -- 1. consent: the fixture CMP gets auto-answered, most private --
      // the page console is the only witness if the consent adapter faults
      tab()!.wc.on('console-message', ((...args: unknown[]) => {
        const ev = args[0] as { message?: string }
        const msg = typeof args[2] === 'string' ? args[2] : (ev?.message ?? '')
        if (msg) say(`[flowtest] page console: ${String(msg).slice(0, 300)}`)
      }) as never)
      w.tabs.navigate(null, local('/cmp'))
      const declined = await settle(
        async () =>
          (await inPage(`!!(window.Cookiebot && window.Cookiebot.declined === true)`).catch(() => false)) === true
            ? true
            : undefined,
        15_000
      )
      check('consent auto-answered most-private', declined === true)
      const dlgGone = await settle(
        async () =>
          (await inPage(
            `getComputedStyle(document.getElementById('CybotCookiebotDialog')).display === 'none'`
          ).catch(() => false)) === true
            ? true
            : undefined,
        5000
      )
      check('banner gone', dlgGone === true)
      const verdict = await settle(async () => {
        const p = tab()!.info().privacy
        return p?.consent === 'handled' ? p : undefined
      }, 8000)
      check(
        'tab wears the consent verdict',
        verdict?.consent === 'handled' && verdict?.cmp === 'Cybotcookiebot',
        JSON.stringify(verdict ?? tab()!.info().privacy)
      )
      check(
        'easylist-cookie list is on',
        settingsStore.get().adblock.lists['easylist-cookie'] === true
      )
      say(
        `[flowtest] consent eval path: ${
          harbor.consentEvalFallbacks === 0
            ? 'webFrame (primary)'
            : `consent:eval fallback ×${harbor.consentEvalFallbacks}`
        }`
      )

      // -- 2. strip, with a control run so the check can't pass vacuously --
      const sp = settingsStore.get().privacy
      settingsStore.set({
        privacy: {
          ...sp,
          cookieGuard: false,
          blockSites: [...sp.blockSites.filter((d) => d !== '127.0.0.1'), '127.0.0.1']
        }
      })
      // SameSite=None so a third-party subresource would genuinely carry it
      // (localhost is a trustworthy origin, so Secure is allowed over http)
      const plantPre = async (value: string): Promise<void> => {
        await ses.cookies.set({
          url: third('/'),
          name: 'pre',
          value,
          secure: true,
          sameSite: 'no_restriction'
        })
      }
      await plantPre('1').catch((err) => say(`[flowtest] plant failed: ${err}`))
      const preSticks = await settle(async () => {
        const cs = await ses.cookies.get({ url: third('/') })
        return cs.some((c) => c.name === 'pre') ? true : undefined
      }, 4000)
      check('guard off: planted tracker cookie sticks', preSticks === true)
      w.tabs.navigate(null, local('/tracked?g=1'))
      const g1 = await settle(async () => {
        const hits = reqLog.filter((l) => l.includes('g=1'))
        return hits.length >= 2 ? hits : undefined
      }, 15_000)
      check(
        'control: guard off, the cookie travels',
        (g1 ?? []).length >= 2 && (g1 ?? []).every((l) => l.includes('pre=1')),
        JSON.stringify(g1)
      )
      // scrub the control run's Set-Cookie before the real run; a fresh value
      // guarantees the re-plant emits a real 'changed' for the scrubber
      settingsStore.set({ privacy: { ...settingsStore.get().privacy, cookieGuard: true } })
      await plantPre('2').catch(() => {})
      w.tabs.navigate(null, local('/tracked?g=2'))
      const g2 = await settle(async () => {
        const hits = reqLog.filter((l) => l.includes('g=2'))
        return hits.length >= 2 ? hits : undefined
      }, 15_000)
      check(
        'tracker request carries no cookie',
        (g2 ?? []).length >= 2 && (g2 ?? []).every((l) => l.endsWith('(none)')),
        JSON.stringify(g2)
      )
      const jarClean = await settle(async () => {
        const cs = await ses.cookies.get({ url: third('/') })
        return cs.some((c) => c.name === 'track' || c.name === 'pre') ? undefined : true
      }, 8000)
      check('set-cookie scrubbed from the jar', jarClean === true)
      const strips = await settle(async () => {
        const p = tab()!.info().privacy
        return (p?.cookiesStripped ?? 0) >= 1 ? p!.cookiesStripped : undefined
      }, 8000)
      check('tab counts its strips', (strips ?? 0) >= 1, `stripped=${strips}`)
      check(
        'documents are never stripped',
        harbor.shouldStripRequest({
          url: third('/frame'),
          resourceType: 'subFrame',
          referrer: local('/framed'),
          frame: { top: { url: local('/framed') } }
        }) === false
      )
      check(
        'media is never stripped',
        harbor.shouldStripRequest({
          url: third('/stream.mp4'),
          resourceType: 'media',
          frame: { top: { url: local('/tracked') } }
        }) === false
      )
      check(
        'exemptions beat classification',
        harbor.shouldStripRequest({
          url: 'https://accounts.google.com/x.js',
          resourceType: 'script',
          frame: { top: { url: 'https://example.com/' } }
        }) === false
      )
      const classifierUp = await settle(async () => (harbor.classifierReady() ? true : undefined), 30_000)
      check(
        'live classifier knows a tracker (needs network)',
        classifierUp === true &&
          harbor.classifyRequest(
            'https://www.google-analytics.com/analytics.js',
            'https://example.com/',
            'script'
          ) === true
      )

      // -- 3. the tide, on an injected clock --
      const now = Date.now()
      harbor.engagementSeed('stale.example', now - 40 * DAY)
      harbor.engagementSeed('fresh.example', now - 1 * DAY)
      harbor.engagementSetCreatedAt(now - 90 * DAY)
      for (const d of ['stale.example', 'fresh.example', 'kept.example']) {
        await ses.cookies.set({ url: `https://${d}/`, name: 'jar', value: d }).catch(() => {})
      }
      const bm = bookmarksStore.add('https://kept.example/', 'Kept')
      const sweep1 = await harbor.sweep(now)
      say(`[flowtest] sweep: ${JSON.stringify(sweep1)}`)
      check(
        'stale site washed out',
        sweep1.swept.includes('stale.example') &&
          (await ses.cookies.get({ url: 'https://stale.example/' })).length === 0
      )
      check('fresh site kept', (await ses.cookies.get({ url: 'https://fresh.example/' })).length >= 1)
      check('bookmark guards a site', (await ses.cookies.get({ url: 'https://kept.example/' })).length >= 1)
      const receipts = harbor.expiredList()
      check(
        'undo list holds the receipt',
        receipts.some((x) => x.domain === 'stale.example' && x.cookieCount >= 1),
        JSON.stringify(receipts)
      )
      const restored = await harbor.restore('stale.example')
      check(
        'restore brings cookies back',
        restored === true &&
          (await ses.cookies.get({ url: 'https://stale.example/' })).some((c) => c.name === 'jar')
      )
      harbor.engagementSetCreatedAt(now - 2 * DAY)
      await ses.cookies.set({ url: 'https://stale.example/', name: 'jar2', value: '1' }).catch(() => {})
      check('grace period holds fire', (await harbor.sweep(now)).swept.length === 0)
      harbor.flush()
      const rawMap = readFileSync(join(app.getPath('userData'), 'engagement.json'), 'utf-8')
      const map = JSON.parse(rawMap) as { createdAt: number; lastSweepAt: number; hosts: Record<string, number> }
      const mapValues = [map.createdAt, map.lastSweepAt, ...Object.values(map.hosts)]
      check(
        'map stores only names and days',
        !rawMap.includes('http') && mapValues.every((v) => typeof v === 'number' && v % DAY === 0),
        rawMap.slice(0, 160)
      )
      bookmarksStore.remove(bm.id)

      // -- 4. the per-site panel, on the freeze-frame contract --
      const report = (await inChrome(`window.offshore.privacy.siteReport()`)) as SiteReport | null
      say(`[flowtest] site report: ${JSON.stringify(report)}`)
      check(
        'report has its numbers',
        report?.host === 'localhost' &&
          typeof report?.cookieCount === 'number' &&
          typeof report?.trackersBlocked === 'number' &&
          typeof report?.cookiesStripped === 'number' &&
          typeof report?.consent === 'string'
      )
      surface(w)
      w.tabs.setActiveVisible(true)
      await delay(900)
      const preShot = await tab()!.wc.capturePage()
      say(
        `[flowtest] pre-click: vis=${await inPage('document.visibilityState')} capture=${preShot.getSize().width}x${preShot.getSize().height}`
      )
      await inChrome(`document.querySelector('.omni-tune')?.click()`)
      const probePanel = async (): Promise<{ si: boolean; freeze: boolean; tide: boolean }> => {
        const raw = (await inChrome(
          `JSON.stringify({si: !!document.querySelector('.site-info'),
                           freeze: !!document.querySelector('.page-freeze'),
                           tide: !!document.querySelector('.si-tide')})`
        )) as string
        return JSON.parse(raw) as { si: boolean; freeze: boolean; tide: boolean }
      }
      const panel = await settle(async () => {
        const p = await probePanel()
        return p.si && p.freeze ? p : undefined
      }, 8000)
      check('panel stands on the freeze-frame', !!panel, JSON.stringify(panel ?? (await probePanel())))
      check('tide row rendered', panel?.tide === true)
      await inChrome(`document.querySelector('.si-tide .si-action')?.click()`)
      const kept = await settle(
        async () => (settingsStore.get().privacy.keepSites.includes('localhost') ? true : undefined),
        6000
      )
      check('Always allow round-trips', kept === true)
      await inChrome(`window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`)

      // back on the CMP page, the panel wears the consent verdict too
      w.tabs.navigate(null, local('/cmp'))
      await settle(async () => (tab()!.info().privacy?.consent === 'handled' ? true : undefined), 15_000)
      await inChrome(`document.querySelector('.omni-tune')?.click()`)
      const consentRow = await settle(async () => {
        const raw = (await inChrome(
          `JSON.stringify({row: !!document.querySelector('.si-consent'),
                           handled: !!document.querySelector('.si-consent.handled')})`
        )) as string
        const p = JSON.parse(raw) as { row: boolean; handled: boolean }
        return p.row ? p : undefined
      }, 8000)
      check('consent row rendered as handled', consentRow?.handled === true, JSON.stringify(consentRow))
      await inChrome(`window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`)

      await cleanup()
      server.close()
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'privacy') {
      const { historyStore, settingsStore, bookmarksStore } = await import('./stores')
      const historyFile = join(app.getPath('userData'), 'history.json')
      const readHistory = (): string => {
        try {
          return readFileSync(historyFile, 'utf-8')
        } catch {
          return ''
        }
      }

      // 1. default is off — visiting a page must leave no trace
      check('keepHistory defaults off', settingsStore.get().keepHistory === false)
      w.tabs.navigate(null, 'https://example.com')
      await delay(4000)
      check('visit not recorded while off', !readHistory().includes('example.com'), readHistory().slice(0, 120))
      check('no history suggestions while off', historyStore.search('example', 5).length === 0)

      // 2. opt in — now it remembers
      settingsStore.set({ keepHistory: true })
      w.tabs.navigate(null, 'https://example.com/?second')
      await delay(4000)
      historyStore.flush()
      check('visit recorded once on', readHistory().includes('example.com'))

      // 3. opting back out forgets what was kept
      settingsStore.set({ keepHistory: false })
      await delay(500)
      check('turning it off clears history', !readHistory().includes('example.com'), readHistory().slice(0, 120))

      // 4. bookmarking a live page captures its real favicon
      settingsStore.set({ keepHistory: false })
      w.tabs.navigate(null, 'https://github.com')
      await delay(6000)
      const tab = w.tabs.activeTab!
      bookmarksStore.toggle(tab.wc.getURL(), tab.wc.getTitle(), tab.favicon)
      await delay(300)
      const bm = bookmarksStore.list().find((n) => n.type === 'bookmark')
      say(`[flowtest] bookmark favicon: ${bm?.favicon ?? '(none)'}`)
      check('bookmark stores a real favicon url', !!bm?.favicon && /^https?:/.test(bm.favicon))

      // 5. a bookmark with no stored icon still has somewhere to look
      const { faviconCandidates } = await import('@shared/favicon')
      const fallback = faviconCandidates('https://news.ycombinator.com/', undefined)
      say(`[flowtest] fallback chain: ${fallback.join(' , ')}`)
      check('fallback chain hits the site itself', fallback[0] === 'https://news.ycombinator.com/favicon.ico')
      check('non-web urls yield no candidates', faviconCandidates('offshore://start', undefined).length === 0)
    }

    /**
     * The chrome's manners: type-ahead in the address bar, the new tab's search
     * as a panel you can put away, ⌘S as a real hide, and a page in full screen
     * getting the whole window to itself.
     */
    if (flow === 'chrome') {
      const inChrome = <T,>(src: string): Promise<T> =>
        w.win.webContents.executeJavaScript(src) as Promise<T>
      const { settingsStore } = await import('./stores')

      // 1. the address bar finishes what you type
      const sugs = await inChrome<{ kind: string; text: string }[]>(
        `window.offshore.omnibox.suggest('canv')`
      )
      say(`[flowtest] suggestions: ${JSON.stringify(sugs.map((s) => `${s.kind}:${s.text}`))}`)
      check('the dropdown has something to show', sugs.length > 0)
      const guesses = sugs.filter((s) => s.kind === 'search' && s.text.toLowerCase() !== 'canv')
      check('engine type-ahead reaches the dropdown (needs network)', guesses.length > 0)

      // 1b. …and the list really stands on the page in the sidebar layout, where
      // it has to hang far past a 216px column to be worth reading at all
      /*
       * The window needs to be up and painting for these checks. Real OS focus
       * is deliberately NOT taken (the human keeps their keyboard); the steps
       * below drive the omnibox through synthetic events instead, which is the
       * same code path a keystroke takes once the cursor is there.
       */
      surface(w)
      /*
       * Focusing the window hands the cursor to the page (see OffshoreWindow's
       * 'focus' handler) and that lands asynchronously — ask for the omnibox in
       * the same breath and the page takes it back a frame later. Let the window
       * settle, then take the cursor the way ⌘L does.
       */
      await delay(600)
      w.win.webContents.focus()
      w.sendToChrome('omnibox:focus')
      await delay(700)
      /*
       * Launched in the background, this window may never get OS focus at all,
       * and an unfocused renderer will not hand focus to an input — which left
       * this step passing or failing with the window manager's mood. So ask for
       * focus, then drive the component through the events React actually
       * listens to (focusin → onFocus, input → onChange), which is the same code
       * path a keystroke takes once the cursor is there.
       */
      await inChrome(`(() => {
        const el = document.querySelector('.omni-input')
        el.focus()
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(el, 'canv')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      say(
        `[flowtest] bar state: ${await inChrome<string>(
          `JSON.stringify({ editing: !!document.querySelector('.omnibox.editing'), focused: document.activeElement?.className ?? '' })`
        )}`
      )
      const drop = await settle(async () => {
        const d = await inChrome<{ rows: number; width: number; frozen: boolean } | null>(`(() => {
          const d = document.querySelector('.omni-dropdown')
          if (!d) return null
          return {
            rows: d.querySelectorAll('.omni-suggestion').length,
            width: Math.round(d.getBoundingClientRect().width),
            frozen: !!document.querySelector('.page-freeze')
          }
        })()`)
        return d && d.rows > 0 && d.frozen ? d : undefined
      }, 5000)
      say(`[flowtest] dropdown: ${JSON.stringify(drop)}`)
      check('the dropdown is on screen while typing', !!drop && drop.rows > 0)
      check('it hangs past the sidebar instead of being squeezed into it', (drop?.width ?? 0) > 320)
      check('the page steps aside behind it', drop?.frozen === true)
      // The list reads as an extension of the pill: a suggestion's first letter
      // sits exactly under the one you typed, in the same size type.
      const align = await inChrome<{ input: number; text: number; fi: string; fs: string } | null>(
        `(() => {
          const input = document.querySelector('.omni-input')
          const st = document.querySelector('.omni-suggestion .s-text')
          if (!input || !st) return null
          return {
            input: Math.round(input.getBoundingClientRect().left * 2) / 2,
            text: Math.round(st.getBoundingClientRect().left * 2) / 2,
            fi: getComputedStyle(input).fontSize,
            fs: getComputedStyle(st).fontSize
          }
        })()`
      )
      say(`[flowtest] dropdown alignment: ${JSON.stringify(align)}`)
      check(
        'suggestion text lines up with what you typed',
        !!align && Math.abs(align.input - align.text) <= 1.5,
        JSON.stringify(align)
      )
      check('suggestion type is the size of the bar type', !!align && align.fi === align.fs, JSON.stringify(align))
      /*
       * Give the address bar back, and make sure it really went.
       *
       * A dispatched Escape is not a real key press: it reaches React's
       * onKeyDown but leaves the element focused, so the bar stayed "editing"
       * for the rest of the run. Everything downstream then behaved as if the
       * cursor were still in it — the omnibox puts the home screen's own search
       * away while it has focus, and a bar with the cursor in it cannot be
       * hidden by ⌘S. That is what made the later checks fail in scattered
       * groups depending on whether the window happened to win focus at all.
       *
       * Blurring is what actually ends editing (see Omnibox's onBlur), so blur
       * it, then wait for the state to say so rather than trusting a delay.
       */
      await inChrome(`(() => {
        const el = document.querySelector('.omni-input')
        if (!el) return false
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        el.blur()
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
        return true
      })()`)
      const released = await settle(
        () => inChrome<boolean>(`!document.querySelector('.omnibox.editing')`),
        2000
      )
      check('the address bar gives the cursor back', released === true)

      // 2. a new tab opens with its search in front of the home screen.
      // (A clean profile opens on the welcome page, so ask for a real new tab.)
      settingsStore.set({ onboarded: true })
      const tab = w.tabs.createTab()
      const searchUp = await settle(
        () => tab.wc.executeJavaScript(`!!document.querySelector('.start-search.on')`) as Promise<boolean>,
        6000
      )
      check('a new tab opens with the search up', tab.info().homeSearch === true)
      check('the search panel is on the home screen', searchUp === true)

      // 3. dismissing it leaves the tab, and the home screen, exactly there
      const tabCount = w.tabs.tabs.length
      w.tabs.setHomeSearch(tab.id, false)
      check(
        'the search goes away',
        (await settle(
          () => tab.wc.executeJavaScript(`!document.querySelector('.start-search.on')`) as Promise<boolean>,
          4000
        )) === true
      )
      check('the tab is not closed', w.tabs.tabs.length === tabCount && !!w.tabs.byId(tab.id))
      check(
        'the home screen stays',
        (await tab.wc.executeJavaScript(`!!document.querySelector('.start-grid')`)) === true
      )
      check(
        'the New Tab row stops standing in for the tab',
        (await settle(
          () => inChrome<boolean>(`!document.querySelector('.new-tab-btn.active')`),
          4000
        )) === true
      )
      check(
        'the row keeps a way back to the search',
        (await inChrome<boolean>(`!!document.querySelector('.new-tab-btn')`)) === true
      )
      // the ✕ is the + turned a quarter-turn; quiet, it is a plus again
      const markQuiet = await settle(
        () =>
          inChrome<boolean>(
            `getComputedStyle(document.querySelector('.nt-mark')).transform === 'none'`
          ),
        4000
      )
      check('the mark is a plus while the row is quiet', markQuiet === true)
      w.tabs.setHomeSearch(tab.id, true)
      const markOn = await settle(
        () =>
          inChrome<boolean>(
            `/^matrix\\(0\\.70/.test(getComputedStyle(document.querySelector('.nt-mark')).transform)`
          ),
        4000
      )
      check('it spins into an ✕ when the search comes up', markOn === true)
      w.tabs.setHomeSearch(tab.id, false)
      await delay(300)

      // 3b. the air around the page card is something you can grab the window by
      const frame = await inChrome<{ side: string; region: string; rect: number[] }[]>(`(() => {
        return ['.df-top', '.df-right', '.df-bottom', '.df-left'].map((s) => {
          const el = document.querySelector(s)
          if (!el) return { side: s, region: 'missing', rect: [] }
          const cs = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return {
            side: s,
            region: cs.display === 'none' ? 'hidden' : cs.getPropertyValue('-webkit-app-region'),
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
          }
        })
      })()`)
      say(`[flowtest] drag frame: ${JSON.stringify(frame)}`)
      const grabbable = frame.filter((f) => f.region === 'drag')
      check('every visible side of the frame is a drag region', grabbable.length === 3, JSON.stringify(frame.map((f) => f.region)))
      check(
        'the frame has real thickness to aim at',
        grabbable.every((f) => Math.min(f.rect[2], f.rect[3]) >= 10),
        JSON.stringify(grabbable.map((f) => f.rect))
      )
      check(
        'the sidebar keeps its own left edge in this layout',
        frame.find((f) => f.side === '.df-left')?.region === 'hidden'
      )
      const card = w.contentBounds()
      check(
        'no strip lies over the page itself',
        grabbable.every((f) => {
          const [x, y, width, height] = f.rect
          return (
            x + width <= card.x + 1 ||
            x >= card.x + card.width - 1 ||
            y + height <= card.y + 1 ||
            y >= card.y + card.height - 1
          )
        }),
        `card ${JSON.stringify(card)}`
      )

      // 4. ⌘S hides the chrome outright
      w.sendToChrome('chrome:toggle-hidden')
      check(
        '⌘S enters hidden mode',
        (await settle(
          () => inChrome<boolean>(`document.querySelector('.chrome').classList.contains('chrome-hidden')`),
          4000
        )) === true
      )
      check('hidden is remembered, not momentary', settingsStore.get().chromeHidden === true)
      const barGone = await settle(
        () =>
          inChrome<boolean>(`document.querySelector('.sidebar').getBoundingClientRect().right <= 0`),
        4000
      )
      check('the sidebar is off the window', barGone === true)
      // the chrome re-measures its insets a frame later; wait for main to hear
      const pageWide = await settle(async () => w.contentBounds().x < 20, 4000)
      const roomy = w.contentBounds()
      say(`[flowtest] content with the chrome hidden: ${JSON.stringify(roomy)}`)
      check('the page takes the room the sidebar had', pageWide === true, JSON.stringify(roomy))

      // 5. the peek slides in over the page — and does not resize it
      const armed = await inChrome<string>(`(() => {
        const z = document.querySelector('.edge-zone')
        if (!z) return 'no edge zone: ' + document.querySelector('.chrome').className
        const r = z.getBoundingClientRect()
        // React synthesises enter/leave from mouseover/mouseout
        z.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
        return \`dispatched over \${Math.round(r.width)}×\${Math.round(r.height)} at \${Math.round(r.x)},\${Math.round(r.y)}\`
      })()`)
      say(`[flowtest] edge hover: ${armed}`)
      check(
        'the edge brings the sidebar back',
        (await settle(
          () => inChrome<boolean>(`document.querySelector('.chrome').classList.contains('peeking')`),
          4000
        )) === true
      )
      say(`[flowtest] chrome classes after hover: ${await inChrome<string>(`document.querySelector('.chrome').className`)}`)
      const barIn = await settle(
        () =>
          inChrome<boolean>(`document.querySelector('.sidebar').getBoundingClientRect().left === 0`),
        4000
      )
      check('it comes all the way in', barIn === true)
      const peekBounds = w.contentBounds()
      check(
        'the page is not resized by a peek',
        JSON.stringify(peekBounds) === JSON.stringify(roomy),
        `${JSON.stringify(roomy)} → ${JSON.stringify(peekBounds)}`
      )

      // 6. a page in full screen gets the window to itself
      w.setContentFullscreen(true)
      w.tabs.layout()
      w.tabs.pushState()
      check(
        'the chrome hears about full screen',
        (await settle(
          () =>
            inChrome<boolean>(
              `document.querySelector('.chrome').classList.contains('content-fullscreen')`
            ),
          4000
        )) === true
      )
      check(
        'there is no edge left to summon it from',
        (await inChrome<boolean>(`!document.querySelector('.edge-zone')`)) === true
      )
      check(
        'the bar is gone, not merely parked off-screen',
        (await settle(
          () =>
            inChrome<boolean>(
              `getComputedStyle(document.querySelector('.sidebar')).display === 'none'`
            ),
          4000
        )) === true
      )
      const [cw, ch] = w.win.getContentSize()
      /*
       * Entering full screen is also what ends the peek above, and closing that
       * overlay brings the live view back the way every swap goes: parked
       * off-screen for a beat while it proves it can paint, then landed. Poll
       * for the landed state rather than reading the bounds mid-swap.
       */
      const fs =
        (await settle(async () => {
          const b = w.tabs.activeTab!.view.getBounds()
          return b.x === 0 && b.y === 0 && b.width === cw && b.height === ch ? b : undefined
        }, 4000)) ?? w.tabs.activeTab!.view.getBounds()
      check(
        'the page has every pixel',
        fs.x === 0 && fs.y === 0 && fs.width === cw && fs.height === ch,
        `${JSON.stringify(fs)} vs ${cw}×${ch}`
      )
      w.setContentFullscreen(false)
      w.tabs.layout()
      w.tabs.pushState()
      await delay(400)
      const back = w.tabs.activeTab!.view.getBounds()
      check('leaving full screen gives the page a real size again', back.width > 100 && back.height > 100, JSON.stringify(back))

      /*
       * 5. The New Tab row, its search, and the panel that keeps to the column.
       *
       * Last on purpose: these three make tabs and type into them, and the
       * checks above read a sidebar in a known state. Anything that leaves a
       * mark goes at the end, where there is nothing left to disturb.
       */
      const blank = w.tabs.activeTab
      if (blank) w.tabs.setHomeSearch(blank.id, false)
      await delay(400)

      /*
       * ⌘T means the New Tab row, not a second blank tab. The key used to go
       * straight to createTab in main, so pressing it while already on a blank
       * tab made another one — and the first, no longer active, took a row of
       * its own in the sidebar. Both now land on the same handler.
       */
      const beforeCmdT = w.tabs.tabs.length
      w.openNewTab()
      await delay(1000)
      check(
        '⌘T on a blank tab does not pile up another one',
        w.tabs.tabs.length === beforeCmdT,
        `${beforeCmdT} → ${w.tabs.tabs.length}`
      )
      check('⌘T brings the search back instead', w.tabs.activeTab?.info().homeSearch === true)
      check(
        'the New Tab row is the thing that lights up',
        (await inChrome<boolean>(`!!document.querySelector('.new-tab-btn.active')`)) === true
      )

      // the new tab's search finishes your sentence, the way the omnibox does
      const home = w.tabs.activeTab
      await home?.wc.executeJavaScript(`(() => {
        const el = document.querySelector('.start-search input')
        if (!el) return false
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(el, 'canv')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await delay(1800)
      const homeSugs = await home?.wc.executeJavaScript(
        `document.querySelectorAll('.start-sug').length`
      )
      say(`[flowtest] home search rows: ${homeSugs}`)
      check('the new tab search offers suggestions too (needs network)', Number(homeSugs) > 0, String(homeSugs))

      /*
       * Downloads keeps to the sidebar column, so it never asks the page to
       * step aside. That freeze was what stopped the home screen's waves dead,
       * brought the panel in twice, and left it behind the page for the first
       * frames — the chrome draws under the views until they stand down.
       */
      const dl = await inChrome<{ panel: number; column: number; frozen: boolean }>(`(() => {
        const cs = getComputedStyle(document.querySelector('.chrome'))
        const w = parseFloat(cs.getPropertyValue('--sidebar-w'))
        const pad = parseFloat(cs.getPropertyValue('--chrome-pad'))
        const el = document.querySelector('.dl-panel')
        return {
          panel: el ? Math.round(el.getBoundingClientRect().width) : w - pad * 2,
          column: w - pad * 2,
          frozen: !!document.querySelector('.page-freeze')
        }
      })()`)
      say(`[flowtest] downloads: ${JSON.stringify(dl)}`)
      check(
        'the downloads panel is sized to the column, not past it',
        dl.panel <= dl.column,
        `${dl.panel} ≤ ${dl.column}`
      )
      check('opening it does not freeze the page behind it', dl.frozen === false)

      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'passwords') {
      // 1. load the test login page and submit credentials
      w.tabs.navigate(null, `${dev}/testlogin.html`)
      await delay(2500)
      const tab = w.tabs.activeTab!
      await tab.wc.executeJavaScript(`(() => {
        const set = (el, v) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set(document.getElementById('u'), 'dani@example.com')
        set(document.getElementById('p'), 'hunter2-secret')
        document.getElementById('f').requestSubmit()
        return document.getElementById('out').textContent
      })()`)
      await delay(1000)
      const dialogText = await w.win.webContents.executeJavaScript(
        `document.querySelector('.pw-modal')?.textContent ?? ''`
      )
      check('save dialog appears', dialogText.includes('Save this password'), dialogText)
      check('dialog names the user', dialogText.includes('dani@example.com'))
      const dialogCentred = await w.win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector('.pw-modal')
        if (!el) return 'no dialog'
        const r = el.getBoundingClientRect()
        const dx = Math.abs((r.left + r.right) / 2 - window.innerWidth / 2)
        const dy = Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2)
        return dx < 3 && dy < 3 ? 'centred' : \`off by \${Math.round(dx)},\${Math.round(dy)}\`
      })()`)
      check('dialog sits in the middle of the window', dialogCentred === 'centred', dialogCentred)
      const scrim = await w.win.webContents.executeJavaScript(
        `!!document.querySelector('.pw-scrim')`
      )
      check('the page behind it is dimmed', scrim === true)

      // 2. accept the offer from the dialog
      await w.win.webContents.executeJavaScript(`document.querySelector('.pw-save')?.click()`)
      await delay(800)
      let vaultRaw = ''
      try {
        vaultRaw = readFileSync(join(app.getPath('userData'), 'passwords.json'), 'utf-8')
      } catch {
        /* missing = fail below */
      }
      check('vault file written', vaultRaw.includes('"entries"'))
      check('password not stored in plaintext', !vaultRaw.includes('hunter2-secret'))
      check('username encrypted too', !vaultRaw.includes('dani@example.com'))

      // 3. revisit the page — autofill should populate both fields
      w.tabs.navigate(null, 'about:blank')
      await delay(800)
      w.tabs.navigate(null, `${dev}/testlogin.html`)
      await delay(2500)
      const filled = await w.tabs.activeTab!.wc.executeJavaScript(
        `JSON.stringify({ u: document.getElementById('u').value, p: document.getElementById('p').value })`
      )
      const parsed = JSON.parse(filled)
      check('autofill username', parsed.u === 'dani@example.com', filled)
      check('autofill password', parsed.p === 'hunter2-secret')

      // 4. submitting what we already hold must not ask again
      await w.tabs.activeTab!.wc.executeJavaScript(
        `document.getElementById('f').requestSubmit(), 0`
      )
      await delay(1000)
      const askedAgain = await w.win.webContents.executeJavaScript(
        `!!document.querySelector('.pw-modal')`
      )
      check('no second prompt for a password already saved', askedAgain === false)
    }

    if (flow === 'popups') {
      const before = BrowserWindow.getAllWindows().length
      w.tabs.navigate(null, `${dev}/testpopup.html`)
      await delay(2200)
      const state = w.tabs.state()
      const active = state.tabs.find((t) => t.id === state.activeTabId)
      check('drive-by popup blocked', (active?.blockedPopups ?? 0) >= 1, `blocked=${active?.blockedPopups}`)
      check('no popup window opened', BrowserWindow.getAllWindows().length === before)

      // gestured popup should open
      await w.tabs.activeTab!.wc.executeJavaScript(`(() => {
        const btn = document.getElementById('open')
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        btn.click()
      })()`)
      await delay(1500)
      const after = BrowserWindow.getAllWindows().length
      check('gestured popup allowed', after === before + 1, `windows ${before} -> ${after}`)
    }

    if (flow === 'spaces') {
      const spaceA = w.tabs.activeSpace
      const spaceB = w.tabs.createSpace('School', 'separate')
      await delay(600)
      const tabB = w.tabs.tabsIn(spaceB.id)[0]
      check('separate space uses own partition', tabB?.partition === `persist:space-${spaceB.id}`, tabB?.partition)
      check('space switch activated B', w.tabs.activeSpaceId === spaceB.id)

      // cookie isolation between the shared jar and the space jar
      const shared = session.fromPartition('persist:offshore')
      const school = session.fromPartition(`persist:space-${spaceB.id}`)
      await shared.cookies.set({ url: 'https://example.com', name: 'jar', value: 'home' })
      const sharedCookies = await shared.cookies.get({ name: 'jar' })
      const schoolCookies = await school.cookies.get({ name: 'jar' })
      check('cookie present in shared jar', sharedCookies.length === 1)
      check('cookie absent in separate jar', schoolCookies.length === 0)

      // session serialization carries both spaces with profiles
      const serialized = w.tabs.serializeWindow()
      check('serialize has 2 spaces', serialized.spaces.length === 2)
      check(
        'serialize keeps profile flag',
        serialized.spaces.some((s) => s.profile === 'separate') &&
          serialized.spaces.some((s) => (s.profile ?? 'shared') === 'shared')
      )

      // cross-partition move recreates the tab under the target jar
      w.tabs.activateSpace(spaceA.id)
      const moved = w.tabs.createTab(undefined, { spaceId: spaceA.id })
      const movedId = moved.id
      await delay(400)
      w.tabs.moveTabToSpace(movedId, spaceB.id)
      await delay(400)
      const inB = w.tabs.tabsIn(spaceB.id)
      check('cross-jar move lands in target space', inB.length === 2)
      check(
        'moved tab got target partition',
        inB.every((t) => t.partition === `persist:space-${spaceB.id}`)
      )
      check('original tab closed on move', !w.tabs.byId(movedId))
    }

    say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
    app.exit(failures === 0 ? 0 : 1)
  }
}
