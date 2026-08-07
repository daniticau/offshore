import { ipcMain, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import { SEARCH_ENGINES, type Settings, type Suggestion } from '@shared/types'
import { adblock } from './adblock'
import { listExtensions, uninstallExtension } from './extensions'
import { bookmarksStore, historyStore, settingsStore } from './stores'
import { devRendererUrl, prettyHost, resolveOmniboxInput } from './util'
import { windowForChromeContents, windows, type Insets, type OffshoreWindow } from './windows'

function chromeWindow(e: IpcMainInvokeEvent): OffshoreWindow | undefined {
  return windowForChromeContents(e.sender.id)
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  if (url.startsWith('offshore://')) return true
  const dev = devRendererUrl()
  if (dev && url.startsWith(dev)) return true
  if (!url && chromeWindow(e)) return true
  return url.startsWith('file://')
}

export function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of windows) w.sendToChrome(channel, ...args)
}

function buildSuggestions(input: string): Suggestion[] {
  const q = input.trim()
  if (!q) return []
  const settings = settingsStore.get()
  const out: Suggestion[] = []

  const resolved = resolveOmniboxInput(q, settings)
  const engine = SEARCH_ENGINES[settings.searchEngine] ?? SEARCH_ENGINES.duckduckgo
  const searchUrl = engine.searchUrl.replace('%s', encodeURIComponent(q))
  out.push({ kind: resolved === searchUrl ? 'search' : 'url', text: q, url: resolved })

  for (const page of ['start', 'settings'] as const) {
    if (page.startsWith(q.toLowerCase()) || `offshore://${page}`.startsWith(q.toLowerCase())) {
      out.push({ kind: 'internal', text: `offshore://${page}`, url: `offshore://${page}`, title: page === 'start' ? 'Start Page' : 'Settings' })
    }
  }

  const ql = q.toLowerCase()
  const seen = new Set(out.map((s) => s.url))
  for (const h of historyStore.search(ql, 6)) {
    if (!seen.has(h.url)) {
      out.push(h)
      seen.add(h.url)
    }
  }
  return out.slice(0, 8)
}

