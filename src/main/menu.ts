import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import { settingsStore } from './stores'
import { internalPageUrl } from './util'
import { createWindow, focusedOffshoreWindow, type OffshoreWindow } from './windows'

function fw(): OffshoreWindow | undefined {
  return focusedOffshoreWindow()
}

function withActive(fn: (w: OffshoreWindow) => void): () => void {
  return () => {
    const w = fw()
    if (w) fn(w)
  }
}

export function installMenu(): void {
  const selectTabItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
    accelerator: `Cmd+${i + 1}`,
    click: withActive((w) => {
      const tabs = w.tabs.tabsIn(w.tabs.activeSpaceId)
      const tab = i === 8 ? tabs[tabs.length - 1] : tabs[i]
      if (tab) w.tabs.activateTab(tab.id)
    })
  }))

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Offshore',
      submenu: [
        { label: 'About Offshore', role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: withActive((w) => w.tabs.createTab(internalPageUrl('settings')))
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Offshore' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Offshore' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'Cmd+T',
          // Cursor lands in the omnibox, or in the page's pill in vertical mode
          click: withActive((w) => w.openNewTab())
        },
        { label: 'New Window', accelerator: 'Cmd+N', click: () => void createWindow() },
        {
          label: 'New Space',
          accelerator: 'Cmd+Alt+N',
          click: withActive((w) => {
            const space = w.tabs.createSpace()
            w.sendToChrome('spaces:begin-rename', space.id)
          })
        },
        { type: 'separator' },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'Cmd+Shift+T',
          click: withActive((w) => w.tabs.reopenClosedTab())
        },
        { type: 'separator' },
        {
          label: 'Open Location…',
          accelerator: 'Cmd+L',
          click: withActive((w) => {
            w.win.webContents.focus()
            w.sendToChrome('omnibox:focus')
          })
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'Cmd+W',
          click: withActive((w) => {
            const active = w.tabs.activeTab
            if (active) w.tabs.closeTab(active.id)
            else w.win.close()
          })
        },
        { label: 'Close Window', accelerator: 'Cmd+Shift+W', role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find…',
          accelerator: 'Cmd+F',
          click: withActive((w) => w.sendToChrome('find:open'))
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Page',
          accelerator: 'Cmd+R',
          click: withActive((w) => w.tabs.activeTab?.wc.reload())
        },
        {
          label: 'Force Reload',
          accelerator: 'Cmd+Shift+R',
          click: withActive((w) => w.tabs.activeTab?.wc.reloadIgnoringCache())
        },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'Cmd+S',
          click: withActive((w) => w.sendToChrome('chrome:toggle-collapse'))
        },
        {
          label: 'Switch Tab Layout',
          accelerator: 'Cmd+Shift+B',
          click: () => {
            const current = settingsStore.get().tabOrientation
            settingsStore.set({ tabOrientation: current === 'vertical' ? 'horizontal' : 'vertical' })
          }
        },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'Cmd+0',
          click: withActive((w) => w.tabs.activeTab?.wc.setZoomLevel(0))
        },
        {
          label: 'Zoom In',
          accelerator: 'Cmd+Plus',
          click: withActive((w) => {
            const wc = w.tabs.activeTab?.wc
            if (wc) wc.setZoomLevel(wc.getZoomLevel() + 1)
          })
        },
        {
          label: 'Zoom Out',
          accelerator: 'Cmd+-',
          click: withActive((w) => {
            const wc = w.tabs.activeTab?.wc
            if (wc) wc.setZoomLevel(wc.getZoomLevel() - 1)
          })
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Developer',
          submenu: [
            {
              label: 'Toggle Developer Tools',
              accelerator: 'Cmd+Alt+I',
              click: withActive((w) => w.tabs.toggleDevTools())
            },
            {
              label: 'Toggle Browser UI DevTools',
              click: withActive((w) => w.win.webContents.openDevTools({ mode: 'detach' }))
            }
          ]
        }
      ]
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'Cmd+[', click: withActive((w) => w.tabs.goBack()) },
        { label: 'Forward', accelerator: 'Cmd+]', click: withActive((w) => w.tabs.goForward()) }
      ]
    },
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Page…',
          accelerator: 'Cmd+D',
          click: withActive((w) => w.sendToChrome('bookmarks:edit-current'))
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Show Next Tab',
          accelerator: 'Ctrl+Tab',
          click: withActive((w) => cycleTab(w, 1))
        },
        {
          label: 'Show Previous Tab',
          accelerator: 'Ctrl+Shift+Tab',
          click: withActive((w) => cycleTab(w, -1))
        },
        { type: 'separator' },
        {
          label: 'Next Space',
          accelerator: 'Cmd+Alt+Right',
          click: withActive((w) => w.tabs.cycleSpace(1))
        },
        {
          label: 'Previous Space',
          accelerator: 'Cmd+Alt+Left',
          click: withActive((w) => w.tabs.cycleSpace(-1))
        },
        { type: 'separator' },
        ...selectTabItems,
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.setName('Offshore')
}

function cycleTab(w: OffshoreWindow, dir: 1 | -1): void {
  const tabs = w.tabs.tabsIn(w.tabs.activeSpaceId)
  if (tabs.length < 2) return
  const idx = tabs.findIndex((t) => t.id === w.tabs.activeTabId)
  const next = tabs[(idx + dir + tabs.length) % tabs.length]
  w.tabs.activateTab(next.id)
}
