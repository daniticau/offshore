import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  BookmarkNode,
  PageFreezeFrame,
  PasswordOffer,
  Rect,
  Settings,
  SpaceInfo,
  TabsState
} from '@shared/types'
import { DEFAULT_SETTINGS, accentColors, resolveAccentColors } from '@shared/types'
import { HomeCanvas } from '../start/HomeCanvas'
import { accentVars, useIsDark } from '../theme/useTheme'
import { offshore, prettyHost } from './api'
import { PasswordDialog } from './PasswordDialog'
import { playSound, setSoundsEnabled } from './sounds'
import { DevToolsHeader, Sidebar, TopBar } from './Tabs'

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

/**
 * Stand-ins for the page views while a panel needs the room they occupy.
 *
 * The chrome draws under the page views, so a panel that overhangs the content
 * can only be seen once the view is hidden. Main sends a picture of what was
 * there; we paint it in the same place and tell main the moment it is really up,
 * so the live view only steps aside behind something identical to itself. Main
 * drops the pictures again only after the view is back, so neither end of the
 * swap has a frame with nothing in it.
 *
 * A frame with no picture is the home screen, which the chrome can simply draw:
 * same widgets, same settings, same water off the same clock. That is not an
 * optimisation, it is the point — a photograph of the sea is a sea that has
 * stopped, and the waves have no business freezing because you started typing.
 */
function PageFreeze({
  frames,
  settings,
  onPatch
}: {
  frames: PageFreezeFrame[]
  settings: Settings
  onPatch(patch: Partial<Settings>): void
}): React.JSX.Element | null {
  const [loaded, setLoaded] = useState(0)
  const stills = frames.filter((f) => f.dataUrl !== null).length
  useEffect(() => setLoaded(0), [frames])
  useEffect(() => {
    if (!frames.length || loaded < stills) return
    /*
     * Three frames: one to lay things out, one for the home screen to measure
     * its board and place its widgets, one to be sure all of it has been
     * painted. The photographs need only the first two; the third costs nothing
     * anyone can see and is the difference between a stand-in that is ready and
     * one that is a blank gradient for a beat.
     */
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => offshore.chrome.freezeAck())
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [frames, loaded, stills])
  if (!frames.length) return null
  return (
    <>
      {frames.map((f) => {
        const box = {
          left: f.bounds.x,
          top: f.bounds.y,
          width: f.bounds.width,
          height: f.bounds.height
        }
        return f.dataUrl === null ? (
          <div key={f.tabId} className="page-freeze page-freeze-home" style={box}>
            <ChromeHome settings={settings} onPatch={onPatch} standIn />
          </div>
        ) : (
          <img
            key={f.tabId}
            className="page-freeze"
            src={f.dataUrl}
            alt=""
            style={box}
            onLoad={() => setLoaded((n) => n + 1)}
            onError={() => setLoaded((n) => n + 1)}
          />
        )
      })}
    </>
  )
}

