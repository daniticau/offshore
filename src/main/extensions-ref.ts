import type { ElectronChromeExtensions } from 'electron-chrome-extensions'

/** Late-bound reference so tabs.ts can notify the extension system without an import cycle. */
export const extensionsRef: { current: ElectronChromeExtensions | null } = { current: null }
