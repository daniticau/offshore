import {
  Menu,
  MenuItem,
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import {
  ACCENTS,
  ACTION_DEFS,
  HOME_WIDGETS,
  SEARCH_ENGINES,
  type AccentId,
  type ActionId,
  type DevToolsDock,
  type Insets,
  type PasswordOffer,
  type Settings,
  type SpaceProfile,
  type Suggestion
} from '@shared/types'
import { adblock } from './adblock'
import { fetchWeather, geocode } from './brief'
import { listExtensions, uninstallExtension } from './extensions'
import { passwordVault } from './passwords'
import {
  allowPopupsForSite,
  blockedPopups,
  clearBlocked,
  noteGesture,
  pageEntry
} from './popups'
import { openDownload, preparedSessions, revealDownload } from './sessions'
import { searchSuggestions } from './suggest'
import { bookmarksStore, downloadsStore, historyStore, settingsStore } from './stores'
import { devRendererUrl, internalPageUrl, prettyHost, resolveOmniboxInput } from './util'
import { windowForChromeContents, windowForTab, windows, type OffshoreWindow } from './windows'

function chromeWindow(e: IpcMainInvokeEvent | IpcMainEvent): OffshoreWindow | undefined {
  return windowForChromeContents(e.sender.id)
}

/**
 * Trusted = the chrome UI webContents itself, or a main frame on an internal
 * origin (offshore:// in prod, the exact dev-server origin in dev). Plain
 * file:// pages are NOT trusted — a downloaded .html must never reach
 * privileged channels.
 */
function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  if (chromeWindow(e)) return true
  const frame = e.senderFrame
  if (!frame) return false
  try {
    if (frame.parent !== null) return false
  } catch {
    return false
  }
  const url = frame.url
  if (url.startsWith('offshore://')) return true
  const dev = devRendererUrl()
  if (dev) {
    try {
      return new URL(url).origin === new URL(dev).origin
    } catch {
      return false
    }
  }
  return false
}

/** Page senders (tabs + tracked popups) allowed on the password/gesture channels. */
function validatedPageSender(e: IpcMainEvent): {
  entry: NonNullable<ReturnType<typeof pageEntry>>
  origin: URL
} | null {
  const entry = pageEntry(e.sender.id)
  if (!entry) return null
  const frame = e.senderFrame
  if (!frame || frame !== e.sender.mainFrame) return null
  let origin: URL
  try {
    origin = new URL(frame.url)
  } catch {
    return null
  }
  const ok =
    origin.protocol === 'https:' ||
    (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))
  return ok ? { entry, origin } : null
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of windows) w.sendToChrome(channel, ...args)
}

/**
 * What the omnibox opens with: the sites you go back to, most-used first, then
 * bookmarks to fill out the list. No query yet — this is the empty-input state.
 */
function defaultSuggestions(): Suggestion[] {
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const push = (s: Suggestion): void => {
    if (seen.has(s.url)) return
    seen.add(s.url)
    out.push(s)
  }
  if (settingsStore.get().keepHistory) for (const h of historyStore.top(6)) push(h)
  for (const b of bookmarksStore.top(6)) push(b)
  return out.slice(0, 6)
}

/** How many rows the dropdown will ever show. */
const SUGGESTION_MAX = 8

/**
 * The dropdown's contents, in Chromium's order of usefulness: a tab you already
 * have open, then where this input would actually go, then the pages you know,
 * then — filling whatever room is left — what the engine thinks you are typing.
 */