export function setupIpc(): void {
  // ---- tabs (chrome UI only) ----
  ipcMain.handle('tabs:new', (e, url?: string) => {
    const resolved = url ? resolveOmniboxInput(url, settingsStore.get()) : undefined
    const tab = chromeWindow(e)?.tabs.createTab(resolved)
    return tab?.id
  })
  ipcMain.handle('tabs:close', (e, id: number) => chromeWindow(e)?.tabs.closeTab(id))
  ipcMain.handle('tabs:activate', (e, id: number) => chromeWindow(e)?.tabs.activateTab(id))
  ipcMain.handle('tabs:navigate', (e, id: number | null, input: string) =>
    chromeWindow(e)?.tabs.navigate(id, input)
  )
  ipcMain.handle('tabs:back', (e, id?: number) => chromeWindow(e)?.tabs.goBack(id))
  ipcMain.handle('tabs:forward', (e, id?: number) => chromeWindow(e)?.tabs.goForward(id))
  ipcMain.handle('tabs:reload', (e, id?: number, force?: boolean) => {
    const w = chromeWindow(e)
    const tab = id == null ? w?.tabs.activeTab : w?.tabs.byId(id)
    if (!tab) return
    if (force) tab.wc.reloadIgnoringCache()
    else tab.wc.reload()
  })
  ipcMain.handle('tabs:stop', (e, id?: number) => {
    const w = chromeWindow(e)
    const tab = id == null ? w?.tabs.activeTab : w?.tabs.byId(id)
    tab?.wc.stop()
  })
  ipcMain.handle('tabs:reorder', (e, ids: number[]) => chromeWindow(e)?.tabs.reorder(ids))
  ipcMain.handle('tabs:mute', (e, id: number, muted: boolean) => {
    const tab = chromeWindow(e)?.tabs.byId(id)
    tab?.wc.setAudioMuted(muted)
    chromeWindow(e)?.tabs.pushState()
  })
  ipcMain.handle('tabs:get-state', (e) => chromeWindow(e)?.tabs.state())

  // ---- omnibox ----
  ipcMain.handle('omnibox:suggest', (e, input: string) =>
    isTrustedSender(e) ? buildSuggestions(input) : []
  )

  // ---- chrome layout ----
  ipcMain.handle('chrome:insets', (e, insets: Insets) => chromeWindow(e)?.setInsets(insets))
  ipcMain.handle('chrome:overlay', (e, open: boolean) => chromeWindow(e)?.setOverlay(open))

  // ---- find in page ----
  ipcMain.handle('find:start', (e, text: string, opts: { findNext: boolean; forward: boolean }) => {
    const tab = chromeWindow(e)?.tabs.activeTab
    if (!tab || !text) return
    tab.wc.findInPage(text, { findNext: opts.findNext, forward: opts.forward })
  })
  ipcMain.handle('find:stop', (e) => {
    chromeWindow(e)?.tabs.activeTab?.wc.stopFindInPage('clearSelection')
  })

  // ---- bookmarks ----
  ipcMain.handle('bookmarks:list', (e) => (isTrustedSender(e) ? bookmarksStore.list() : []))
  ipcMain.handle('bookmarks:toggle', (e, url: string, title: string) => {
    if (!isTrustedSender(e)) return false
    const result = bookmarksStore.toggle(url, title)
    for (const w of windows) w.tabs.pushState()
    return result
  })
  ipcMain.handle('bookmarks:remove', (e, idOrUrl: string) => {
    if (!isTrustedSender(e)) return
    bookmarksStore.remove(idOrUrl)
    for (const w of windows) w.tabs.pushState()
  })

  // ---- settings ----
  ipcMain.handle('settings:get', (e) => (isTrustedSender(e) ? settingsStore.get() : null))
  ipcMain.handle('settings:set', (e, patch: Partial<Settings>) => {
    if (!isTrustedSender(e)) return settingsStore.get()
    return settingsStore.set(patch)
  })

  // ---- adblock ----
  ipcMain.handle('adblock:toggle-site', (e, url: string) => {
    if (!isTrustedSender(e)) return false
    return adblock.toggleSite(prettyHost(url))
  })

  // ---- extensions ----
  ipcMain.handle('extensions:list', (e) => (isTrustedSender(e) ? listExtensions() : []))
  ipcMain.handle('extensions:uninstall', async (e, id: string) => {
    if (!isTrustedSender(e)) return
    await uninstallExtension(id)
  })

  // ---- window ----
  ipcMain.handle('window:zoom', (e) => {
    const w = chromeWindow(e)
    if (!w) return
    // Honor the user's macOS double-click-titlebar preference
    let action = 'Maximize'
    try {
      action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string') || 'Maximize'
    } catch {
      /* default to zoom */
    }
    if (action === 'Minimize') {
      w.win.minimize()
    } else if (action !== 'None') {
      if (w.win.isMaximized()) w.win.unmaximize()
      else w.win.maximize()
    }
  })

  // ---- misc ----
  ipcMain.handle('history:clear', (e) => {
    if (isTrustedSender(e)) historyStore.clear()
  })
  ipcMain.handle('shell:open-external', (e, url: string) => {
    if (isTrustedSender(e) && /^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle('internal:open', (e, url: string) => {
    if (!isTrustedSender(e)) return
    // Navigate the tab that asked (start page shortcuts / settings links)
    for (const w of windows) {
      const tab = w.tabs.byId(e.sender.id)
      if (tab) {
        w.tabs.navigate(tab.id, url)
        return
      }
    }
  })

  // ---- store change broadcasting ----
  settingsStore.on('changed', (next: Settings) => {
    broadcast('settings:changed', next)
  })
  bookmarksStore.on('changed', () => {
    broadcast('bookmarks:changed', bookmarksStore.list())
    for (const w of windows) w.tabs.pushState()
  })
  adblock.onCountChanged = (tabId) => {
    for (const w of windows) {
      if (w.tabs.byId(tabId)) w.tabs.pushState()
    }
  }
}
