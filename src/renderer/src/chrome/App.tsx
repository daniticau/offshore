import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  BookmarkNode,
  PasswordOffer,
  Settings,
  SpaceInfo,
  TabsState
} from '@shared/types'
import { DEFAULT_SETTINGS, accentColors, resolveAccentColors } from '@shared/types'
import { ClassicWaves } from '../theme/ClassicWaves'
import { DitheredWaves } from '../theme/DitheredWaves'
import { accentVars, useIsDark } from '../theme/useTheme'
import { offshore, prettyHost } from './api'
import { PasswordBanner } from './PasswordBanner'
import { playSound, setSoundsEnabled } from './sounds'
import { Sidebar, TopBar } from './Tabs'

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

/** The content view's backdrop card — and the single source of truth for insets. */
function ContentFrame({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const push = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        void offshore.chrome.setInsets({
          top: Math.round(r.top),
          left: Math.round(r.left),
          right: Math.round(window.innerWidth - r.right),
          bottom: Math.round(window.innerHeight - r.bottom)
        })
      })
    }
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    push()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', push)
      cancelAnimationFrame(raf)
    }
  }, [])
  return (
    <div ref={ref} className="content-frame">
      {children}
    </div>
  )
}

/**
 * The zero-tab home screen: what the window shows when every tab is closed.
 * Clock, date, waves, and one centered search bar — typing conjures the first
 * tab. The window itself only closes when the human closes it.
 */
function EmptyHome({ settings }: { settings: Settings }): React.JSX.Element {
  const [now, setNow] = useState(new Date())
  const [text, setText] = useState('')
  const [pillWidth, setPillWidth] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLSpanElement>(null)
  const isDark = useIsDark()

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000)
    inputRef.current?.focus()
    return () => clearInterval(t)
  }, [])

  // The pill grows with what you type instead of scrolling the text out of
  // sight — measured off a hidden mirror of the input, clamped to the pane.
  const measure = useCallback(() => {
    const mirror = mirrorRef.current
    const host = hostRef.current
    if (!mirror || !host) return
    const avail = host.clientWidth
    if (!avail) return
    const base = Math.min(600, avail * 0.68)
    const max = Math.max(base, Math.min(940, avail - 72))
    const chrome = 22 * 2 + 18 + 12 + 10 // padding + icon + gap + caret slack
    setPillWidth(Math.round(Math.min(max, Math.max(base, mirror.offsetWidth + chrome))))
  }, [])

  useLayoutEffect(measure, [measure, text])

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const widgets = settings.newTabWidgets ?? DEFAULT_SETTINGS.newTabWidgets
  const acc = resolveAccentColors(settings.appearance ?? DEFAULT_SETTINGS.appearance, isDark)
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

  const submit = (): void => {
    const q = text.trim()
    if (!q) return
    setText('')
    void offshore.tabs.create(q)
  }

  return (
    <div
      ref={hostRef}
      className="empty-home no-drag"
      style={{ background: `linear-gradient(180deg, ${acc.tintTop} 0%, ${acc.tintBottom} 100%)` }}
    >
      <div className="eh-center">
        <div className="eh-widgets">
          {widgets.clock && <div className="eh-clock">{time}</div>}
          {widgets.date && <div className="eh-date">{date}</div>}
        </div>
        <div className="eh-search" style={pillWidth ? { width: pillWidth } : undefined}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={text}
            placeholder="Search or type a URL"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <span className="eh-measure" ref={mirrorRef} aria-hidden="true">
            {text}
          </span>
        </div>
      </div>
      {settings.appearance?.waves !== false &&
        (settings.appearance?.waveStyle === 'classic' ? (
          <ClassicWaves colors={[acc.waveA, acc.waveB, acc.waveC]} height={170} />
        ) : (
          <DitheredWaves colors={[acc.waveA, acc.waveB, acc.waveC]} height={160} />
        ))}
    </div>
  )
}

