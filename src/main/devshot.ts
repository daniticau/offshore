import { BrowserWindow, app, ipcMain, session } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as nodeHttp from 'http'
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
  console.log('[devshot] userData:', app.getPath('userData'))

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
      const { tabSession } = await import('./tabs')
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
    // Ensure the window is frontmost and the view painted before capturing
    w.win.setAlwaysOnTop(true)
    w.win.show()
    w.win.focus()
    w.win.moveTop()
    w.tabs.setActiveVisible(true)
    await delay(600)
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
    console.log('[devshot] wrote screenshots to', dir)
    app.exit(0)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
 * OFFSHORE_TEST_FLOW=passwords|popups|spaces|headers|privacy
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
      check('home screen with search bar shows', eh.includes('"home":true') && eh.includes('"search":true'))
      // typing in the home search conjures the first tab
      w.tabs.navigate(null, 'example.com')
      await delay(1200)
      check('typing creates the first tab', w.tabs.tabs.length === 1)
      say(`[flowtest] done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
      app.exit(failures === 0 ? 0 : 1)
      return
    }

    if (flow === 'slop') {
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

      w.tabs.navigate(null, `http://127.0.0.1:${port}/slop`)
      await delay(4500)
      const slopScore = w.tabs.activeTab?.slopScore ?? 0
      say(`[flowtest] slop page score: ${slopScore}`)
      check('slop page flagged', slopScore >= 25, `score=${slopScore}`)

      w.tabs.navigate(null, `http://127.0.0.1:${port}/clean`)
      await delay(4500)
      const cleanScore = w.tabs.activeTab?.slopScore ?? 0
      say(`[flowtest] clean page score: ${cleanScore}`)
      check('honest prose not flagged', cleanScore < 25, `score=${cleanScore}`)
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
      const bannerText = await w.win.webContents.executeJavaScript(
        `document.querySelector('.password-banner')?.textContent ?? ''`
      )
      check('save banner appears', bannerText.includes('Save password'), bannerText)
      check('banner names the user', bannerText.includes('dani@example.com'))

      // 2. accept the offer from the chrome banner
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