async function buildSuggestions(input: string, w?: OffshoreWindow): Promise<Suggestion[]> {
  const local = localSuggestions(input, w)
  const q = input.trim()
  const settings = settingsStore.get()
  if (!settings.searchSuggestions || q.length < 2 || local.length >= SUGGESTION_MAX) return local

  const words = await searchSuggestions(q, settings.searchEngine)
  if (!words.length) return local
  const engine = SEARCH_ENGINES[settings.searchEngine] ?? SEARCH_ENGINES.duckduckgo
  const taken = new Set(local.map((s) => s.text.trim().toLowerCase()))
  const out = [...local]
  for (const word of words) {
    if (out.length >= SUGGESTION_MAX) break
    if (taken.has(word.toLowerCase())) continue
    taken.add(word.toLowerCase())
    out.push({
      kind: 'search',
      text: word,
      url: engine.searchUrl.replace('%s', encodeURIComponent(word))
    })
  }
  return out
}

function localSuggestions(input: string, w?: OffshoreWindow): Suggestion[] {
  const q = input.trim()
  if (!q) return defaultSuggestions()
  const ql = q.toLowerCase()
  const settings = settingsStore.get()
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const push = (s: Suggestion): void => {
    const key = s.kind === 'tab' ? `tab:${s.tabId}` : s.kind === 'action' ? `act:${s.action}` : s.url
    if (seen.has(key)) return
    seen.add(key)
    out.push(s)
  }

  // Open tabs in this window (strong matches outrank everything)
  const tabMatches: { strong: boolean; s: Suggestion }[] = []
  if (w) {
    for (const info of w.tabs.state().tabs) {
      if (info.id === w.tabs.activeTabId) continue
      const title = info.title.toLowerCase()
      const host = prettyHost(info.url).toLowerCase()
      if (!title.includes(ql) && !host.includes(ql)) continue
      const strong = host.startsWith(ql) || title.split(/\s+/).some((word) => word.startsWith(ql))
      tabMatches.push({
        strong,
        s: { kind: 'tab', text: info.title, url: info.displayUrl, title: 'Switch to Tab', tabId: info.id }
      })
    }
  }
  for (const m of tabMatches.filter((t) => t.strong).slice(0, 2)) push(m.s)

  const resolved = resolveOmniboxInput(q, settings)
  const engine = SEARCH_ENGINES[settings.searchEngine] ?? SEARCH_ENGINES.duckduckgo
  const searchUrl = engine.searchUrl.replace('%s', encodeURIComponent(q))
  push({ kind: resolved === searchUrl ? 'search' : 'url', text: q, url: resolved })

  // Actions
  if (ql.length >= 2) {
    const acts = ACTION_DEFS.filter(
      (a) => a.label.toLowerCase().includes(ql) || a.keywords.includes(ql)
    ).slice(0, 2)
    for (const a of acts) push({ kind: 'action', text: a.label, url: '', action: a.id })
  }

  for (const page of ['start', 'settings'] as const) {
    if (page.startsWith(ql) || `offshore://${page}`.startsWith(ql)) {
      push({
        kind: 'internal',
        text: `offshore://${page}`,
        url: `offshore://${page}`,
        title: page === 'start' ? 'New Tab' : 'Settings'
      })
    }
  }

  for (const b of bookmarksStore.search(ql, 3)) push(b)
  for (const m of tabMatches.filter((t) => !t.strong).slice(0, 2)) push(m.s)
  if (settings.keepHistory) {
    for (const h of historyStore.search(ql, 6)) push(h)
  }

  // What you have been to outranks what the engine guesses, but it never takes
  // the whole list: a couple of rows are always kept back for the type-ahead.
  return out.slice(0, settings.searchSuggestions ? SUGGESTION_MAX - 3 : SUGGESTION_MAX)
}

