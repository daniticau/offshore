import { contextBridge, ipcRenderer } from 'electron'

// Expose the extension browser-action element (<browser-action-list>) to the chrome UI
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')
  injectBrowserAction()
} catch (err) {
  console.warn('[preload] browser action injection unavailable:', err)
}

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const SUBSCRIBABLE = new Set([
  'tabs:state',
  'settings:changed',
  'bookmarks:changed',
  'omnibox:focus',
  'find:open',
  'find:result',
  'downloads:event',
  'devshot:composite'
])

const api = {
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
    mute: (id: number, muted: boolean) => invoke('tabs:mute', id, muted),
    getState: () => invoke('tabs:get-state')
  },
  omnibox: {
    suggest: (input: string) => invoke('omnibox:suggest', input)
  },
  chrome: {
    setInsets: (insets: { top: number; left: number; right: number; bottom: number }) =>
      invoke('chrome:insets', insets),
    setOverlay: (open: boolean) => invoke('chrome:overlay', open)
  },
  find: {
    start: (text: string, opts: { findNext: boolean; forward: boolean }) =>
      invoke('find:start', text, opts),
    stop: () => invoke('find:stop')
  },
  bookmarks: {
    list: () => invoke('bookmarks:list'),
    toggle: (url: string, title: string) => invoke('bookmarks:toggle', url, title),
    remove: (idOrUrl: string) => invoke('bookmarks:remove', idOrUrl)
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

export type OffshoreApi = typeof api
