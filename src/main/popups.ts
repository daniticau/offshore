import type { BrowserWindow, WebContents } from 'electron'
import type { BlockedPopup } from '@shared/types'
import { settingsStore } from './stores'
import { prettyHost } from './util'
import type { OffshoreWindow } from './windows'

/**
 * Gesture-tracking popup blocker.
 *
 * Tab preloads ping 'gesture:activity' on pointerdown/keydown; a popup is only
 * allowed when the opener saw a gesture within the last GESTURE_WINDOW ms (one
 * popup consumes the stamp) or its site is on the popup allowlist. Everything
 * else is denied and surfaced as a per-tab "popup blocked" chip in the chrome.
 */

const GESTURE_WINDOW = 2000
const MAX_BLOCKED_PER_TAB = 10

interface PageEntry {
  kind: 'tab' | 'popup'
  ownerWindow: OffshoreWindow
  partition: string
}

/** Every webContents allowed to talk on tab-callable channels (tabs + tracked popups). */
const pageRegistry = new Map<number, PageEntry>()
const lastGestureAt = new Map<number, number>()
const blockedByTab = new Map<number, BlockedPopup[]>()

export function registerPageContents(wc: WebContents, entry: PageEntry): void {
  pageRegistry.set(wc.id, entry)
  wc.once('destroyed', () => {
    pageRegistry.delete(wc.id)
    lastGestureAt.delete(wc.id)
    blockedByTab.delete(wc.id)
  })
}

export function pageEntry(wcId: number): PageEntry | undefined {
  return pageRegistry.get(wcId)
}

export function noteGesture(wcId: number): void {
  if (pageRegistry.has(wcId)) lastGestureAt.set(wcId, Date.now())
}

export function popupDecision(openerWc: WebContents, url: string): 'allow' | 'block' {
  if (url.startsWith('javascript:')) return 'block'
  const s = settingsStore.get()
  const host = prettyHost(openerWc.getURL())
  if (s.popups.allowlist.includes(host)) return 'allow'
  if (!s.popups.block) return 'allow'
  const at = lastGestureAt.get(openerWc.id) ?? 0
  if (Date.now() - at <= GESTURE_WINDOW) {
    lastGestureAt.delete(openerWc.id) // one popup per gesture
    return 'allow'
  }
  return 'block'
}

export function recordBlocked(openerWc: WebContents, url: string): void {
  const list = blockedByTab.get(openerWc.id) ?? []
  list.push({ url, ts: Date.now() })
  if (list.length > MAX_BLOCKED_PER_TAB) list.shift()
  blockedByTab.set(openerWc.id, list)
  // The chrome's "popup blocked" chip reads blockedPopups off the tab state
  pageRegistry.get(openerWc.id)?.ownerWindow.tabs.pushState()
}

export function blockedPopups(tabId: number): BlockedPopup[] {
  return blockedByTab.get(tabId) ?? []
}

export function blockedPopupCount(tabId: number): number {
  return blockedByTab.get(tabId)?.length ?? 0
}

export function clearBlocked(tabId: number): void {
  blockedByTab.delete(tabId)
}

/** Owning Offshore window for a popup's BrowserWindow, if tracked. */
export function popupOwner(bw: BrowserWindow): OffshoreWindow | undefined {
  try {
    return pageRegistry.get(bw.webContents.id)?.ownerWindow
  } catch {
    return undefined
  }
}

export function allowPopupsForSite(host: string): void {
  const s = settingsStore.get()
  if (!s.popups.allowlist.includes(host)) {
    settingsStore.set({ popups: { ...s.popups, allowlist: [...s.popups.allowlist, host] } })
  }
}
