import { app, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { windows } from './windows'

/**
 * Headless design-verification harness (dev only).
 * OFFSHORE_SHOT=<dir> captures the chrome UI, the active page, and a composite
 * of both, then exits. OFFSHORE_SHOT_URL navigates the first tab there first.
 * OFFSHORE_SHOT_WAIT overrides the settle delay in ms.
 */
export function setupDevshot(): void {
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
    const w = windows.values().next().value
    if (!w) {
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
          `JSON.stringify({palette: !!document.querySelector('.palette-backdrop'), hasApi: typeof window.offshore !== 'undefined'})`
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
