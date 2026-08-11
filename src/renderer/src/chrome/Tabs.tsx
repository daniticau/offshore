import React, { useEffect, useRef, useState } from 'react'
import type { BookmarkNode, DownloadEntry, SpaceInfo, Settings, TabInfo, TabsState } from '@shared/types'
import { offshore } from './api'
import type { DownloadToast, FindState } from './App'
import { BookmarkEditPopover, BookmarksBar, BookmarksSection } from './Bookmarks'
import { Omnibox } from './Omnibox'
import { SiteInfo } from './SiteInfo'
import { PopupChip } from './PasswordBanner'
import { SpaceSwitcher } from './SpaceSwitcher'
import {
  IconAlert,
  IconAudio,
  IconBack,
  IconBookmarkTray,
  IconClose,
  IconCode,
  IconDownload,
  IconFinder,
  IconForward,
  IconGear,
  IconMore,
  IconMuted,
  IconPlus,
  IconReload,
  IconShield,
  IconShieldFilled,
  IconSlop,
  IconSplit,
  IconStar,
  IconStarFilled,
  IconStop,
  IconWave
} from './icons'

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'browser-action-list': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        partition?: string
        tab?: string
        alignment?: string
      }
    }
  }
}

export interface ChromeProps {
  tabsState: TabsState
  settings: Settings
  activeTab?: TabInfo
  shieldOff: boolean
  find: FindState
  downloads: DownloadToast[]
  bookmarks: BookmarkNode[]
  renameSpaceId: string | null
  renameBookmarkId: string | null
  bookmarkEdit: BookmarkNode | null
  downloadsPanelOpen: boolean
  popupPanelOpen: boolean
  hasExtensions: boolean
  accentFor: (space: SpaceInfo) => string
  omniboxFocusNonce: number
  onOmniboxOverlay: (need: boolean) => void
  onNavigate: (input: string) => void
  onNewTab: () => void
  siteInfoOpen: boolean
  onToggleSiteInfo: (open: boolean) => void
  onFindQuery: (text: string, findNext: boolean, forward?: boolean) => void
  onCloseFind: () => void
  onToggleShield: () => void
  onEditBookmark: () => void
  onCloseBookmarkEdit: () => void
  onRenameSpaceDone: () => void
  onRenameBookmarkDone: () => void
  onToggleDownloadsPanel: (open: boolean) => void
  onTogglePopupPanel: (open: boolean) => void
}

// ---------------- shared bits ----------------

/** Internal pages carry their own marks; the wave stays the badge of a fresh tab.
 * A favicon that fails to load falls back to the glyph — never the broken-image box. */
export function TabGlyph({ tab, size = 13 }: { tab: TabInfo; size?: number }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [tab.favicon])
  const u = tab.displayUrl
  const glyph =
    u.startsWith('offshore://settings') ? (
      <IconGear size={size} />
    ) : tab.title === 'Problem loading page' ? (
      <IconAlert size={size} />
    ) : (
      <IconWave size={size} />
    )
  if (!tab.favicon || broken || u.startsWith('offshore://')) return glyph
  return <img src={tab.favicon} alt="" onError={() => setBroken(true)} />
}

function NavButtons({ activeTab }: { activeTab?: TabInfo }): React.JSX.Element {
  return (
    <div className="nav-buttons no-drag">
      <button
        className="chrome-btn"
        disabled={!activeTab?.canGoBack}
        onClick={() => void offshore.tabs.back()}
        title="Back (⌘[)"
      >
        <IconBack size={16} />
      </button>
      <button
        className="chrome-btn"
        disabled={!activeTab?.canGoForward}
        onClick={() => void offshore.tabs.forward()}
        title="Forward (⌘])"
      >
        <IconForward size={16} />
      </button>
      <button
        className="chrome-btn"
        onClick={() =>
          activeTab?.isLoading ? void offshore.tabs.stop() : void offshore.tabs.reload()
        }
        title={activeTab?.isLoading ? 'Stop' : 'Reload (⌘R)'}
      >
        {activeTab?.isLoading ? <IconStop size={14} /> : <IconReload size={13} />}
      </button>
    </div>
  )
}