function runAction(w: OffshoreWindow, id: ActionId): void {
  switch (id) {
    case 'new-tab':
      w.openNewTab()
      break
    case 'new-window':
      void import('./windows').then((m) => m.createWindow())
      break
    case 'close-tab': {
      const active = w.tabs.activeTab
      if (active) w.tabs.closeTab(active.id)
      break
    }
    case 'reopen-tab':
      w.tabs.reopenClosedTab()
      break
    case 'new-space': {
      const space = w.tabs.createSpace()
      w.sendToChrome('spaces:begin-rename', space.id)
      break
    }
    case 'toggle-layout':
      settingsStore.toggleTabOrientation()
      break
    case 'toggle-sidebar':
      w.sendToChrome('chrome:toggle-hidden')
      break
    case 'open-settings':
      w.tabs.createTab(internalPageUrl('settings'))
      break
    case 'open-downloads':
      void shell.openPath(app.getPath('downloads'))
      break
    case 'show-welcome':
      w.tabs.createTab(internalPageUrl('welcome'))
      break
    case 'cycle-theme': {
      const s = settingsStore.get()
      const order = ['system', 'light', 'dark'] as const
      const next = order[(order.indexOf(s.appearance.theme) + 1) % order.length]
      settingsStore.set({ appearance: { ...s.appearance, theme: next } })
      break
    }
  }
}

