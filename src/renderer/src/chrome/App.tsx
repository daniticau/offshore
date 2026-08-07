import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Settings, Suggestion, TabsState } from '@shared/types'
import { ACCENTS, DEFAULT_SETTINGS } from '@shared/types'
import { offshore, prettyHost, type Insets } from './api'
import { Palette } from './Palette'
import { Sidebar, TopBar } from './Tabs'

export const SIDEBAR_WIDTH = 236
export const TOPBAR_HEIGHT = 82
const GUTTER = 10

interface DevshotPayload {
  dataUrl: string
  bounds: { x: number; y: number; width: number; height: number }
}

export interface DownloadToast {
  id: string
  filename: string
  state: string
  receivedBytes: number
  totalBytes: number
}

export interface FindState {
  open: boolean
  text: string
  activeMatch: number
  matches: number
}

export function App(): React.JSX.Element {
  const [tabsState, setTabsState] = useState<TabsState>({ tabs: [], activeTabId: -1 })
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteSeed, setPaletteSeed] = useState('')
  const [find, setFind] = useState<FindState>({ open: false, text: '', activeMatch: 0, matches: 0 })
  const [downloads, setDownloads] = useState<DownloadToast[]>([])
  const [devshot, setDevshot] = useState<DevshotPayload | null>(null)
  const devshotRef = useRef<DevshotPayload | null>(null)

  const mode = settings.tabOrientation
  const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeTabId)

  // ---- subscriptions ----
  useEffect(() => {
    const un: Array<() => void> = []
    un.push(
      offshore.on('tabs:state', ((state: TabsState) => setTabsState(state)) as never)
    )
    un.push(offshore.on('settings:changed', ((s: Settings) => setSettings(s)) as never))
    un.push(
      offshore.on('omnibox:focus', (() => {
        setPaletteSeed('')
        setPaletteOpen(true)
      }) as never)
    )
    un.push(
      offshore.on('find:open', (() => {
        setFind((f) => ({ ...f, open: true }))
      }) as never)
    )
    un.push(
      offshore.on('find:result', ((r: { activeMatch: number; matches: number }) => {
        setFind((f) => ({ ...f, activeMatch: r.activeMatch, matches: r.matches }))
      }) as never)
    )
    un.push(
      offshore.on('downloads:event', ((d: DownloadToast) => {
        setDownloads((prev) => {
          const next = prev.filter((p) => p.id !== d.id)
          next.push(d)
          return next.slice(-3)
        })
        if (d.state === 'completed' || d.state === 'cancelled') {
          setTimeout(() => {
            setDownloads((prev) => prev.filter((p) => p.id !== d.id))
          }, 4000)
        }
      }) as never)
    )
    un.push(
      offshore.on('devshot:composite', ((payload: DevshotPayload | null) => {
        devshotRef.current = payload
        setDevshot(payload)
      }) as never)
    )
    void offshore.tabs.getState().then((s) => s && setTabsState(s))
    void offshore.settings.get().then((s) => s && setSettings(s))
    return () => un.forEach((fn) => fn())
  }, [])

  // Signal devshot composite render completion
  useEffect(() => {
    if (devshot) {
      const t = setTimeout(() => offshore.devshotDone(), 60)
      return () => clearTimeout(t)
    }
    return undefined
  }, [devshot])

  // ---- insets ----
  useLayoutEffect(() => {
    const insets: Insets =
      mode === 'vertical'
        ? { top: GUTTER, left: SIDEBAR_WIDTH + GUTTER * 2 - 4, right: GUTTER, bottom: GUTTER }
        : { top: TOPBAR_HEIGHT + GUTTER, left: GUTTER, right: GUTTER, bottom: GUTTER }
    void offshore.chrome.setInsets(insets)
  }, [mode])

  // ---- palette ----
  useEffect(() => {
    void offshore.chrome.setOverlay(paletteOpen)
  }, [paletteOpen])

  const openPalette = useCallback((seed: string) => {
    setPaletteSeed(seed)
    setPaletteOpen(true)
  }, [])

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
  }, [])

  const onNavigate = useCallback(
    (input: string) => {
      setPaletteOpen(false)
      void offshore.tabs.navigate(null, input)
    },
    []
  )

  const newTab = useCallback(() => {
    void offshore.tabs.create().then(() => {
      setPaletteSeed('')
      setPaletteOpen(true)
    })
  }, [])

  // ---- find bar ----
  const findQuery = useCallback((text: string, findNext: boolean, forward = true) => {
    setFind((f) => ({ ...f, text }))
    if (text) void offshore.find.start(text, { findNext, forward })
    else void offshore.find.stop()
  }, [])

  const closeFind = useCallback(() => {
    setFind({ open: false, text: '', activeMatch: 0, matches: 0 })
    void offshore.find.stop()
  }, [])

  const toggleShield = useCallback(() => {
    if (activeTab) void offshore.adblock.toggleSite(activeTab.url)
  }, [activeTab])

  const toggleBookmark = useCallback(() => {
    if (activeTab) void offshore.bookmarks.toggle(activeTab.url, activeTab.title)
  }, [activeTab])

  const shieldOff = activeTab
    ? settings.adblock.allowlist.includes(prettyHost(activeTab.url))
    : false

  const chromeProps = {
    tabsState,
    settings,
    activeTab,
    shieldOff,
    find,
    downloads,
    onOpenPalette: openPalette,
    onNewTab: newTab,
    onFindQuery: findQuery,
    onCloseFind: closeFind,
    onToggleShield: toggleShield,
    onToggleBookmark: toggleBookmark
  }

  const acc = ACCENTS[settings.appearance?.accent ?? 'sea'] ?? ACCENTS.sea

  const onChromeDoubleClick = useCallback((e: React.MouseEvent) => {
    // macOS standard: double-click on the title bar area zooms the window
    if (!(e.target as HTMLElement).closest('.no-drag, .palette-backdrop, input, button')) {
      void offshore.window.zoom()
    }
  }, [])

  return (
    <div
      className={`chrome mode-${mode}`}
      onDoubleClick={onChromeDoubleClick}
      style={
        {
          '--sea': acc.sea,
          '--sea-deep': acc.seaDeep,
          '--tint-top': acc.tintTop,
          '--tint-bottom': acc.tintBottom
        } as React.CSSProperties
      }
    >
      {mode === 'vertical' ? <Sidebar {...chromeProps} /> : <TopBar {...chromeProps} />}

      {/* Rounded backdrop + shadow behind the web content view */}
      <div
        className="content-frame"
        style={
          mode === 'vertical'
            ? {
                top: GUTTER,
                left: SIDEBAR_WIDTH + GUTTER * 2 - 4,
                right: GUTTER,
                bottom: GUTTER
              }
            : { top: TOPBAR_HEIGHT + GUTTER, left: GUTTER, right: GUTTER, bottom: GUTTER }
        }
      />

      {paletteOpen && (
        <Palette
          seed={paletteSeed}
          onClose={closePalette}
          onNavigate={onNavigate}
          suggest={(q: string): Promise<Suggestion[]> => offshore.omnibox.suggest(q)}
        />
      )}

      {devshot && (
        <img
          className="devshot-overlay"
          src={devshot.dataUrl}
          style={{
            left: devshot.bounds.x,
            top: devshot.bounds.y,
            width: devshot.bounds.width,
            height: devshot.bounds.height
          }}
          alt=""
        />
      )}
    </div>
  )
}
