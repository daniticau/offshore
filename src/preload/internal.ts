import { contextBridge, ipcRenderer } from 'electron'

/**
 * Minimal bridge for Offshore's own pages (offshore://start, offshore://settings).
 * This preload is attached to every tab, so the main process additionally
 * verifies the sender frame's origin before honoring any of these calls.
 */
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api = {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch: unknown) => invoke('settings:set', patch)
  },
  bookmarks: {
    list: () => invoke('bookmarks:list'),
    remove: (idOrUrl: string) => invoke('bookmarks:remove', idOrUrl)
  },
  extensions: {
    list: () => invoke('extensions:list'),
    uninstall: (id: string) => invoke('extensions:uninstall', id)
  },
  history: {
    clear: () => invoke('history:clear')
  },
  open: (url: string) => invoke('internal:open', url)
}

contextBridge.exposeInMainWorld('offshoreInternal', api)

export type OffshoreInternalApi = typeof api