/** The content view's backdrop card — and the single source of truth for insets. */
function ContentFrame({
  children,
  onRect
}: {
  children?: React.ReactNode
  /** The card in window coordinates, for anything the chrome draws over it. */
  onRect?: (rect: Rect) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const rectRef = useRef(onRect)
  rectRef.current = onRect
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
        rectRef.current?.({
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
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
 * The home screen, drawn by the chrome. It shows up in two situations, and it is
 * the same screen in both — same component, same widgets, same settings — so
 * editing the widgets on any of them edits all of them.
 *
 * **Every tab closed.** The window has nothing to show, so it shows this. There
 * is no search in front of it: nothing is open, so there is nothing to search
 * from, and the address bar is right there when you want to go somewhere.
 *
 * **Standing in for a new tab.** A panel that overhangs the page needs the room
 * the page view is sitting in, and the chrome paints under those views, so the
 * view has to step aside — normally behind a photograph of itself, taken the
 * instant before. A photograph of the home screen is a photograph of the sea
 * holding still, which is what you used to get the moment you touched the
 * address bar on a new tab. There is no need for one: the chrome can draw that
 * page itself, live, waves and all. So it does, and the water keeps moving while
 * you type. It is a stand-in, though, not a page — it takes no clicks.
 */
function ChromeHome({
  settings,
  onPatch,
  editSignal = 0,
  standIn
}: {
  settings: Settings
  onPatch(patch: Partial<Settings>): void
  editSignal?: number
  standIn?: boolean
}): React.JSX.Element {
  return (
    <HomeCanvas
      className={standIn ? 'stand-in' : 'no-drag'}
      settings={settings}
      onPatch={onPatch}
      onSubmit={(input) => void offshore.tabs.create(input)}
      fetchWeather={() => offshore.brief.weather()}
      searchPill={false}
      editSignal={standIn ? 0 : editSignal}
      onContextMenu={standIn ? undefined : () => void offshore.menu.homeContext()}
    />
  )
}

export function App(): React.JSX.Element {
  const [tabsState, setTabsState] = useState<TabsState>({
    tabs: [],
    activeTabId: -1,
    spaces: [],
    activeSpaceId: '',
    splitPair: null,
    contentFullscreen: false,
    devtools: null
  })
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>([])
  const [omniboxNonce, setOmniboxNonce] = useState(0)
  const [homeEditSignal, setHomeEditSignal] = useState(0)
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
  const [appMenuOpen, setAppMenuOpen] = useState(false)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [freeze, setFreeze] = useState<PageFreezeFrame[]>([])
  /** The page card in window coordinates — what the chrome draws over it needs it. */
  const [contentRect, setContentRect] = useState<Rect | null>(null)
  const [passwordOffer, setPasswordOffer] = useState<PasswordOffer | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [collapsing, setCollapsing] = useState(false)
  /** ⌘S hide mode: the pointer is at the edge asking for the chrome back. */
  const [peekHover, setPeekHover] = useState(false)
  /** The address bar has the cursor — a peek must not slip away underneath it. */
  const [omniboxEditing, setOmniboxEditing] = useState(false)

  const pinnedRef = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevSpaceId = useRef('')
  const stateRef = useRef({ tabsState, bookmarks, settings })
  stateRef.current = { tabsState, bookmarks, settings }

  const isDark = useIsDark()
  const mode = settings.tabOrientation
  const density = settings.toolbarDensity
  const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeTabId)

  /** Optimistic settings write — main echoes it back over settings:changed. */
  const patchSettings = useCallback((p: Partial<Settings>) => {
    setSettings((prev) => ({
      ...prev,
      ...p,
      newTabWidgets: { ...prev.newTabWidgets, ...(p.newTabWidgets ?? {}) },
      newTabWidgetLayout: { ...prev.newTabWidgetLayout, ...(p.newTabWidgetLayout ?? {}) }
    }))
    void offshore.settings.set(p)
  }, [])

  // ---- dynamic density: collapse / reveal choreography ----

  const collapse = useCallback(() => {
    setCollapsing(true)
    setTimeout(() => setCollapsed(true), 190)
  }, [])

  const reveal = useCallback(() => {
    setCollapsed(false)
    requestAnimationFrame(() => requestAnimationFrame(() => setCollapsing(false)))
  }, [])

  const collapsedRef = useRef(false)
  collapsedRef.current = collapsed || collapsing

  const cancelHideTimer = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])

  // ---- ⌘S: the chrome is away until you ask for it ----

  /*
   * Hidden is a mode, not a moment: it survives the window, the layout and the
   * relaunch, because "hide the sidebar" means hide it, not hide it until
   * something happens. What comes back at the edge is a peek — the chrome slides
   * in *over* the page, and the page's own size never changes, so nothing on
   * screen reflows on the way in or out. That is the whole trick: the content
   * card is resized once, when you press ⌘S, and not again until you press it.
   */
  const hidden = settings.chromeHidden
  const contentFullscreen = tabsState.contentFullscreen
  // things living in the chrome that must not vanish mid-use
  const peekPinned =
    omniboxEditing ||
    find.open ||
    renameSpaceId !== null ||
    renameBookmarkId !== null ||
    bookmarkEdit !== null ||
    downloadsPanelOpen ||
    popupPanelOpen ||
    siteInfoOpen ||
    appMenuOpen ||
    profileMenuOpen
  const peeking = hidden && !contentFullscreen && (peekHover || peekPinned)

  const toggleHidden = useCallback(() => {
    const next = !stateRef.current.settings.chromeHidden
    patchSettings({ chromeHidden: next })
    /*
     * ⌘S means gone, so nothing gets to hold the chrome open against it. A peek
     * is pinned while something in the bar is mid-use — the address bar with the
     * cursor in it, most often — and pressing ⌘S right then used to leave the bar
     * sitting there, pinned by its own omnibox. Hiding hands the page the cursor
     * back, which is what releases the pin.
     */
    setPeekHover(false)
    if (next) {
      setOmniboxEditing(false)
      void offshore.chrome.focusPage()
    }
    // dynamic density's own tuck-away has nothing left to hide
    cancelHideTimer()
    pinnedRef.current = false
    setCollapsed(false)
    setCollapsing(false)
  }, [patchSettings, cancelHideTimer])

  /*
   * A beat before the peek. Sweeping the pointer past the window's left edge on
   * the way somewhere else is not a request for the sidebar, and a bar that
   * appears every time you cross a pixel column is worse than no bar at all.
   */
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armPeek = useCallback(() => {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => setPeekHover(true), 110)
  }, [])
  const cancelPeek = useCallback(() => {
    if (peekTimer.current) {
      clearTimeout(peekTimer.current)
      peekTimer.current = null
    }
  }, [])
  useEffect(() => () => cancelPeek(), [cancelPeek])

  /** The traffic lights belong to whatever bar is on screen — and go with it. */
  useEffect(() => {
    void offshore.chrome.setCollapsed((hidden && !peeking) || collapsed || contentFullscreen)
  }, [hidden, peeking, collapsed, contentFullscreen])

  // reset on layout/density switches
  useEffect(() => {
    pinnedRef.current = false
    cancelHideTimer()
    setCollapsed(false)
    setCollapsing(false)
  }, [mode, density, cancelHideTimer])

  /*
   * One search at a time. Reaching for the address bar on a new tab is not a
   * request for two of them, so the home screen's own panel steps aside — the
   * same thing clicking past it does, because it is the same thing.
   */
  useEffect(() => {
    if (!omniboxEditing) return
    const { tabsState: ts } = stateRef.current
    const active = ts.tabs.find((t) => t.id === ts.activeTabId)
    if (active?.homeSearch) void offshore.home.setSearch(false, active.id)
  }, [omniboxEditing])

  // a page going full screen takes the pointer with it; no peek survives that
  useEffect(() => {
    if (contentFullscreen) setPeekHover(false)
  }, [contentFullscreen])

  // ---- subscriptions ----
  useEffect(() => {
    const un: Array<() => void> = []
    un.push(offshore.on('widgets:edit', (() => setHomeEditSignal((n) => n + 1)) as never))
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
    un.push(
      offshore.on('chrome:page-freeze', ((frames: PageFreezeFrame[] | null) => {
        setFreeze(frames ?? [])
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
    const un2 = offshore.on('chrome:toggle-hidden', (() => toggleHidden()) as never)
    return () => {
      un1()
      un2()
    }
  }, [editBookmark, toggleHidden])

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

  // Closing the last tab lands on the home screen, which carries no pill of its
  // own — so the omnibox takes the cursor, in either layout.
  // starts true so a launch that restores tabs never yanks focus to the omnibox
  const wasEmpty = useRef(true)
  const spaceIsEmpty = tabsState.tabs.every((t) => t.spaceId !== tabsState.activeSpaceId)
  useEffect(() => {
    if (spaceIsEmpty && !wasEmpty.current) setOmniboxNonce((n) => n + 1)
    wasEmpty.current = spaceIsEmpty
  }, [spaceIsEmpty])

  // ---- overlay (content hidden while a chrome surface must float over it) ----
  const overlayOpen =
    omniboxOverlay ||
    downloadsPanelOpen ||
    siteInfoOpen ||
    appMenuOpen ||
    profileMenuOpen ||
    passwordOffer !== null ||
    // a peeking bar hangs over the page like any other panel, so it comes in the
    // same way: the page's picture takes its place and nothing appears to move
    peeking ||
    (mode === 'horizontal' && (bookmarkEdit !== null || popupPanelOpen))
  useEffect(() => {
    void offshore.chrome.setOverlay(overlayOpen)
  }, [overlayOpen])

  // escape closes panels
  useEffect(() => {
    if (
      !downloadsPanelOpen &&
      !bookmarkEdit &&
      !popupPanelOpen &&
      !siteInfoOpen &&
      !appMenuOpen &&
      !profileMenuOpen
    ) {
      return
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setDownloadsPanelOpen(false)
        setBookmarkEdit(null)
        setPopupPanelOpen(false)
        setSiteInfoOpen(false)
        setAppMenuOpen(false)
        setProfileMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [downloadsPanelOpen, bookmarkEdit, popupPanelOpen, siteInfoOpen, appMenuOpen, profileMenuOpen])

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

  /**
   * A new tab. Main decides where the cursor lands afterwards, because that is
   * a question about the layout: the page's own pill in vertical, the address
   * bar above the page in horizontal.
   *
   * Vertical has one wrinkle. Its new tabs have no row of their own — the New
   * Tab button in the sidebar *is* that tab while its search is up — so pressing
   * it again on a blank tab whose search you put away is a request for the
   * search back, not for a second empty tab nobody can see.
   *
   * Horizontal has no such thing. Every tab is a tab in the strip and + means
   * one more, every single time, the way it does in Chrome.
   */
  const newTab = useCallback(() => {
    const { tabsState: ts, settings: st } = stateRef.current
    if (st.tabOrientation !== 'horizontal') {
      const active = ts.tabs.find((t) => t.id === ts.activeTabId)
      const blank =
        active &&
        active.spaceId === ts.activeSpaceId &&
        active.displayUrl.startsWith('offshore://start') &&
        !active.canGoBack &&
        !active.canGoForward
      if (blank && !active.homeSearch) {
        void offshore.home.setSearch(true, active.id)
        return
      }
    }
    void offshore.tabs.create()
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
    const t = e.target as HTMLElement
    if (t.closest('.no-drag, input, button')) return
    /*
     * A drag region already zooms on double-click — macOS does that itself for
     * anything you can drag a window by. Zooming here as well meant the gesture
     * sometimes zoomed and un-zoomed in one go, which is why double-clicking the
     * chrome only worked every other time.
     */
    if (t.closest('.drag')) return
    void offshore.window.zoom()
  }, [])

  // dynamic density: auto-hide when the pointer leaves the chrome. With the
  // chrome hidden outright there is nothing left for it to tuck away.
  const onChromeMouseLeave = useCallback(() => {
    if (density !== 'dynamic' || hidden || pinnedRef.current || collapsedRef.current) return
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
  }, [density, hidden, overlayOpen, find.open, renameSpaceId, renameBookmarkId, bookmarkEdit, passwordOffer, collapse, cancelHideTimer])

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
    onOmniboxEditing: setOmniboxEditing,
    // a peek lasts as long as the pointer is in the bar it summoned
    onPeekLeave: peeking ? () => setPeekHover(false) : undefined,
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
    onToggleSiteInfo: setSiteInfoOpen,
    appMenuOpen,
    onToggleAppMenu: setAppMenuOpen,
    profileMenuOpen,
    onToggleProfileMenu: setProfileMenuOpen,
    onPatchSettings: patchSettings
  }

  const edgeZone = contentFullscreen ? false : hidden ? !peeking : collapsed

  const classes = [
    'chrome',
    `mode-${mode}`,
    `density-${density}`,
    collapsed ? 'collapsed' : '',
    collapsing ? 'collapsing' : '',
    hidden ? 'chrome-hidden' : '',
    peeking ? 'peeking' : '',
    contentFullscreen ? 'content-fullscreen' : '',
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
        if (!t.closest('.cr-menu, .app-menu-anchor')) {
          if (appMenuOpen) setAppMenuOpen(false)
        }
        if (!t.closest('.profile-menu, .profile-anchor')) {
          if (profileMenuOpen) setProfileMenuOpen(false)
        }
      }}
      style={accentVars(acc) as React.CSSProperties}
    >
      {/* The air around the page card, as something you can take hold of: drag
          the window by any side of it, double-click it to zoom. First in the
          tree so every bar and panel sits above it. */}
      {!contentFullscreen && (
        <div className="drag-frame" aria-hidden="true">
          <i className="df-top drag" />
          <i className="df-right drag" />
          <i className="df-bottom drag" />
          <i className="df-left drag" />
        </div>
      )}

      {mode === 'vertical' ? <Sidebar {...chromeProps} /> : <TopBar {...chromeProps} />}

      {/* Rounded backdrop + shadow behind the web content view; also the insets source */}
      <ContentFrame onRect={setContentRect}>
        {spaceIsEmpty && (
          <ChromeHome settings={settings} onPatch={patchSettings} editSignal={homeEditSignal} />
        )}
      </ContentFrame>

      {/* stands in for the page views while a panel needs their space */}
      <PageFreeze frames={freeze} settings={settings} onPatch={patchSettings} />

      {/* the docked DevTools panel's own title bar, ✕ and all */}
      <DevToolsHeader
        tabsState={tabsState}
        contentRect={contentRect}
        overlayOpen={overlayOpen}
      />

      {/* one dialog, in the middle, in both layouts */}
      {passwordOffer && (
        <PasswordDialog offer={passwordOffer} onResolve={() => setPasswordOffer(null)} />
      )}

      {/*
        The strip of window the page view doesn't cover — the only place the
        chrome can still feel the pointer. It is gone while the bar is actually
        peeking (the bar is there to be clicked instead), and gone in full
        screen, where the page has the whole window and nothing of ours may
        slide in over it.
      */}
      {edgeZone && (
        <div
          className={`edge-zone edge-zone-${mode === 'vertical' ? 'left' : 'top'} no-drag`}
          onMouseEnter={hidden ? armPeek : reveal}
          onMouseLeave={hidden ? cancelPeek : undefined}
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