export function setupIpc(): void {
  // ---- tabs (chrome UI only) ----
  /*
   * A plain new tab goes through the window, which knows where the cursor
   * belongs afterwards — the same path ⌘T takes, so the + button and the
   * shortcut cannot drift apart. A tab asked for by address is just a tab.
   */
  ipcMain.handle('tabs:new', (e, url?: string) => {
    const w = chromeWindow(e)
    if (!w) return
    // No url is the chrome's own newTab() asking for a real tab — make one.
    // (It must NOT route back through openNewTab, which asks the chrome.)
    if (!url) return w.newTabNow().id
    return w.tabs.createTab(resolveOmniboxInput(url, settingsStore.get())).id
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

  // ---- spaces ----
  ipcMain.handle('spaces:create', (e, name?: string) => {
    const w = chromeWindow(e)
    if (!w) return
    const space = w.tabs.createSpace(name)
    return space.id
  })
  ipcMain.handle('spaces:activate', (e, id: string) => chromeWindow(e)?.tabs.activateSpace(id))
  ipcMain.handle('spaces:rename', (e, id: string, name: string) =>
    chromeWindow(e)?.tabs.renameSpace(id, name)
  )
  ipcMain.handle('spaces:set-accent', (e, id: string, accent: AccentId | null) =>
    chromeWindow(e)?.tabs.setSpaceAccent(id, accent)
  )
  ipcMain.handle('spaces:move-tab', (e, tabId: number, spaceId: string) =>
    chromeWindow(e)?.tabs.moveTabToSpace(tabId, spaceId)
  )
  ipcMain.handle('spaces:remove', async (e, id: string) => {
    const w = chromeWindow(e)
    if (!w) return
    await confirmDeleteSpace(w, id)
  })
  ipcMain.handle('spaces:set-profile', async (e, id: string, profile: SpaceProfile) => {
    const w = chromeWindow(e)
    if (!w || (profile !== 'shared' && profile !== 'separate')) return
    await confirmSpaceProfile(w, id, profile)
  })

  // ---- native context menus for the chrome strip ----
  ipcMain.handle('downloads:list', (e) => (chromeWindow(e) ? downloadsStore.list() : []))
  ipcMain.handle('downloads:clear', (e) => {
    if (chromeWindow(e)) downloadsStore.clear()
  })
  ipcMain.handle('extensions:has', async (e) => {
    if (!chromeWindow(e)) return false
    try {
      return (await listExtensions()).length > 0
    } catch {
      return false
    }
  })
  ipcMain.handle('tabs:toggle-split', (e) => chromeWindow(e)?.tabs.toggleSplit())
  ipcMain.handle('tabs:split-with', (e, tabId: number) => chromeWindow(e)?.tabs.splitWith(tabId))
  ipcMain.handle('tabs:unsplit', (e) => chromeWindow(e)?.tabs.unsplit())
  ipcMain.handle('tabs:devtools', (e) => chromeWindow(e)?.tabs.toggleDevTools())
  ipcMain.handle('tabs:devtools-dock', (e, dock: DevToolsDock) => {
    if (!['right', 'bottom', 'window'].includes(dock)) return
    chromeWindow(e)?.tabs.setDevToolsDock(dock)
  })

  // The three-dots menu: everything Helium keeps behind its kebab
  // AI-slop heuristics run in the page preload; main just records the verdict.
  ipcMain.on('slop:report', (e, payload: { score: number; signals: string[] }) => {
    if (!settingsStore.get().slopDetector) return
    const v = validatedPageSender(e)
    if (!v || v.entry.kind !== 'tab') return
    const w = v.entry.ownerWindow
    const tab = w.tabs.byId(e.sender.id)
    if (!tab) return
    const score = Math.max(0, Math.min(100, Math.round(Number(payload?.score) || 0)))
    tab.slopScore = score
    w.tabs.pushState()
  })

  /**
   * Right-click on the zero-tab home screen. That screen lives in the chrome,
   * not in a tab, so it never reaches the tab context menu — it asks for this
   * one instead, and gets the same Edit Widgets the new tab page offers.
   */
  ipcMain.handle('menu:home-context', (e) => {
    const w = chromeWindow(e)
    if (!w) return
    Menu.buildFromTemplate([
      // parked with the widget board itself — see HOME_WIDGETS
      ...(HOME_WIDGETS
        ? [
            { label: 'Edit Widgets…', click: () => w.sendToChrome('widgets:edit') },
            { type: 'separator' as const }
          ]
        : []),
      { label: 'New Tab', accelerator: 'Cmd+T', click: () => w.openNewTab() },
      { label: 'Settings…', accelerator: 'Cmd+,', click: () => w.tabs.createTab(internalPageUrl('settings')) }
    ]).popup({ window: w.win })
  })

  // No menu:app-context here: the ⋮ menu is drawn by the chrome itself (see
  // Menus.tsx), the way Chromium draws its own kebab rather than handing the
  // job to the system. Right-click menus below stay native — so are Chrome's.

  ipcMain.handle('menu:tab-context', (e, tabId: number) => {
    const w = chromeWindow(e)
    const tab = w?.tabs.byId(tabId)
    if (!w || !tab) return
    const menu = new Menu()
    const add = (opts: Electron.MenuItemConstructorOptions): void => {
      menu.append(new MenuItem(opts))
    }
    add({ label: 'Close Tab', click: () => w.tabs.closeTab(tabId) })
    add({ label: 'Close Other Tabs', click: () => w.tabs.closeOtherTabs(tabId) })
    add({ label: 'Duplicate Tab', click: () => w.tabs.duplicateTab(tabId) })
    add({ type: 'separator' })
    const inSplit = w.tabs.splitPair?.includes(tabId) ?? false
    if (inSplit) {
      add({ label: 'Remove from Split View', click: () => w.tabs.unsplit() })
    } else if (tabId === w.tabs.activeTabId) {
      add({
        label: 'Split View with New Tab',
        accelerator: 'Cmd+Shift+S',
        click: () => w.tabs.toggleSplit()
      })
    } else {
      add({ label: 'Split View with This Tab', click: () => w.tabs.splitWith(tabId) })
    }
    add({ type: 'separator' })
    const others = w.tabs.spaces.filter((s) => s.id !== tab.spaceId)
    add({
      label: 'Move to Space',
      submenu: [
        ...others.map((s) => ({
          label: s.name,
          click: () => w.tabs.moveTabToSpace(tabId, s.id)
        })),
        ...(others.length ? [{ type: 'separator' as const }] : []),
        {
          label: 'New Space',
          click: () => {
            const space = w.tabs.createSpace()
            w.tabs.moveTabToSpace(tabId, space.id)
            w.sendToChrome('spaces:begin-rename', space.id)
          }
        }
      ]
    })
    add({ type: 'separator' })
    const muted = tab.wc.isAudioMuted()
    add({
      label: muted ? 'Unmute Tab' : 'Mute Tab',
      click: () => {
        tab.wc.setAudioMuted(!muted)
        w.tabs.pushState()
      }
    })
    const url = tab.wc.getURL()
    if (url && !url.startsWith('offshore://')) {
      const starred = bookmarksStore.isBookmarked(url)
      add({
        label: starred ? 'Remove Bookmark' : 'Bookmark Tab',
        click: () => {
          bookmarksStore.toggle(url, tab.wc.getTitle(), tab.favicon)
        }
      })
    }
    menu.popup({ window: w.win })
  })

  ipcMain.handle('menu:space-context', (e, spaceId: string) => {
    const w = chromeWindow(e)
    const space = w?.tabs.spaceById(spaceId)
    if (!w || !space) return
    const menu = new Menu()
    const add = (opts: Electron.MenuItemConstructorOptions): void => {
      menu.append(new MenuItem(opts))
    }
    add({ label: 'Rename…', click: () => w.sendToChrome('spaces:begin-rename', spaceId) })
    add({
      label: 'Accent',
      submenu: [
        {
          label: 'Follow Browser',
          type: 'radio',
          checked: !space.accent,
          click: () => w.tabs.setSpaceAccent(spaceId, null)
        },
        ...(Object.keys(ACCENTS) as AccentId[]).map((id) => ({
          label: ACCENTS[id].name,
          type: 'radio' as const,
          checked: space.accent === id,
          click: () => w.tabs.setSpaceAccent(spaceId, id)
        }))
      ]
    })
    add({
      label: 'Separate Logins',
      type: 'checkbox',
      checked: space.profile === 'separate',
      click: () =>
        void confirmSpaceProfile(w, spaceId, space.profile === 'separate' ? 'shared' : 'separate')
    })
    add({ type: 'separator' })
    add({
      label: 'Delete Space…',
      enabled: w.tabs.spaces.length > 1,
      click: () => void confirmDeleteSpace(w, spaceId)
    })
    menu.popup({ window: w.win })
  })

  ipcMain.handle('menu:bookmark-context', (e, nodeId: string) => {
    const w = chromeWindow(e)
    const node = bookmarksStore.byId(nodeId)
    if (!w || !node) return
    const menu = new Menu()
    const add = (opts: Electron.MenuItemConstructorOptions): void => {
      menu.append(new MenuItem(opts))
    }
    if (node.type === 'bookmark' && node.url) {
      const url = node.url
      add({ label: 'Open in New Tab', click: () => w.tabs.createTab(url) })
      add({ label: 'Open in Background', click: () => w.tabs.createTab(url, { activate: false }) })
      add({ type: 'separator' })
    }
    add({ label: 'Rename…', click: () => (settingsStore.get().tabOrientation === 'horizontal'
          ? w.tabs.createTab(internalPageUrl('settings') + '#bookmarks')
          : w.sendToChrome('bookmarks:begin-rename', nodeId)) })
    add({
      label: 'New Folder',
      click: () => {
        const folder = bookmarksStore.createFolder('New Folder', node.parentId)
        w.sendToChrome('bookmarks:begin-rename', folder.id)
      }
    })
    add({ type: 'separator' })
    const childCount = bookmarksStore.list().filter((n) => n.parentId === node.id).length
    add({
      label: 'Delete',
      click: () => {
        void (async () => {
          if (node.type === 'folder' && childCount > 0) {
            const r = await dialog.showMessageBox(w.win, {
              type: 'question',
              buttons: ['Delete', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              message: `Delete “${node.title}” and everything inside it?`
            })
            if (r.response !== 0) return
          }
          bookmarksStore.remove(nodeId)
        })()
      }
    })
    menu.popup({ window: w.win })
  })

  // ---- omnibox ----
  ipcMain.handle('omnibox:suggest', (e, input: string) =>
    isTrustedSender(e) ? buildSuggestions(input, chromeWindow(e)) : []
  )

  /**
   * The same list for the home screen's search. It asks as a tab page rather
   * than as the chrome, so the window is the one that owns the sender — without
   * this the panel on every new tab was the one search in the app with no
   * type-ahead under it at all.
   */
  ipcMain.handle('home:suggest', (e, input: string) =>
    isTrustedSender(e) ? buildSuggestions(String(input ?? ''), windowForTab(e.sender.id)) : []
  )

  /**
   * The home screen's search, opened and closed from either side: the chrome's
   * ✕ passes the tab it means, the page passes nothing and means itself.
   */
  ipcMain.handle('home:set-search', (e, open: boolean, tabId?: number) => {
    if (!isTrustedSender(e)) return
    const chrome = chromeWindow(e)
    if (chrome) {
      chrome.tabs.setHomeSearch(typeof tabId === 'number' ? tabId : null, !!open)
      return
    }
    const w = windowForTab(e.sender.id)
    w?.tabs.setHomeSearch(e.sender.id, !!open)
  })

  /** The home screen has its first frame up; whoever is waiting to show it can. */
  ipcMain.on('home:painted', (e) => {
    if (!isTrustedSender(e)) return
    windowForTab(e.sender.id)?.tabs.byId(e.sender.id)?.markPainted()
  })

  // ---- palette actions ----
  ipcMain.handle('action:run', (e, id: ActionId) => {
    const w = chromeWindow(e)
    if (!w) return
    if (!ACTION_DEFS.some((a) => a.id === id)) return
    runAction(w, id)
  })

  // ---- chrome layout ----
  ipcMain.handle('chrome:insets', (e, insets: Insets) => chromeWindow(e)?.setInsets(insets))
  ipcMain.handle('chrome:overlay', (e, open: boolean) => chromeWindow(e)?.setOverlay(open))
  ipcMain.handle('chrome:focus-page', (e) => chromeWindow(e)?.tabs.activeTab?.wc.focus())
  ipcMain.handle('chrome:set-collapsed', (e, collapsed: boolean) =>
    chromeWindow(e)?.setCollapsed(collapsed)
  )
  // "the still is on screen" — the page view can step aside now
  ipcMain.on('chrome:freeze-ack', (e) => chromeWindow(e)?.onFreezeAck())
  ipcMain.handle('chrome:copy-text', (e, text: string) => {
    if (!isTrustedSender(e) || typeof text !== 'string' || !text) return
    clipboard.writeText(text)
  })

  // ---- find in page ----
  ipcMain.handle('find:start', (e, text: string, opts: { findNext: boolean; forward: boolean }) => {
    const tab = chromeWindow(e)?.tabs.activeTab
    if (!tab || !text) return
    tab.wc.findInPage(text, { findNext: opts.findNext, forward: opts.forward })
  })
  ipcMain.handle('find:stop', (e) => {
    chromeWindow(e)?.tabs.activeTab?.wc.stopFindInPage('clearSelection')
  })

  // ---- bookmarks (v2 tree) ----
  ipcMain.handle('bookmarks:list', (e) => (isTrustedSender(e) ? bookmarksStore.list() : []))
  ipcMain.handle('bookmarks:toggle', (e, url: string, title: string, favicon?: string) => {
    if (!isTrustedSender(e)) return false
    return bookmarksStore.toggle(url, title, favicon)
  })
  ipcMain.handle('bookmarks:add-folder', (e, title: string, parentId: string | null) => {
    if (!isTrustedSender(e)) return null
    return bookmarksStore.createFolder(title, parentId)
  })
  ipcMain.handle('bookmarks:update', (e, id: string, patch: { title?: string; url?: string }) => {
    if (!isTrustedSender(e)) return
    bookmarksStore.update(id, patch)
  })
  ipcMain.handle('bookmarks:move', (e, id: string, parentId: string | null, index: number) => {
    if (!isTrustedSender(e)) return
    bookmarksStore.move(id, parentId, index)
  })
  ipcMain.handle('bookmarks:remove', (e, id: string) => {
    if (!isTrustedSender(e)) return
    bookmarksStore.remove(id)
  })
  ipcMain.handle('bookmarks:set-last-folder', (e, id: string | null) => {
    if (!isTrustedSender(e)) return
    bookmarksStore.setLastFolder(id)
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

  // ---- popups ----
  ipcMain.on('gesture:activity', (e) => {
    if (pageEntry(e.sender.id)) noteGesture(e.sender.id)
  })
  ipcMain.handle('popups:get-blocked', (e, tabId: number) =>
    chromeWindow(e) ? blockedPopups(tabId) : []
  )
  ipcMain.handle('popups:open', (e, tabId: number, url: string) => {
    const w = chromeWindow(e)
    if (!w) return
    w.tabs.openBlockedPopup(tabId, url)
    clearBlocked(tabId)
    w.tabs.pushState()
  })
  ipcMain.handle('popups:allow-site', (e, tabId: number) => {
    const w = chromeWindow(e)
    const tab = w?.tabs.byId(tabId)
    if (!w || !tab) return
    const host = prettyHost(tab.wc.getURL())
    if (host) allowPopupsForSite(host)
    clearBlocked(tabId)
    w.tabs.pushState()
  })

  // ---- passwords ----
  ipcMain.on('passwords:candidate', (e, payload: { username?: unknown; password?: unknown }) => {
    const sender = validatedPageSender(e)
    if (!sender) return
    if (!settingsStore.get().passwords.enabled || !passwordVault.available()) return
    const username = String(payload?.username ?? '').slice(0, 256)
    const password = String(payload?.password ?? '')
    if (!password || password.length > 512) return
    const { entry, origin } = sender
    const host = origin.hostname.replace(/^www\./, '')
    const w = entry.ownerWindow
    const tabId = entry.kind === 'tab' ? e.sender.id : w.tabs.activeTabId
    const offer = passwordVault.considerCandidate(
      origin.origin,
      host,
      username,
      password,
      tabId,
      entry.partition
    )
    if (offer) {
      const payload: PasswordOffer = {
        offerId: offer.offerId,
        tabId: offer.tabId,
        host: offer.host,
        username: offer.username,
        kind: offer.kind
      }
      w.sendToChrome('passwords:offer', payload)
    }
  })
  ipcMain.handle('passwords:resolve-offer', (e, offerId: string, action: 'save' | 'never' | 'dismiss') => {
    if (!chromeWindow(e)) return
    passwordVault.resolveOffer(offerId, action)
  })
  ipcMain.handle('passwords:status', (e) => {
    if (!isTrustedSender(e)) return { available: false, canTouchId: false }
    return passwordVault.status()
  })
  ipcMain.handle('passwords:list', (e) => (isTrustedSender(e) ? passwordVault.list() : []))
  ipcMain.handle('passwords:reveal', (e, id: string) =>
    isTrustedSender(e) ? passwordVault.reveal(id) : null
  )
  ipcMain.handle('passwords:copy', (e, id: string) =>
    isTrustedSender(e) ? passwordVault.copy(id) : false
  )
  ipcMain.handle('passwords:delete', (e, id: string) => {
    if (isTrustedSender(e)) passwordVault.delete(id)
  })
  ipcMain.handle('passwords:never-list', (e) => (isTrustedSender(e) ? passwordVault.neverList() : []))
  ipcMain.handle('passwords:remove-never', (e, origin: string) => {
    if (isTrustedSender(e)) passwordVault.removeNever(origin)
  })

  // ---- weather brief ----
  ipcMain.handle('brief:weather', (e) => (isTrustedSender(e) ? fetchWeather() : null))
  ipcMain.handle('brief:geocode', (e, q: string) => (isTrustedSender(e) ? geocode(q) : []))

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

  // The chrome draws the traffic lights, so it needs the two verbs AppKit used
  // to own. Zoom already had a handler — double-click on the chrome uses it.
  ipcMain.handle('window:close', (e) => chromeWindow(e)?.win.close())
  ipcMain.handle('window:minimize', (e) => chromeWindow(e)?.win.minimize())

  // ---- downloads ----
  ipcMain.handle('downloads:open', (e, id: string) => {
    if (chromeWindow(e)) openDownload(String(id))
  })
  ipcMain.handle('downloads:reveal', (e, id: string) => {
    if (chromeWindow(e)) revealDownload(String(id))
  })

  // ---- misc ----
  ipcMain.handle('app:info', (e) => (isTrustedSender(e) ? { version: app.getVersion() } : null))
  ipcMain.handle('history:clear', (e) => {
    if (isTrustedSender(e)) historyStore.clear()
  })
  // Site-info popover: wipe one origin's cookies/storage in the active tab's jar
  ipcMain.handle('privacy:clear-site', async (e) => {
    const w = chromeWindow(e)
    const tab = w?.tabs.activeTab
    if (!tab) return false
    let origin: string
    try {
      origin = new URL(tab.wc.getURL()).origin
    } catch {
      return false
    }
    if (!/^https?:/.test(origin)) return false
    try {
      await tab.wc.session.clearStorageData({ origin })
      const cookies = await tab.wc.session.cookies.get({ url: origin })
      for (const c of cookies) {
        await tab.wc.session.cookies.remove(origin, c.name).catch(() => {})
      }
      tab.wc.reload()
      return true
    } catch (err) {
      console.warn('[privacy] site clear failed:', err)
      return false
    }
  })
  ipcMain.handle('privacy:clear-site-data', async (e) => {
    if (!isTrustedSender(e)) return
    for (const ses of preparedSessions()) {
      try {
        await ses.clearStorageData({})
        await ses.clearCache()
      } catch (err) {
        console.warn('[privacy] clear failed for a session:', err)
      }
    }
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

/** Flipping a space's cookie jar reloads its tabs, so it gets asked about first. */
async function confirmSpaceProfile(
  w: OffshoreWindow,
  spaceId: string,
  profile: SpaceProfile
): Promise<void> {
  const space = w.tabs.spaceById(spaceId)
  if (!space || space.profile === profile) return
  const toSeparate = profile === 'separate'
  const r = await dialog.showMessageBox(w.win, {
    type: 'question',
    buttons: [toSeparate ? 'Use Separate Logins' : 'Use Shared Logins', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: toSeparate
      ? `Give “${space.name}” its own logins?`
      : `Switch “${space.name}” back to shared logins?`,
    detail: toSeparate
      ? 'This space gets its own cookies — sign in to a site here without affecting other spaces. Its tabs will reload.'
      : 'This space will share cookies and logins with the rest of Offshore. Its tabs will reload.'
  })
  if (r.response === 0) w.tabs.setSpaceProfile(spaceId, profile)
}

async function confirmDeleteSpace(w: OffshoreWindow, spaceId: string): Promise<void> {
  const space = w.tabs.spaceById(spaceId)
  if (!space || w.tabs.spaces.length < 2) return
  const tabs = w.tabs.tabsIn(spaceId)
  const realTabs = tabs.filter((t) => {
    const u = t.wc.getURL()
    return u && !u.startsWith('offshore://') && !u.includes('/start.html')
  })
  if (realTabs.length) {
    const r = await dialog.showMessageBox(w.win, {
      type: 'question',
      buttons: ['Delete Space', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete “${space.name}”?`,
      detail: `Its ${realTabs.length === 1 ? 'open tab' : `${realTabs.length} open tabs`} will close. Reopen them with ⌘⇧T.`
    })
    if (r.response !== 0) return
  }
  w.tabs.deleteSpace(spaceId)
}
