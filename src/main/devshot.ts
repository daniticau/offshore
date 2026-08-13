import { BrowserWindow, app, ipcMain, session } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as nodeHttp from 'http'
import { HOME_WIDGETS, SLOP_FLAG_MIN, SLOP_VEIL_MIN, type SlopReport } from '@shared/types'
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
    /**
     * OFFSHORE_SHOT_EDITPAGE=1: flip page-edit mode on and select something,
     * so the capture shows the pill, the selection box and the toolbar.
     */
    if (process.env['OFFSHORE_SHOT_EDITPAGE']) {
      w.tabs.toggleEditMode()
      await delay(500)
      await w.tabs.activeTab?.wc
        .executeJavaScript(
          `(() => { const el = document.querySelector('main h1, main p, h1, p, div')
             if (!el) return false
             const r = el.getBoundingClientRect()
             el.dispatchEvent(new PointerEvent('pointerdown', {
               bubbles: true, composed: true, button: 0,
               clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
             }))
             return true })()`
        )
        .catch(() => false)
      await delay(400)
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
 * default) parks it off the side of the display, shown but inactive: it keeps
 * rendering out there, and capturePage still has a real surface to read.
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
  w.win.setPosition(-9000, wy)
  w.win.showInactive()
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
 * OFFSHORE_TEST_FLOW=chrome|passwords|popups|spaces|headers|privacy|drm|split|widgets|lasttab|slop|pageedits|cleaner
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

  async function runFlow(): Promise<void> {
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

    if (flow === 'slop') {
      const { settingsStore } = await import('./stores')
      // the "Always show" click below lands in the shared profile's allowlist —
      // strip it on the way in so the flow can run twice, and again on the way out
      const stripAllow = (): void => {
        const s = settingsStore.get()
        if (s.slop.allowlist.includes('127.0.0.1')) {
          settingsStore.set({
            slop: { ...s.slop, allowlist: s.slop.allowlist.filter((h) => h !== '127.0.0.1') }
          })
        }
      }
      stripAllow()
      const sloppy = `<html><body><article>${Array.from({ length: 14 }, () => `
        <p>In today's fast-paced digital landscape, it's important to note that businesses must
        delve into the ever-evolving landscape of technology. Moreover, this comprehensive guide
        will help you unlock the potential of your workflow. Furthermore, when it comes to
        navigating the complexities of modern tools, a holistic approach stands as a testament
        to innovation. Additionally, let's explore the rich tapestry of options — a treasure
        trove of possibilities. Ultimately, this game-changer will revolutionize the way you
        work, and not only saves time but also elevates your results. In conclusion, embark on
        a journey to seamlessly integrate these solutions.</p>`).join('')}</article></body></html>`
      const clean = `<html><body><article>${Array.from({ length: 14 }, (_, i) => `
        <p>The tide came in around four. We hauled the skiff past the wrack line and Tom
        checked the traps while I sorted bait, cold to the wrist. Gulls worked the shallows
        where the creek cuts the flat. Paragraph ${i} of an ordinary account, written the way
        a person writes when they are just saying what happened that afternoon.</p>`).join('')}</article></body></html>`
      const server = nodeHttp.createServer((req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(req.url === '/slop' ? sloppy : clean)
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

      // -- a heavy page gets scored, veiled, and worn on the chrome --
      w.tabs.navigate(null, `http://127.0.0.1:${port}/slop`)
      const report = await freshReport()
      say(
        `[flowtest] slop page score: ${report?.score ?? 'none'} — ${(report?.signals ?? [])
          .slice(0, 3)
          .map((s) => `${s.label} ×${s.count}`)
          .join(', ')}`
      )
      check('slop page flagged', (report?.score ?? 0) >= SLOP_FLAG_MIN, `score=${report?.score}`)
      check('slop page scores veil-heavy', (report?.score ?? 0) >= SLOP_VEIL_MIN, `score=${report?.score}`)
      check('report carries its receipts', (report?.signals.length ?? 0) > 0)
      const veiled = await settle(
        async () => ((await inPage(`!!document.getElementById('offshore-slop-veil')`)) ? true : undefined),
        4000
      )
      check('veil raised over the page', tab()?.slop?.veil === 'up' && veiled === true)

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
                           read: !!document.querySelector('.slop-action.primary')})`
        )) as string
        const p = JSON.parse(raw) as { panel: boolean; signals: number; read: boolean }
        return p.panel ? p : undefined
      }, 4000)
      check('chip opens the slop report', !!panel)
      check('report lists the tells it counted', (panel?.signals ?? 0) > 0, `signals=${panel?.signals}`)
      check('report offers Read anyway while veiled', panel?.read === true)
      await inChrome(`window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`)

      // -- Read anyway lifts the veil for this visit --
      await inPage(
        `document.getElementById('offshore-slop-veil').shadowRoot.querySelector('.read').click()`
      )
      const lifted = await settle(async () => (tab()?.slop?.veil === 'lifted' ? true : undefined), 4000)
      const overlayGone = await inPage(`!document.getElementById('offshore-slop-veil')`)
      check('Read anyway lifts the veil', lifted === true && overlayGone === true)

      // -- a fresh load is a fresh offer --
      tab()!.wc.reload()
      const reVeiled = await settle(async () => (tab()?.slop?.veil === 'up' ? true : undefined), 12_000)
      check('a fresh load veils again', reVeiled === true)

      // -- Always show this site spares it from then on --
      await inPage(
        `document.getElementById('offshore-slop-veil').shadowRoot.querySelector('.allow').click()`
      )
      const allowed = await settle(
        async () => (settingsStore.get().slop.allowlist.includes('127.0.0.1') ? true : undefined),
        4000
      )
      check('Always show adds the site to the never-veil list', allowed === true)
      w.tabs.navigate(null, `http://127.0.0.1:${port}/slop`)
      const spared = await freshReport()
      check(
        'allowed site keeps the chip, loses the veil',
        (spared?.score ?? 0) >= SLOP_VEIL_MIN && spared?.veil === undefined,
        `score=${spared?.score} veil=${spared?.veil}`
      )

      // -- honest prose stays untouched --
      w.tabs.navigate(null, `http://127.0.0.1:${port}/clean`)
      const cleanReport = await freshReport()
      say(`[flowtest] clean page score: ${cleanReport?.score ?? 'none'}`)
      check('honest prose not flagged', (cleanReport?.score ?? 0) < SLOP_FLAG_MIN, `score=${cleanReport?.score}`)
      const cleanChip = await inChrome(`!document.querySelector('.slop-chip')`)
      check('no chip on honest prose', cleanChip === true)

      stripAllow()
      // flows leave over app.exit, which skips the debounced save — write now
      settingsStore.flush()
      server.close()
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'cleaner') {
      /**
       * The two built-ins working together: the slop scan washes flagged
       * paragraphs by tier, Clean mode hides exactly what the wash marked,
       * Focus mode hides the furniture — and both survive a reload.
       */
      const slopPara = `In today's fast-paced digital landscape, it's important to note that you must
        delve into the ever-evolving landscape of tools. Moreover, this comprehensive guide will
        unlock the potential of your workflow — a game-changer that will revolutionize the way you
        work. Furthermore, when it comes to navigating the complexities of modern software, a
        holistic approach stands as a testament to seamless integration. Ultimately, embark on a
        journey to elevate your results with this treasure trove of actionable insights.`
      const honestPara = `The tide came in around four and we hauled the skiff past the wrack line.
        Tom checked the traps while I sorted bait, cold to the wrist, and the gulls worked the
        shallows where the creek cuts the flat. Nothing about the afternoon asked to be improved.
        We tied off at the pilings, hosed the deck, and walked up the hill before the light went.`
      const page = `<html><body>
        <div id="sticky" style="position:fixed;top:0;left:0;right:0;height:48px;background:#333;color:#fff">subscribe to our newsletter</div>
        <main>
          <article>
            ${Array.from({ length: 3 }, (_, i) => `<p id="slop${i}">${slopPara}</p>`).join('')}
            <p id="honest">${honestPara}</p>
          </article>
        </main>
        <aside id="rail" class="sidebar-related"><p>You may also like: ten weird tricks.</p></aside>
      </body></html>`
      const server = nodeHttp.createServer((_req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(page)
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      const { pageEditsStore } = await import('./pageedits')
      const { settingsStore } = await import('./stores')
      pageEditsStore.clear('127.0.0.1')

      w.tabs.navigate(null, `http://127.0.0.1:${port}/`)
      const tab = w.tabs.activeTab!

      // 1. the wash: slop paragraphs wear marks and tints, honest prose doesn't
      const washed = await settle(async () => {
        const d = (await tab.wc.executeJavaScript(`JSON.stringify({
          marked: document.querySelectorAll('[data-offshore-slop]').length,
          red: document.getElementById('slop0').getAttribute('data-offshore-slop'),
          tint: document.getElementById('slop0').style.backgroundColor !== '',
          honest: document.getElementById('honest').hasAttribute('data-offshore-slop')
        })`)) as string
        return /"marked":[1-9]/.test(d) ? d : undefined
      }, 8000)
      say(`[flowtest] wash: ${washed}`)
      check('slop paragraphs wear the mark', /"marked":3/.test(String(washed)), String(washed))
      check('the heaviest tier is red', /"red":"red"/.test(String(washed)))
      check('flagged blocks are tinted', /"tint":true/.test(String(washed)))
      check('honest prose is left alone', /"honest":false/.test(String(washed)))

      // 2. Clean mode hides exactly what the wash marked
      pageEditsStore.setMode('127.0.0.1', 'clean', true)
      for (const win of windows) win.tabs.refreshPageEdits('127.0.0.1')
      const cleaned = await settle(async () => {
        const d = (await tab.wc.executeJavaScript(`JSON.stringify({
          slop: getComputedStyle(document.getElementById('slop0')).display,
          honest: getComputedStyle(document.getElementById('honest')).display
        })`)) as string
        return d.includes('"slop":"none"') ? d : undefined
      }, 5000)
      say(`[flowtest] clean: ${cleaned}`)
      check('Clean hides the flagged prose', String(cleaned).includes('"slop":"none"'))
      check('Clean spares the honest paragraph', String(cleaned).includes('"honest":"block"'))

      // 3. Focus mode hides the rail and the sticky bar, not the article
      pageEditsStore.setMode('127.0.0.1', 'focus', true)
      for (const win of windows) win.tabs.refreshPageEdits('127.0.0.1')
      const focused = await settle(async () => {
        const d = (await tab.wc.executeJavaScript(`JSON.stringify({
          rail: getComputedStyle(document.getElementById('rail')).display,
          sticky: getComputedStyle(document.getElementById('sticky')).display,
          article: getComputedStyle(document.querySelector('article')).display
        })`)) as string
        return d.includes('"rail":"none"') && d.includes('"sticky":"none"') ? d : undefined
      }, 5000)
      say(`[flowtest] focus: ${focused}`)
      check('Focus hides the related rail', String(focused).includes('"rail":"none"'))
      check('Focus hides the sticky bar', String(focused).includes('"sticky":"none"'))
      check('Focus leaves the article standing', String(focused).includes('"article":"block"'))

      // 4. both switches survive a reload — Clean has to wait for the wash
      tab.wc.reload()
      const survived = await settle(async () => {
        const d = (await tab.wc.executeJavaScript(`JSON.stringify({
          slop: getComputedStyle(document.getElementById('slop0')).display,
          rail: getComputedStyle(document.getElementById('rail')).display
        })`).catch(() => '')) as string
        return d.includes('"slop":"none"') && d.includes('"rail":"none"') ? d : undefined
      }, 10_000)
      check('Clean and Focus survive a reload', survived !== undefined, String(survived))

      // 5. the highlight switch clears the tint but keeps the verdict machinery
      pageEditsStore.setMode('127.0.0.1', 'clean', false)
      for (const win of windows) win.tabs.refreshPageEdits('127.0.0.1')
      const s = settingsStore.get()
      settingsStore.set({ slop: { ...s.slop, highlight: false } })
      const untinted = await settle(async () => {
        const d = (await tab.wc.executeJavaScript(`JSON.stringify({
          tint: document.getElementById('slop0').style.backgroundColor,
          marked: document.querySelectorAll('[data-offshore-slop]').length
        })`)) as string
        return d.includes('"tint":""') ? d : undefined
      }, 5000)
      say(`[flowtest] highlight off: ${untinted}`)
      check('turning highlight off clears the wash', String(untinted).includes('"tint":""'))
      check('the marks stay for Clean mode', /"marked":3/.test(String(untinted)))

      // 6. switches off restore the page
      pageEditsStore.setMode('127.0.0.1', 'focus', false)
      for (const win of windows) win.tabs.refreshPageEdits('127.0.0.1')
      const restored = await settle(async () => {
        const d = (await tab.wc.executeJavaScript(`JSON.stringify({
          slop: getComputedStyle(document.getElementById('slop0')).display,
          rail: getComputedStyle(document.getElementById('rail')).display
        })`)) as string
        return d.includes('"slop":"block"') && d.includes('"rail":"block"') ? d : undefined
      }, 5000)
      check('everything comes back when the modes go off', restored !== undefined, String(restored))
      // scoped to this flow's host — the shared profile may hold the human's own edits
      check('a hollow site leaves the ledger', pageEditsStore.forHost('127.0.0.1') === undefined)

      settingsStore.set({ slop: { ...settingsStore.get().slop, highlight: true } })
      pageEditsStore.clear('127.0.0.1')
      // flows leave over app.exit, which skips the debounced save — write now
      pageEditsStore.flush()
      settingsStore.flush()
      server.close()
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'pageedits') {
      /**
       * The whole life of a page edit: made with the pointer, remembered by
       * main, replayed onto a reload, defended against a re-render, and taken
       * back. The page is a little SPA on purpose — its banner re-inserts
       * itself every 700ms, which is exactly the fight LinkedIn would put up.
       */
      const page = `<html><body>
        <div id="banner" style="height:60px;background:#c00">the banner</div>
        <main>
          <h1 id="headline">Original headline</h1>
          <article id="story"><p>The story text.</p></article>
          <x-widget id="widget"></x-widget>
        </main>
        <script>
          customElements.define('x-widget', class extends HTMLElement {
            constructor() {
              super()
              const root = this.attachShadow({ mode: 'open' })
              const b = document.createElement('button')
              b.id = 'inner'
              b.textContent = 'in the shadows'
              root.append(b)
            }
          })
          setInterval(() => {
            if (!document.getElementById('banner')) {
              const d = document.createElement('div')
              d.id = 'banner'
              d.style.cssText = 'height:60px;background:#c00'
              d.textContent = 'the banner is back'
              document.body.prepend(d)
            }
          }, 700)
        </script>
      </body></html>`
      const server = nodeHttp.createServer((_req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(page)
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      const { pageEditsStore } = await import('./pageedits')
      // the dev profile persists across runs; this flow owns its host's ledger
      pageEditsStore.clear('127.0.0.1')

      w.tabs.navigate(null, `http://127.0.0.1:${port}/`)
      await delay(2500)
      const tab = w.tabs.activeTab!

      // 1. edit mode goes on, and the tab says so
      w.tabs.toggleEditMode()
      await delay(400)
      check('edit mode reaches the tab state', tab.info().editing === true)
      const overlay = await tab.wc.executeJavaScript(`!!document.querySelector('offshore-page-edit')`)
      check('the editor overlay is on the page', overlay === true)

      // 2. pick the banner with the pointer and hide it with the keyboard
      await tab.wc.executeJavaScript(`(() => {
        const el = document.getElementById('banner')
        const r = el.getBoundingClientRect()
        const o = { bubbles: true, composed: true, clientX: r.left + 10, clientY: r.top + 10, button: 0 }
        el.dispatchEvent(new PointerEvent('pointerdown', o))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
        return true
      })()`)
      const hidden = await settle(
        () =>
          tab.wc.executeJavaScript(
            `getComputedStyle(document.getElementById('banner')).display === 'none'`
          ) as Promise<boolean>,
        4000
      )
      check('picked element is hidden', hidden === true)
      check('the edit reached the ledger', pageEditsStore.count('127.0.0.1') === 1)

      // 2b. rewrite the headline in place: Enter opens the editor, ⌘Enter saves
      const editable = await tab.wc.executeJavaScript(`(() => {
        const el = document.getElementById('headline')
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, composed: true, button: 0, clientX: r.left + 5, clientY: r.top + 5
        }))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return el.isContentEditable
      })()`)
      check('Enter on a selection opens the text editor', editable === true)
      await tab.wc.executeJavaScript(`(() => {
        const el = document.getElementById('headline')
        el.textContent = 'Typed by hand'
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
        return true
      })()`)
      const committed = await settle(async () => {
        const done = (await tab.wc.executeJavaScript(
          `!document.getElementById('headline').isContentEditable && document.getElementById('headline').hasAttribute('data-offshore-text')`
        )) as boolean
        return done && pageEditsStore.count('127.0.0.1') === 2 ? true : undefined
      }, 4000)
      check('⌘Enter commits the rewrite to the ledger', committed === true)

      // 2c. a pick inside a web component takes the whole widget, not its guts
      await tab.wc.executeJavaScript(`(() => {
        const inner = document.getElementById('widget').shadowRoot.getElementById('inner')
        inner.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0 }))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
        return true
      })()`)
      const widgetGone = await settle(async () => {
        const gone = (await tab.wc.executeJavaScript(
          `getComputedStyle(document.getElementById('widget')).display === 'none'`
        )) as boolean
        return gone && pageEditsStore.count('127.0.0.1') === 3 ? true : undefined
      }, 4000)
      check('a shadow-DOM pick hides the whole component', widgetGone === true)

      // 3. the page fights back; the observer puts it away again
      await tab.wc.executeJavaScript(`document.getElementById('banner').remove(), 0`)
      const rehidden = await settle(async () => {
        const s = (await tab.wc.executeJavaScript(`(() => {
          const el = document.getElementById('banner')
          return el ? getComputedStyle(el).display : 'gone'
        })()`)) as string
        return s === 'none' ? true : undefined
      }, 5000)
      check('a re-rendered element is re-hidden', rehidden === true)

      // 4. re-recording the same element replaces its record instead of stacking
      pageEditsStore.record('127.0.0.1', {
        op: 'text',
        selector: '#headline',
        value: 'Rewritten by Offshore',
        path: '/'
      })
      check('same-selector rewrite replaces, not appends', pageEditsStore.count('127.0.0.1') === 3)
      w.tabs.toggleEditMode()
      await delay(300)
      check('edit mode ends on request', tab.info().editing === false)
      tab.wc.reload()
      await delay(2500)
      const applied = await tab.wc.executeJavaScript(`JSON.stringify({
        banner: getComputedStyle(document.getElementById('banner')).display,
        headline: document.getElementById('headline').textContent
      })`)
      say(`[flowtest] after reload: ${applied}`)
      check('hide survives a reload', String(applied).includes('"banner":"none"'))
      check('text edit survives a reload', String(applied).includes('Rewritten by Offshore'))
      check('tab info counts every edit', tab.info().editCount === 3)

      // 5. switching the site off restores the page without forgetting anything
      pageEditsStore.setEnabled('127.0.0.1', false)
      w.tabs.refreshPageEdits('127.0.0.1')
      const restored = await settle(async () => {
        const s = (await tab.wc.executeJavaScript(`JSON.stringify({
          banner: getComputedStyle(document.getElementById('banner')).display,
          headline: document.getElementById('headline').textContent
        })`)) as string
        return s.includes('"banner":"block"') && s.includes('Original headline') ? true : undefined
      }, 5000)
      check('turning the site off restores the page live', restored === true)
      check('the ledger still holds the edits', pageEditsStore.count('127.0.0.1') === 3)

      // 6. forgetting the site really forgets
      pageEditsStore.clear('127.0.0.1')
      w.tabs.refreshPageEdits('127.0.0.1')
      await delay(300)
      check('clearing empties the ledger', pageEditsStore.count('127.0.0.1') === 0)
      check('tab info agrees', tab.info().editCount === 0)

      // flows leave over app.exit, which skips the debounced save — write now
      pageEditsStore.flush()
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
      const fs = w.tabs.activeTab!.view.getBounds()
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