function ShieldButton({
  activeTab,
  shieldOff,
  onToggleShield
}: Pick<ChromeProps, 'activeTab' | 'shieldOff' | 'onToggleShield'>): React.JSX.Element | null {
  if (!activeTab || !/^https?:/.test(activeTab.url)) return null
  if (activeTab.displayUrl.startsWith('offshore://')) return null
  const count = activeTab.blockedCount
  return (
    <button
      className={`chrome-btn shield ${shieldOff ? 'shield-off' : ''}`}
      onClick={onToggleShield}
      title={
        shieldOff
          ? 'Shield is off for this site — click to re-enable'
          : `Shield blocked ${count} request${count === 1 ? '' : 's'} — click to allow this site`
      }
    >
      {shieldOff ? <IconShield size={14} /> : <IconShieldFilled size={14} />}
      {!shieldOff && count > 0 && <span className="shield-count">{count > 99 ? '99+' : count}</span>}
    </button>
  )
}

function StarButton({
  activeTab,
  onEditBookmark
}: Pick<ChromeProps, 'activeTab' | 'onEditBookmark'>): React.JSX.Element | null {
  if (!activeTab || !/^https?:/.test(activeTab.url)) return null
  if (activeTab.displayUrl.startsWith('offshore://')) return null
  const starred = activeTab.isBookmarked
  return (
    <button
      className={`chrome-btn star ${starred ? 'starred' : ''}`}
      onClick={() => {
        if (starred) void offshore.bookmarks.toggle(activeTab.url, activeTab.title)
        else onEditBookmark()
      }}
      title={starred ? 'Remove bookmark' : 'Bookmark this page (⌘D)'}
    >
      {starred ? <IconStarFilled size={14} /> : <IconStar size={14} />}
    </button>
  )
}

function OmniboxWrap(props: ChromeProps & { compact?: boolean }): React.JSX.Element {
  const { activeTab } = props
  // The page chips ride inside the pill in both layouts: Arc-style in the
  // sidebar, and in the topbar because the star belongs to the address bar.
  const actions = (
    <>
      <SlopChip activeTab={activeTab} settings={props.settings} />
      {activeTab && (
        <PopupChip tab={activeTab} open={props.popupPanelOpen} onToggle={props.onTogglePopupPanel} />
      )}
      <ShieldButton {...props} />
      <StarButton {...props} />
    </>
  )
  return (
    <div className={`omnibox-wrap ${props.compact ? 'compact' : ''}`}>
      <Omnibox
        activeTab={activeTab}
        compact={props.compact}
        focusNonce={props.omniboxFocusNonce}
        onOverlayNeed={props.onOmniboxOverlay}
        onNavigate={props.onNavigate}
        onSiteInfo={() => props.onToggleSiteInfo(!props.siteInfoOpen)}
        actions={actions}
      />
      {props.siteInfoOpen && activeTab && (
        <SiteInfo
          tab={activeTab}
          settings={props.settings}
          shieldOff={props.shieldOff}
          onToggleShield={props.onToggleShield}
          onClose={() => props.onToggleSiteInfo(false)}
        />
      )}
    </div>
  )
}

function SlopChip({ activeTab, settings }: { activeTab?: TabInfo; settings: Settings }): React.JSX.Element | null {
  if (!settings.slopDetector || !activeTab?.slopScore || activeTab.slopScore < 25) return null
  return (
    <span
      className="chrome-btn slop-chip"
      title={`Reads like AI-generated filler (slop score ${activeTab.slopScore}/100).\nDetected locally with plain heuristics — no AI involved, nothing leaves your Mac.`}
    >
      <IconSlop size={14} />
    </span>
  )
}

function DownloadsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [items, setItems] = useState<DownloadEntry[]>([])
  useEffect(() => {
    void offshore.downloads.list().then((l) => setItems(l ?? []))
  }, [])
  const fmtSize = (n: number): string => {
    if (n <= 0) return ''
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }
  return (
    <div className="dl-panel surface-card no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="dl-panel-head">
        <span>Downloads</span>
        {items.length > 0 && (
          <button
            className="dl-clear"
            onClick={() => {
              void offshore.downloads.clear().then(() => setItems([]))
            }}
          >
            Clear
          </button>
        )}
        <button className="chrome-btn" onClick={onClose}>
          <IconClose size={12} />
        </button>
      </div>
      {items.length === 0 && <div className="dl-empty">Nothing downloaded yet.</div>}
      {items.map((d) => (
        <div
          key={d.id}
          className={`dl-item ${d.state}`}
          title={d.state === 'completed' ? 'Open' : d.state}
          onClick={() => {
            if (d.state === 'completed') void offshore.downloads.open(d.id)
          }}
        >
          <IconDownload size={13} />
          <span className="dl-item-name">{d.filename}</span>
          <span className="dl-item-meta">
            {d.state === 'completed'
              ? fmtSize(d.totalBytes || d.receivedBytes)
              : d.state === 'progressing'
                ? d.totalBytes > 0
                  ? `${Math.round((d.receivedBytes / d.totalBytes) * 100)}%`
                  : '…'
                : d.state}
          </span>
          {d.state === 'completed' && (
            <button
              className="dl-reveal"
              title="Show in Finder"
              onClick={(e) => {
                e.stopPropagation()
                void offshore.downloads.reveal(d.id)
              }}
            >
              <IconFinder size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function SplitButton({ tabsState }: { tabsState: TabsState }): React.JSX.Element {
  const on = tabsState.splitPair !== null
  return (
    <button
      className={`chrome-btn ${on ? 'active' : ''}`}
      title={on ? 'Exit split view' : 'Split view with the next tab'}
      onClick={() => void offshore.tabs.toggleSplit()}
    >
      <IconSplit size={14} />
    </button>
  )
}

/**
 * Chromium parks the profile beside the menu; in Offshore a profile is a space —
 * its accent, its name, and (when it has separate logins) its own cookie jar.
 * Clicking it opens that space's menu, which is where those settings already live.
 */
function ProfileButton({
  tabsState,
  accentFor
}: Pick<ChromeProps, 'tabsState' | 'accentFor'>): React.JSX.Element | null {
  const space = tabsState.spaces.find((s) => s.id === tabsState.activeSpaceId)
  if (!space) return null
  const separate = space.profile === 'separate'
  const name = space.name.trim()
  return (
    <button
      className={`profile-btn ${separate ? 'separate' : ''}`}
      style={{ '--space-color': accentFor(space) } as React.CSSProperties}
      title={`${name || 'Space'} — ${separate ? 'separate logins' : 'shared logins'}`}
      onClick={() => void offshore.menu.spaceContext(space.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        void offshore.menu.spaceContext(space.id)
      }}
    >
      {(name[0] ?? '•').toUpperCase()}
    </button>
  )
}

function FindBar({
  find,
  onFindQuery,
  onCloseFind,
  floating
}: Pick<ChromeProps, 'find' | 'onFindQuery' | 'onCloseFind'> & { floating?: boolean }): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (find.open) inputRef.current?.focus()
  }, [find.open])
  if (!find.open) return null
  return (
    <div className={`find-bar no-drag ${floating ? 'floating' : ''}`}>
      <input
        ref={inputRef}
        value={find.text}
        placeholder="Find in page…"
        onChange={(e) => onFindQuery(e.target.value, false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onFindQuery(find.text, true, !e.shiftKey)
          if (e.key === 'Escape') onCloseFind()
        }}
      />
      {find.text && (
        <span className="find-count">
          {find.matches ? `${find.activeMatch}/${find.matches}` : '0/0'}
        </span>
      )}
      <button className="chrome-btn" onClick={onCloseFind}>
        <IconClose size={12} />
      </button>
    </div>
  )
}

function Downloads({ downloads, compact }: { downloads: DownloadToast[]; compact?: boolean }): React.JSX.Element | null {
  if (!downloads.length) return null
  const items = compact ? downloads.slice(-1) : downloads
  return (
    <div className={`downloads no-drag ${compact ? 'compact' : ''}`}>
      {items.map((d) => {
        const pct = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : null
        const done = d.state === 'completed'
        return (
          <div
            key={d.id}
            className={`download-toast ${done ? 'done' : ''}`}
            title={done ? `${d.filename} — click to open` : d.filename}
            onClick={() => {
              if (done) void offshore.downloads.open(d.id)
            }}
          >
            <IconDownload size={12} />
            <span className="dl-name">{d.filename}</span>
            <span className="dl-state">
              {done ? 'Done' : d.state === 'progressing' ? (pct != null ? `${pct}%` : '…') : d.state}
            </span>
            {done && (
              <button
                className="dl-reveal"
                title="Show in Finder"
                onClick={(e) => {
                  e.stopPropagation()
                  void offshore.downloads.reveal(d.id)
                }}
              >
                <IconFinder size={12} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------- drag reorder (commit on drop) ----------------

function useDragReorder(ids: number[]): {
  dragId: number | null
  order: number[] | null
  onDragStart: (e: React.DragEvent, id: number) => void
  onDragOver: (e: React.DragEvent, id: number) => void
  onDrop: () => void
} {
  const [dragId, setDragId] = useState<number | null>(null)
  const [order, setOrder] = useState<number[] | null>(null)

  return {
    dragId,
    order,
    onDragStart: (e, id) => {
      setDragId(id)
      setOrder(ids)
      e.dataTransfer.setData('offshore/tab-id', String(id))
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e, overId) => {
      e.preventDefault()
      if (dragId == null || overId === dragId) return
      setOrder((prev) => {
        const cur = prev ?? ids
        const from = cur.indexOf(dragId)
        const to = cur.indexOf(overId)
        if (from === -1 || to === -1 || from === to) return cur
        const next = [...cur]
        next.splice(from, 1)
        next.splice(to, 0, dragId)
        return next
      })
    },
    onDrop: () => {
      if (order) void offshore.tabs.reorder(order)
      setDragId(null)
      setOrder(null)
    }
  }
}

// ---------------- tab items ----------------

/** Arc-quick tab motion: a genuinely new tab slides open, a closing one collapses
 * before the real close lands, so rows never blink in or out of existence.
 * Space switches must not replay the entrance — hence the id diff, not a mount flag. */
function useTabMotion(tabsState: TabsState): {
  entering: (id: number) => boolean
  closing: (id: number) => boolean
  closeAnimated: (id: number) => void
} {
  const [closingIds, setClosingIds] = useState<Set<number>>(new Set())
  const allIds = tabsState.tabs.map((t) => t.id)
  const prevAllIds = useRef<Set<number>>(new Set(allIds))
  const enteringIds = new Set(allIds.filter((id) => !prevAllIds.current.has(id)))
  useEffect(() => {
    prevAllIds.current = new Set(allIds)
  })

  return {
    entering: (id) => enteringIds.has(id),
    closing: (id) => closingIds.has(id),
    closeAnimated: (id) => {
      setClosingIds((prev) => new Set(prev).add(id))
      setTimeout(() => {
        void offshore.tabs.close(id)
        setClosingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, 110)
    }
  }
}

function TabItemVertical({
  tab,
  active,
  drag,
  motion
}: {
  tab: TabInfo
  active: boolean
  drag: ReturnType<typeof useDragReorder>
  motion: ReturnType<typeof useTabMotion>
}): React.JSX.Element {
  return (
    <div
      className={`tab-item ${active ? 'active' : ''} ${drag.dragId === tab.id ? 'dragging' : ''} ${
        motion.closing(tab.id) ? 'closing' : ''
      } ${motion.entering(tab.id) ? 'entering' : ''}`}
      draggable
      onDragStart={(e) => drag.onDragStart(e, tab.id)}
      onDragOver={(e) => drag.onDragOver(e, tab.id)}
      onDragEnd={drag.onDrop}
      onDrop={drag.onDrop}
      onClick={() => void offshore.tabs.activate(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) motion.closeAnimated(tab.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void offshore.menu.tabContext(tab.id)
      }}
      title={tab.title}
    >
      <span className="tab-favicon">
        <TabGlyph tab={tab} size={13} />
      </span>
      <span className="tab-title">{tab.isLoading && !tab.title ? 'Loading…' : tab.title}</span>
      {(tab.audible || tab.muted) && (
        <button
          className="tab-audio"
          onClick={(e) => {
            e.stopPropagation()
            void offshore.tabs.mute(tab.id, !tab.muted)
          }}
          title={tab.muted ? 'Unmute' : 'Mute'}
        >
          {tab.muted ? <IconMuted size={11} /> : <IconAudio size={11} />}
        </button>
      )}
      <button
        className="tab-close"
        onClick={(e) => {
          e.stopPropagation()
          motion.closeAnimated(tab.id)
        }}
        title="Close tab (⌘W)"
      >
        <IconClose size={11} />
      </button>
    </div>
  )
}

/** Space-scoped tab list with a direction-aware slide on space switch. */
function useSpacePane(tabsState: TabsState): { dir: number } {
  const prevIdxRef = useRef(0)
  const idx = Math.max(
    0,
    tabsState.spaces.findIndex((s) => s.id === tabsState.activeSpaceId)
  )
  const dir = Math.sign(idx - prevIdxRef.current) || 1
  prevIdxRef.current = idx
  return { dir }
}

function spaceTabsOf(tabsState: TabsState): TabInfo[] {
  return tabsState.tabs.filter((t) => t.spaceId === tabsState.activeSpaceId)
}

function orderedTabs(tabs: TabInfo[], order: number[] | null): TabInfo[] {
  if (!order) return tabs
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const out: TabInfo[] = []
  for (const id of order) {
    const t = byId.get(id)
    if (t) {
      out.push(t)
      byId.delete(id)
    }
  }
  out.push(...byId.values())
  return out
}

// ---------------- vertical sidebar ----------------

export function Sidebar(props: ChromeProps): React.JSX.Element {
  const { tabsState, activeTab, downloads, find } = props
  const spaceTabs = spaceTabsOf(tabsState)
  const drag = useDragReorder(spaceTabs.map((t) => t.id))
  const { dir } = useSpacePane(tabsState)
  const shown = orderedTabs(spaceTabs, drag.order)
  const motion = useTabMotion(tabsState)

  return (
    <div className="sidebar drag">
      {/* The traffic lights share the nav row — the strip left of the arrows is
          theirs, and stays draggable so the window still moves by its top edge. */}
      <div className="sidebar-toolbar">
        <div className="traffic-inline" />
        <div className="toolbar-spring" />
        <NavButtons activeTab={activeTab} />
        <button className="chrome-btn no-drag" title="More" onClick={() => void offshore.menu.appContext()}>
          <IconMore size={14} />
        </button>
      </div>
      <OmniboxWrap {...props} />
      <FindBar find={find} onFindQuery={props.onFindQuery} onCloseFind={props.onCloseFind} />
      {props.bookmarkEdit && (
        <div className="bm-edit-anchor">
          <BookmarkEditPopover
            node={props.bookmarkEdit}
            nodes={props.bookmarks}
            onClose={props.onCloseBookmarkEdit}
          />
        </div>
      )}
      {props.settings.bookmarksBar && (
        <BookmarksSection
          nodes={props.bookmarks}
          renameId={props.renameBookmarkId}
          onRenameDone={props.onRenameBookmarkDone}
        />
      )}
      <button className="new-tab-btn no-drag" onClick={props.onNewTab} title="New tab (⌘T)">
        <span className="tab-favicon">
          <IconPlus size={13} />
        </span>
        <span>New Tab</span>
      </button>
      <div
        className="tab-list no-drag space-pane"
        key={tabsState.activeSpaceId}
        style={{ '--dir': dir } as React.CSSProperties}
      >
        {shown.map((tab) => (
          <TabItemVertical
            key={tab.id}
            tab={tab}
            active={tab.id === tabsState.activeTabId}
            drag={drag}
            motion={motion}
          />
        ))}
      </div>
      <Downloads downloads={downloads} />
      <SpaceSwitcher
        spaces={tabsState.spaces}
        activeSpaceId={tabsState.activeSpaceId}
        renameId={props.renameSpaceId}
        onRenameDone={props.onRenameSpaceDone}
        accentFor={props.accentFor}
      />
      <div className="sidebar-footer no-drag">
        {props.hasExtensions && <browser-action-list partition="persist:offshore" />}
        <div className="toolbar-spring" />
        <div className="dl-anchor dl-anchor-up">
          <button
            className={`chrome-btn ${props.downloadsPanelOpen ? 'active' : ''}`}
            title="Downloads"
            onClick={() => props.onToggleDownloadsPanel(!props.downloadsPanelOpen)}
          >
            <IconDownload size={14} />
          </button>
          {props.downloadsPanelOpen && <DownloadsPanel onClose={() => props.onToggleDownloadsPanel(false)} />}
        </div>
        <SplitButton tabsState={tabsState} />
        <button
          className="chrome-btn"
          title="Settings (⌘,)"
          onClick={() => void offshore.tabs.create('offshore://settings')}
        >
          <IconGear size={14} />
        </button>
      </div>
    </div>
  )
}

// ---------------- horizontal top bar ----------------

export function TopBar(props: ChromeProps): React.JSX.Element {
  const { tabsState, activeTab, downloads, find } = props
  const spaceTabs = spaceTabsOf(tabsState)
  const drag = useDragReorder(spaceTabs.map((t) => t.id))
  const { dir } = useSpacePane(tabsState)
  const shown = orderedTabs(spaceTabs, drag.order)
  const motion = useTabMotion(tabsState)

  return (
    <div className="topbar drag">
      <div className="topbar-tabs-row">
        <div className="traffic-spacer-h" />
        <SpaceSwitcher
          spaces={tabsState.spaces}
          activeSpaceId={tabsState.activeSpaceId}
          renameId={props.renameSpaceId}
          onRenameDone={props.onRenameSpaceDone}
          accentFor={props.accentFor}
          compact
        />
        <div
          className="tab-strip no-drag space-pane"
          key={tabsState.activeSpaceId}
          style={{ '--dir': dir } as React.CSSProperties}
        >
          {shown.map((tab) => (
            <div
              key={tab.id}
              className={`htab ${tab.id === tabsState.activeTabId ? 'active' : ''} ${
                drag.dragId === tab.id ? 'dragging' : ''
              } ${motion.closing(tab.id) ? 'closing' : ''} ${motion.entering(tab.id) ? 'entering' : ''}`}
              draggable
              onDragStart={(e) => drag.onDragStart(e, tab.id)}
              onDragOver={(e) => drag.onDragOver(e, tab.id)}
              onDragEnd={drag.onDrop}
              onDrop={drag.onDrop}
              onClick={() => void offshore.tabs.activate(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) motion.closeAnimated(tab.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                void offshore.menu.tabContext(tab.id)
              }}
              title={tab.title}
            >
              <span className="tab-favicon">
                <TabGlyph tab={tab} size={12} />
              </span>
              <span className="tab-title">{tab.title || 'New Tab'}</span>
              {(tab.audible || tab.muted) && (
                <button
                  className="tab-audio"
                  onClick={(e) => {
                    e.stopPropagation()
                    void offshore.tabs.mute(tab.id, !tab.muted)
                  }}
                >
                  {tab.muted ? <IconMuted size={10} /> : <IconAudio size={10} />}
                </button>
              )}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  motion.closeAnimated(tab.id)
                }}
              >
                <IconClose size={10} />
              </button>
            </div>
          ))}
          <button className="htab-new" onClick={props.onNewTab} title="New tab (⌘T)">
            <IconPlus size={13} />
          </button>
        </div>
      </div>
      {/* Chromium's toolbar order, kept exactly: navigation on the left, the
          address bar (star and all) in the middle, then extensions, downloads,
          bookmarks, devtools, the profile, and the menu. */}
      <div className="topbar-toolbar-row no-drag">
        <div className="toolbar-cluster">
          <NavButtons activeTab={activeTab} />
          <SplitButton tabsState={tabsState} />
        </div>
        <OmniboxWrap {...props} compact />
        <div className="toolbar-cluster trailing">
          {props.hasExtensions && <browser-action-list partition="persist:offshore" />}
          <Downloads downloads={downloads} compact />
          <div className="dl-anchor">
            <button
              className={`chrome-btn ${props.downloadsPanelOpen ? 'active' : ''}`}
              title="Downloads"
              onClick={() => props.onToggleDownloadsPanel(!props.downloadsPanelOpen)}
            >
              <IconDownload size={14} />
            </button>
            {props.downloadsPanelOpen && <DownloadsPanel onClose={() => props.onToggleDownloadsPanel(false)} />}
          </div>
          <button
            className={`chrome-btn ${props.settings.bookmarksBar ? 'active' : ''}`}
            title={props.settings.bookmarksBar ? 'Hide bookmarks bar' : 'Show bookmarks bar'}
            onClick={() => void offshore.settings.set({ bookmarksBar: !props.settings.bookmarksBar })}
          >
            <IconBookmarkTray size={14} />
          </button>
          <button
            className="chrome-btn"
            title="Developer Tools (⌥⌘I)"
            onClick={() => void offshore.tabs.devtools()}
          >
            <IconCode size={14} />
          </button>
          <ProfileButton tabsState={tabsState} accentFor={props.accentFor} />
          <button className="chrome-btn" title="More" onClick={() => void offshore.menu.appContext()}>
            <IconMore size={14} />
          </button>
        </div>
        <FindBar find={find} onFindQuery={props.onFindQuery} onCloseFind={props.onCloseFind} floating />
      </div>
      {props.settings.bookmarksBar && props.bookmarks.length > 0 && (
        <BookmarksBar nodes={props.bookmarks} />
      )}
      {props.bookmarkEdit && (
        <div className="bm-edit-anchor-top">
          <BookmarkEditPopover
            node={props.bookmarkEdit}
            nodes={props.bookmarks}
            onClose={props.onCloseBookmarkEdit}
          />
        </div>
      )}
    </div>
  )
}