export function App(): React.JSX.Element {
  const [tabsState, setTabsState] = useState<TabsState>({
    tabs: [],
    activeTabId: -1,
    spaces: [],
    activeSpaceId: '',
    splitPair: null
  })
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>([])
  const [omniboxNonce, setOmniboxNonce] = useState(0)
  const [omniboxOverlay, setOmniboxOverlay] = useState(false)
  const [find, setFind] = useState<FindState>({ open: false, text: '', activeMatch: 0, matches: 0 })
  const [downloads, setDownloads] = useState<DownloadToast[]>([])
  const [devshot, setDevshot] = useState<DevshotPayload | null>(null)
  const [renameSpaceId, setRenameSpaceId] = useState<string | null>(null)
  const [renameBookmarkId, setRenameBookmarkId] = useState<string | null>(null)
  const [bookmarkEdit, setBookmarkEdit] = useState<BookmarkNode | null>(null)
  const [downloadsPanelOpen, setDownloadsPanelOpen] = useState(false)
  const [hasExtensions, setHasExtensions] = useState(false)
  const [popupPanelOpen, setPopupPanelOpen] = useState(false)
  const [siteInfoOpen, setSiteInfoOpen] = useState(false)
  const [passwordOffer, setPasswordOffer] = useState<PasswordOffer | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [collapsing, setCollapsing] = useState(false)

  const pinnedRef = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevSpaceId = useRef('')
  const stateRef = useRef({ tabsState, bookmarks, settings })
  stateRef.current = { tabsState, bookmarks, settings }

  const isDark = useIsDark()
  const mode = settings.tabOrientation
  const density = settings.toolbarDensity
  const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeTabId)

  // ---- dynamic density: collapse / reveal choreography ----

  const collapse = useCallback(() => {
    setCollapsing(true)
    setTimeout(() => {
      setCollapsed(true)
      void offshore.chrome.setCollapsed(true)
    }, 190)
  }, [])

  const reveal = useCallback(() => {
    setCollapsed(false)
    void offshore.chrome.setCollapsed(false)
    requestAnimationFrame(() => requestAnimationFrame(() => setCollapsing(false)))
  }, [])

  const collapsedRef = useRef(false)
  collapsedRef.current = collapsed || collapsing

  const toggleCollapsed = useCallback(() => {
    if (collapsedRef.current) {
      pinnedRef.current = true
      reveal()
    } else {
      pinnedRef.current = false
      collapse()
    }
  }, [collapse, reveal])

  const cancelHideTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])

  // reset on layout/density switches
  useEffect(() => {
    pinnedRef.current = false
    cancelHideTimer()
    setCollapsed(false)
    setCollapsing(false)
    void offshore.chrome.setCollapsed(false)
  }, [mode, density, cancelHideTimer])

  // ---- subscriptions ----
  useEffect(() => {
    const un: Array<() => void> = []
    un.push(
      offshore.on('tabs:state', ((state: TabsState) => {
        if (prevSpaceId.current && state.activeSpaceId !== prevSpaceId.current) {
          playSound('space-switch')
        }
        prevSpaceId.current = state.activeSpaceId
        setTabsState(state)
      }) as never)
    )
    un.push(
      offshore.on('settings:changed', ((s: Settings) => {
        setSettings(s)
        setSoundsEnabled(s.uiSounds)
      }) as never)
    )
    un.push(
      offshore.on('bookmarks:changed', ((nodes: BookmarkNode[]) => {
        setBookmarks(nodes)
        setBookmarkEdit((prev) => (prev ? (nodes.find((n) => n.id === prev.id) ?? null) : null))
      }) as never)
    )
    un.push(
      offshore.on('omnibox:focus', (() => {
        setOmniboxNonce((n) => n + 1)
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
          const existing = prev.find((p) => p.id === d.id)
          if (d.state === 'completed' && existing?.state !== 'completed') {
            playSound('download-complete')
          }
          const next = prev.filter((p) => p.id !== d.id)
          next.push(d)
          return next.slice(-3)
        })
        if (d.state === 'completed' || d.state === 'cancelled') {
          setTimeout(() => {
            setDownloads((prev) => prev.filter((p) => p.id !== d.id))
          }, 6000)
        }
      }) as never)
    )
    un.push(
      offshore.on('spaces:begin-rename', ((id: string) => {
        setRenameSpaceId(id)
      }) as never)
    )
    un.push(
      offshore.on('bookmarks:begin-rename', ((id: string) => {
        setRenameBookmarkId(id)
      }) as never)
    )
    un.push(
      offshore.on('passwords:offer', ((offer: PasswordOffer) => {
        setPasswordOffer(offer)
      }) as never)
    )
    un.push(offshore.on('popups:blocked', (() => undefined) as never))
    un.push(
      offshore.on('devshot:composite', ((payload: DevshotPayload | null) => {
        setDevshot(payload)
      }) as never)
    )
    const onSpaceRename = (e: Event): void => {
      setRenameSpaceId((e as CustomEvent<string>).detail)
    }
    window.addEventListener('offshore:space-rename', onSpaceRename)
    void offshore.tabs.getState().then((s) => {
      if (s) {
        prevSpaceId.current = s.activeSpaceId
        setTabsState(s)
      }
    })
    void offshore.settings.get().then((s) => {
      if (s) {
        setSettings(s)
        setSoundsEnabled(s.uiSounds)
      }
    })
    void offshore.bookmarks.list().then((b) => b && setBookmarks(b))
    void offshore.extensions.has().then(setHasExtensions).catch(() => setHasExtensions(false))
    return () => {
      un.forEach((fn) => fn())
      window.removeEventListener('offshore:space-rename', onSpaceRename)
    }
  }, [])

  // ---- ⌘D / star: save + edit popover ----
  const editBookmark = useCallback(() => {
    void (async () => {
      const { tabsState: ts } = stateRef.current
      const tab = ts.tabs.find((t) => t.id === ts.activeTabId)
      if (!tab || !/^https?:/.test(tab.url)) return
      let list = await offshore.bookmarks.list()
      let node = list.find((n) => n.type === 'bookmark' && n.url === tab.url)
      if (!node) {
        await offshore.bookmarks.toggle(tab.url, tab.title, tab.favicon)
        playSound('bookmark-saved')
        list = await offshore.bookmarks.list()
        node = list.find((n) => n.type === 'bookmark' && n.url === tab.url)
      }
      if (node) {
        setBookmarks(list)
        setBookmarkEdit(node)
        reveal()
      }
    })()
  }, [reveal])

  useEffect(() => {
    const un1 = offshore.on('bookmarks:edit-current', (() => editBookmark()) as never)
    const un2 = offshore.on('chrome:toggle-collapse', (() => toggleCollapsed()) as never)
    return () => {
      un1()
      un2()
    }
  }, [editBookmark, toggleCollapsed])

  // reveal chrome for interactions that live in it
  useEffect(() => {
    if (find.open || renameSpaceId || renameBookmarkId || bookmarkEdit) {
      if (collapsedRef.current) reveal()
    }
  }, [find.open, renameSpaceId, renameBookmarkId, bookmarkEdit, reveal])

  // the site panel belongs to one page — leaving it closes the panel
  const prevActiveTabId = useRef(-1)
  useEffect(() => {
    if (prevActiveTabId.current !== tabsState.activeTabId) {
      prevActiveTabId.current = tabsState.activeTabId
      setSiteInfoOpen(false)
    }
  }, [tabsState.activeTabId])

  // omnibox focus (⌘T/⌘L) should also reveal a tucked-away chrome
  useEffect(() => {
    if (omniboxNonce > 0 && collapsedRef.current) reveal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [omniboxNonce])

  // ---- overlay (content hidden while a chrome surface must float over it) ----
  const overlayOpen =
    omniboxOverlay ||
    downloadsPanelOpen ||
    siteInfoOpen ||
    (mode === 'horizontal' && (bookmarkEdit !== null || popupPanelOpen))
  useEffect(() => {
    void offshore.chrome.setOverlay(overlayOpen)
  }, [overlayOpen])

  // escape closes panels
  useEffect(() => {
    if (!downloadsPanelOpen && !bookmarkEdit && !popupPanelOpen && !siteInfoOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setDownloadsPanelOpen(false)
        setBookmarkEdit(null)
        setPopupPanelOpen(false)
        setSiteInfoOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [downloadsPanelOpen, bookmarkEdit, popupPanelOpen, siteInfoOpen])

  // devshot composite render completion
  useEffect(() => {
    if (devshot) {
      const t = setTimeout(() => offshore.devshotDone(), 60)
      return () => clearTimeout(t)
    }
    return undefined
  }, [devshot])

  // ---- omnibox ----
  const onNavigate = useCallback((input: string) => {
    void offshore.tabs.navigate(null, input)
  }, [])

  const newTab = useCallback(() => {
    void offshore.tabs.create().then(() => {
      setOmniboxNonce((n) => n + 1)
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
    const { tabsState: ts } = stateRef.current
    const tab = ts.tabs.find((t) => t.id === ts.activeTabId)
    if (tab) void offshore.adblock.toggleSite(tab.url)
  }, [])

  const shieldOff = activeTab
    ? settings.adblock.allowlist.includes(prettyHost(activeTab.url))
    : false

  // ---- accent (space accent wins over the global one) ----
  const activeSpace = tabsState.spaces.find((s) => s.id === tabsState.activeSpaceId)
  const acc = activeSpace?.accent
    ? accentColors(activeSpace.accent, isDark)
    : resolveAccentColors(settings.appearance ?? DEFAULT_SETTINGS.appearance, isDark)
  const accentFor = useCallback(
    (space: SpaceInfo): string =>
      accentColors(space.accent ?? stateRef.current.settings.appearance.accent, isDark).accent,
    [isDark]
  )

  const onChromeDoubleClick = useCallback((e: React.MouseEvent) => {
    // macOS standard: double-click on the title bar area zooms the window
    if (!(e.target as HTMLElement).closest('.no-drag, input, button')) {
      void offshore.window.zoom()
    }
  }, [])

  // dynamic density: auto-hide when the pointer leaves the chrome
  const onChromeMouseLeave = useCallback(() => {
    if (density !== 'dynamic' || pinnedRef.current || collapsedRef.current) return
    const { tabsState: ts } = stateRef.current
    void ts
    cancelHideTimer()
    hideTimer.current = setTimeout(() => {
      const busy =
        stateRef.current.settings.toolbarDensity !== 'dynamic' ||
        pinnedRef.current ||
        overlayOpen ||
        find.open ||
        renameSpaceId !== null ||
        renameBookmarkId !== null ||
        bookmarkEdit !== null ||
        passwordOffer !== null
      if (!busy) collapse()
    }, 1000)
  }, [density, overlayOpen, find.open, renameSpaceId, renameBookmarkId, bookmarkEdit, passwordOffer, collapse, cancelHideTimer])

  const chromeProps = {
    tabsState,
    settings,
    activeTab,
    shieldOff,
    find,
    downloads,
    bookmarks,
    renameSpaceId,
    renameBookmarkId,
    bookmarkEdit,
    downloadsPanelOpen,
    popupPanelOpen,
    hasExtensions,
    accentFor,
    omniboxFocusNonce: omniboxNonce,
    onOmniboxOverlay: setOmniboxOverlay,
    onNavigate,
    onNewTab: newTab,
    onFindQuery: findQuery,
    onCloseFind: closeFind,
    onToggleShield: toggleShield,
    onEditBookmark: editBookmark,
    onCloseBookmarkEdit: () => setBookmarkEdit(null),
    onRenameSpaceDone: () => setRenameSpaceId(null),
    onRenameBookmarkDone: () => setRenameBookmarkId(null),
    onToggleDownloadsPanel: setDownloadsPanelOpen,
    onTogglePopupPanel: setPopupPanelOpen,
    siteInfoOpen,
    onToggleSiteInfo: setSiteInfoOpen
  }

  const classes = [
    'chrome',
    `mode-${mode}`,
    `density-${density}`,
    collapsed ? 'collapsed' : '',
    collapsing ? 'collapsing' : '',
    passwordOffer ? 'has-banner' : '',
    settings.bookmarksBar && bookmarks.length > 0 ? 'has-bmbar' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      onDoubleClick={onChromeDoubleClick}
      onMouseEnter={cancelHideTimer}
      onMouseLeave={onChromeMouseLeave}
      onMouseDown={(e) => {
        // click-away closes lightweight popovers
        const t = e.target as HTMLElement
        if (!t.closest('.bm-edit, .popup-list, .popup-chip')) {
          if (bookmarkEdit) setBookmarkEdit(null)
          if (popupPanelOpen) setPopupPanelOpen(false)
        }
        if (!t.closest('.dl-panel, .dl-anchor')) {
          if (downloadsPanelOpen) setDownloadsPanelOpen(false)
        }
        if (!t.closest('.site-info, .omni-tune')) {
          if (siteInfoOpen) setSiteInfoOpen(false)
        }
      }}
      style={accentVars(acc) as React.CSSProperties}
    >
      {mode === 'vertical' ? <Sidebar {...chromeProps} /> : <TopBar {...chromeProps} />}

      {/* Rounded backdrop + shadow behind the web content view; also the insets source */}
      <ContentFrame>
        {tabsState.tabs.filter((t) => t.spaceId === tabsState.activeSpaceId).length === 0 && (
          <EmptyHome settings={settings} />
        )}
      </ContentFrame>

      {passwordOffer && mode === 'horizontal' && (
        <div className="banner-row no-drag">
          <PasswordBanner offer={passwordOffer} onResolve={() => setPasswordOffer(null)} />
        </div>
      )}
      {passwordOffer && mode === 'vertical' && (
        <div className="banner-side no-drag">
          <PasswordBanner offer={passwordOffer} onResolve={() => setPasswordOffer(null)} />
        </div>
      )}

      {collapsed && mode === 'vertical' && (
        <div className="edge-zone edge-zone-left" onMouseEnter={reveal} />
      )}
      {collapsed && mode === 'horizontal' && (
        <div className="edge-zone edge-zone-top" onMouseEnter={reveal} />
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
