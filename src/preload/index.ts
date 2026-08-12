import { contextBridge, ipcRenderer } from 'electron'
import { CHROME_EVENTS, type OffshoreApi } from '@shared/bridge'

// Expose the extension browser-action element (<browser-action-list>) to the chrome UI
try {
  const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')
  injectBrowserAction()
} catch (err) {
  console.warn('[preload] browser action injection unavailable:', err)
}

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const SUBSCRIBABLE: ReadonlySet<string> = new Set(CHROME_EVENTS)

const api: OffshoreApi = {
  tabs: {
    create: (url?: string) => invoke('tabs:new', url),
    close: (id: number) => invoke('tabs:close', id),
    activate: (id: number) => invoke('tabs:activate', id),
    navigate: (id: number | null, input: string) => invoke('tabs:navigate', id, input),
    back: (id?: number) => invoke('tabs:back', id),
    forward: (id?: number) => invoke('tabs:forward', id),
    reload: (id?: number, force?: boolean) => invoke('tabs:reload', id, force),
    stop: (id?: number) => invoke('tabs:stop', id),
    reorder: (ids: number[]) => invoke('tabs:reorder', ids),
    toggleSplit: () => invoke('tabs:toggle-split'),
    splitWith: (tabId: number) => invoke('tabs:split-with', tabId),
    unsplit: () => invoke('tabs:unsplit'),
    devtools: () => invoke('tabs:devtools'),
    devtoolsDock: (dock: string) => invoke('tabs:devtools-dock', dock),
    mute: (id: number, muted: boolean) => invoke('tabs:mute', id, muted),
    getState: () => invoke('tabs:get-state')
  },
  spaces: {
    create: (name?: string) => invoke('spaces:create', name),
    activate: (id: string) => invoke('spaces:activate', id),
    rename: (id: string, name: string) => invoke('spaces:rename', id, name),
    setAccent: (id: string, accent: string | null) => invoke('spaces:set-accent', id, accent),
    moveTab: (tabId: number, spaceId: string) => invoke('spaces:move-tab', tabId, spaceId),
    setProfile: (id: string, profile: string) => invoke('spaces:set-profile', id, profile),
    remove: (id: string) => invoke('spaces:remove', id)
  },
  menu: {
    homeContext: () => invoke('menu:home-context'),
    tabContext: (tabId: number) => invoke('menu:tab-context', tabId),
    spaceContext: (spaceId: string) => invoke('menu:space-context', spaceId),
    bookmarkContext: (nodeId: string) => invoke('menu:bookmark-context', nodeId)
  },
  omnibox: {
    suggest: (input: string) => invoke('omnibox:suggest', input)
  },
  home: {
    /** Put the new tab's search panel up, or dismiss it and leave the home page. */
    setSearch: (open: boolean, tabId?: number) => invoke('home:set-search', open, tabId)
  },
  extensions: {
    has: () => invoke('extensions:has')
  },
  actions: {
    run: (id: string) => invoke('action:run', id)
  },
  chrome: {
    setInsets: (insets: { top: number; left: number; right: number; bottom: number }) =>
      invoke('chrome:insets', insets),
    setOverlay: (open: boolean) => invoke('chrome:overlay', open),
    setCollapsed: (collapsed: boolean) => invoke('chrome:set-collapsed', collapsed),
    /** The page still is up — main may hide the live view now. */
    freezeAck: () => ipcRenderer.send('chrome:freeze-ack'),
    focusPage: () => invoke('chrome:focus-page'),
    copyText: (text: string) => invoke('chrome:copy-text', text)
  },
  privacy: {
    clearSite: () => invoke('privacy:clear-site')
  },
  brief: {
    weather: () => invoke('brief:weather')
  },
  find: {
    start: (text: string, opts: { findNext: boolean; forward: boolean }) =>
      invoke('find:start', text, opts),
    stop: () => invoke('find:stop')
  },
  bookmarks: {
    list: () => invoke('bookmarks:list'),
    toggle: (url: string, title: string, favicon?: string) =>
      invoke('bookmarks:toggle', url, title, favicon),
    addFolder: (title: string, parentId: string | null) =>
      invoke('bookmarks:add-folder', title, parentId),
    update: (id: string, patch: { title?: string; url?: string }) =>
      invoke('bookmarks:update', id, patch),
    move: (id: string, parentId: string | null, index: number) =>
      invoke('bookmarks:move', id, parentId, index),
    remove: (id: string) => invoke('bookmarks:remove', id),
    setLastFolder: (id: string | null) => invoke('bookmarks:set-last-folder', id)
  },
  passwords: {
    resolveOffer: (offerId: string, action: 'save' | 'never' | 'dismiss') =>
      invoke('passwords:resolve-offer', offerId, action)
  },
  popups: {
    getBlocked: (tabId: number) => invoke('popups:get-blocked', tabId),
    open: (tabId: number, url: string) => invoke('popups:open', tabId, url),
    allowSite: (tabId: number) => invoke('popups:allow-site', tabId)
  },
  downloads: {
    list: () => invoke('downloads:list'),
    clear: () => invoke('downloads:clear'),
    open: (id: string) => invoke('downloads:open', id),
    reveal: (id: string) => invoke('downloads:reveal', id)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch: unknown) => invoke('settings:set', patch)
  },
  adblock: {
    toggleSite: (url: string) => invoke('adblock:toggle-site', url)
  },
  window: {
    zoom: () => invoke('window:zoom')
  },
  on: (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
    if (!SUBSCRIBABLE.has(channel)) throw new Error(`Unknown channel: ${channel}`)
    const listener = (_e: unknown, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  devshotDone: () => ipcRenderer.send('devshot:composite-done')
}

contextBridge.exposeInMainWorld('offshore', api)
