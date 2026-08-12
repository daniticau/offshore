import { app, dialog } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore } from 'electron-chrome-web-store'
import type { ExtensionInfo } from '@shared/types'
import { extensionsRef } from './extensions-ref'
import { tabSession } from './sessions'
import {
  createWindow,
  focusedOffshoreWindow,
  windowForBrowserWindow,
  windowForBrowserWindowId,
  windowForTab
} from './windows'

export async function initExtensions(): Promise<void> {
  const ses = tabSession()

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,

    async createTab(details) {
      let target =
        typeof details.windowId === 'number' ? windowForBrowserWindowId(details.windowId) : undefined
      target ??= focusedOffshoreWindow() ?? createWindow()
      const tab = target.tabs.createTab(details.url ?? undefined, {
        activate: details.active !== false
      })
      return [tab.wc, target.win]
    },

    selectTab(wc) {
      windowForTab(wc.id)?.tabs.activateTab(wc.id)
    },

    removeTab(wc) {
      windowForTab(wc.id)?.tabs.closeTab(wc.id)
    },

    async createWindow(details) {
      const urls = details.url ? [details.url].flat() : undefined
      return createWindow(urls).win
    },

    async removeWindow(browserWindow) {
      windowForBrowserWindow(browserWindow)?.win.close()
    }
  })

  extensionsRef.current = extensions

  await installChromeWebStore({
    session: ses,
    async beforeInstall(details) {
      const focused = focusedOffshoreWindow()
      const opts = {
        type: 'question' as const,
        buttons: ['Add Extension', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Add “${details.manifest?.name ?? details.id}” to Offshore?`,
        detail: 'Extensions can read and change data on the sites you visit.'
      }
      const result = focused
        ? await dialog.showMessageBox(focused.win, opts)
        : await dialog.showMessageBox(opts)
      return { action: result.response === 0 ? ('allow' as const) : ('deny' as const) }
    }
  })
}

export function listExtensions(): ExtensionInfo[] {
  const ses = tabSession()
  return ses.extensions.getAllExtensions().map((ext) => {
    const icons = (ext.manifest.icons ?? {}) as Record<string, string>
    const sizes = Object.keys(icons)
      .map(Number)
      .sort((a, b) => b - a)
    const iconPath = sizes.length ? icons[String(sizes[0])] : undefined
    return {
      id: ext.id,
      name: ext.name,
      version: ext.manifest.version ?? '',
      description: ext.manifest.description ?? '',
      icon: iconPath ? `chrome-extension://${ext.id}/${iconPath.replace(/^\//, '')}` : undefined
    }
  })
}

export async function uninstallExtension(id: string): Promise<void> {
  const ses = tabSession()
  const ext = ses.extensions.getExtension(id)
  ses.extensions.removeExtension(id)
  // Web-store installs live under userData/Extensions/<id>; clean up the folder too
  try {
    const extDir = join(app.getPath('userData'), 'Extensions', id)
    await fs.rm(extDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  if (ext?.path?.startsWith(join(app.getPath('userData'), 'Extensions'))) {
    try {
      await fs.rm(ext.path, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}
