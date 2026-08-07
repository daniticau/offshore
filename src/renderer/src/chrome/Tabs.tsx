import React, { useEffect, useRef, useState } from 'react'
import type { Bookmark, Settings, TabInfo, TabsState } from '@shared/types'
import { offshore, prettyHost } from './api'
import type { DownloadToast, FindState } from './App'
import {
  IconAudio,
  IconBack,
  IconClose,
  IconDownload,
  IconForward,
  IconGear,
  IconMuted,
  IconPlus,
  IconReload,
  IconSearch,
  IconShield,
  IconShieldFilled,
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
  onOpenPalette: (seed: string) => void
  onNewTab: () => void
  onFindQuery: (text: string, findNext: boolean, forward?: boolean) => void
  onCloseFind: () => void
  onToggleShield: () => void
  onToggleBookmark: () => void
}

// ---------------- shared bits ----------------

function NavButtons({ activeTab }: { activeTab?: TabInfo }): React.JSX.Element {
  return (
    <div className="nav-buttons no-drag">
      <button
        className="chrome-btn"
        disabled={!activeTab?.canGoBack}
        onClick={() => void offshore.tabs.back()}
        title="Back (⌘[)"
      >
        <IconBack size={17} />
      </button>
      <button
        className="chrome-btn"
        disabled={!activeTab?.canGoForward}
        onClick={() => void offshore.tabs.forward()}
        title="Forward (⌘])"
      >
        <IconForward size={17} />
      </button>
      <button
        className="chrome-btn"
        onClick={() =>
          activeTab?.isLoading ? void offshore.tabs.stop() : void offshore.tabs.reload()
        }
        title={activeTab?.isLoading ? 'Stop' : 'Reload (⌘R)'}
      >
        {activeTab?.isLoading ? <IconStop size={15} /> : <IconReload size={14} />}
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
      {shieldOff ? <IconShield size={15} /> : <IconShieldFilled size={15} />}
      {!shieldOff && count > 0 && <span className="shield-count">{count > 99 ? '99+' : count}</span>}
    </button>
  )
}

function StarButton({
  activeTab,
  onToggleBookmark
}: Pick<ChromeProps, 'activeTab' | 'onToggleBookmark'>): React.JSX.Element | null {
  if (!activeTab || !/^https?:/.test(activeTab.url)) return null
  return (
    <button
      className={`chrome-btn star ${activeTab.isBookmarked ? 'starred' : ''}`}
      onClick={onToggleBookmark}
      title={activeTab.isBookmarked ? 'Remove bookmark' : 'Bookmark this page (⌘D)'}
    >
      {activeTab.isBookmarked ? <IconStarFilled size={15} /> : <IconStar size={15} />}
    </button>
  )
}

function OmniboxPill({
  activeTab,
  onOpenPalette,
  compact
}: {
  activeTab?: TabInfo
  onOpenPalette: (seed: string) => void
  compact?: boolean
}): React.JSX.Element {
  const label = activeTab ? prettyHost(activeTab.displayUrl || activeTab.url) : ''
  const isEmpty = !label || label === 'offshore://start'
  return (
    <button
      className={`omnibox-pill no-drag ${compact ? 'compact' : ''}`}
      onClick={() => onOpenPalette(activeTab && !isEmpty ? activeTab.displayUrl : '')}
      title="Search or enter address (⌘L)"
    >
      {isEmpty ? (
        <IconSearch size={14} />
      ) : (
        <>
          {activeTab?.favicon ? (
            <img className="pill-favicon" src={activeTab.favicon} alt="" />
          ) : (
            <IconWave size={14} />
          )}
          <span className="pill-host">{label}</span>
        </>
      )}
    </button>
  )
}

function FindBar({ find, onFindQuery, onCloseFind }: Pick<ChromeProps, 'find' | 'onFindQuery' | 'onCloseFind'>): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (find.open) inputRef.current?.focus()
  }, [find.open])
  if (!find.open) return null
  return (
    <div className="find-bar no-drag">
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
        <IconClose size={13} />
      </button>
    </div>
  )
}

function Downloads({ downloads }: { downloads: DownloadToast[] }): React.JSX.Element | null {
  if (!downloads.length) return null
  return (
    <div className="downloads no-drag">
      {downloads.map((d) => {
        const pct = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : null
        return (
          <div key={d.id} className="download-toast" title={d.filename}>
            <IconDownload size={13} />
            <span className="dl-name">{d.filename}</span>
            <span className="dl-state">
              {d.state === 'completed' ? 'Done' : d.state === 'progressing' ? (pct != null ? `${pct}%` : '…') : d.state}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function BookmarkStrip(): React.JSX.Element | null {
  const [bms, setBms] = useState<Bookmark[]>([])
  useEffect(() => {
    void offshore.bookmarks.list().then((b) => setBms(b as Bookmark[]))
    return offshore.on('bookmarks:changed', ((b: Bookmark[]) => setBms(b)) as never)
  }, [])
  if (!bms.length) return null
  return (
    <div className="bm-strip no-drag">
      {bms.slice(0, 8).map((b) => (
        <button
          key={b.id}
          className="bm-dot"
          title={`${b.title}\n${b.url}`}
          onClick={() => void offshore.tabs.create(b.url)}
        >
          {(prettyHost(b.url)[0] || '•').toUpperCase()}
        </button>
      ))}
    </div>
  )
}

// ---------------- tab items ----------------

function useDragReorder(tabs: TabInfo[]): {
  dragId: number | null
  onDragStart: (id: number) => void
  onDragOver: (e: React.DragEvent, id: number) => void
  onDrop: () => void
} {
  const [dragId, setDragId] = useState<number | null>(null)
  const orderRef = useRef<number[]>([])

  return {
    dragId,
    onDragStart: (id) => {
      setDragId(id)
      orderRef.current = tabs.map((t) => t.id)
    },
    onDragOver: (e, overId) => {
      e.preventDefault()
      if (dragId == null || overId === dragId) return
      const order = orderRef.current
      const from = order.indexOf(dragId)
      const to = order.indexOf(overId)
      if (from === -1 || to === -1) return
      order.splice(from, 1)
      order.splice(to, 0, dragId)
      void offshore.tabs.reorder([...order])
    },
    onDrop: () => setDragId(null)
  }
}

function TabItemVertical({
  tab,
  active,
  drag
}: {
  tab: TabInfo
  active: boolean
  drag: ReturnType<typeof useDragReorder>
}): React.JSX.Element {
  return (
    <div
      className={`tab-item ${active ? 'active' : ''} ${drag.dragId === tab.id ? 'dragging' : ''}`}
      draggable
      onDragStart={() => drag.onDragStart(tab.id)}
      onDragOver={(e) => drag.onDragOver(e, tab.id)}
      onDragEnd={drag.onDrop}
      onDrop={drag.onDrop}
      onClick={() => void offshore.tabs.activate(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) void offshore.tabs.close(tab.id)
      }}
      title={tab.title}
    >
      <span className="tab-favicon">
        {tab.favicon ? <img src={tab.favicon} alt="" /> : <IconWave size={14} />}
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
          {tab.muted ? <IconMuted size={12} /> : <IconAudio size={12} />}
        </button>
      )}
      <button
        className="tab-close"
        onClick={(e) => {
          e.stopPropagation()
          void offshore.tabs.close(tab.id)
        }}
        title="Close tab (⌘W)"
      >
        <IconClose size={12} />
      </button>
    </div>
  )
}

// ---------------- vertical sidebar ----------------

export function Sidebar(props: ChromeProps): React.JSX.Element {
  const { tabsState, activeTab, downloads, find } = props
  const drag = useDragReorder(tabsState.tabs)
  return (
    <div className="sidebar drag">
      <div className="traffic-spacer" />
      <div className="sidebar-toolbar no-drag">
        <NavButtons activeTab={activeTab} />
        <div className="toolbar-spring" />
        <ShieldButton {...props} />
        <StarButton {...props} />
      </div>
      <OmniboxPill activeTab={activeTab} onOpenPalette={props.onOpenPalette} />
      <FindBar find={find} onFindQuery={props.onFindQuery} onCloseFind={props.onCloseFind} />
      <BookmarkStrip />
      <button className="new-tab-btn no-drag" onClick={props.onNewTab} title="New tab (⌘T)">
        <IconPlus size={14} />
        <span>New Tab</span>
      </button>
      <div className="tab-list no-drag">
        {tabsState.tabs.map((tab) => (
          <TabItemVertical key={tab.id} tab={tab} active={tab.id === tabsState.activeTabId} drag={drag} />
        ))}
      </div>
      <Downloads downloads={downloads} />
      <div className="sidebar-footer no-drag">
        <browser-action-list partition="persist:offshore" />
        <div className="toolbar-spring" />
        <button
          className="chrome-btn"
          title="Settings (⌘,)"
          onClick={() => void offshore.tabs.create('offshore://settings')}
        >
          <IconGear size={15} />
        </button>
      </div>
    </div>
  )
}

// ---------------- horizontal top bar ----------------

export function TopBar(props: ChromeProps): React.JSX.Element {
  const { tabsState, activeTab, downloads, find } = props
  const drag = useDragReorder(tabsState.tabs)
  return (
    <div className="topbar drag">
      <div className="topbar-tabs-row">
        <div className="traffic-spacer-h" />
        <div className="tab-strip no-drag">
          {tabsState.tabs.map((tab) => (
            <div
              key={tab.id}
              className={`htab ${tab.id === tabsState.activeTabId ? 'active' : ''} ${
                drag.dragId === tab.id ? 'dragging' : ''
              }`}
              draggable
              onDragStart={() => drag.onDragStart(tab.id)}
              onDragOver={(e) => drag.onDragOver(e, tab.id)}
              onDragEnd={drag.onDrop}
              onDrop={drag.onDrop}
              onClick={() => void offshore.tabs.activate(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) void offshore.tabs.close(tab.id)
              }}
              title={tab.title}
            >
              <span className="tab-favicon">
                {tab.favicon ? <img src={tab.favicon} alt="" /> : <IconWave size={13} />}
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
                  {tab.muted ? <IconMuted size={11} /> : <IconAudio size={11} />}
                </button>
              )}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  void offshore.tabs.close(tab.id)
                }}
              >
                <IconClose size={11} />
              </button>
            </div>
          ))}
          <button className="htab-new" onClick={props.onNewTab} title="New tab (⌘T)">
            <IconPlus size={14} />
          </button>
        </div>
      </div>
      <div className="topbar-toolbar-row no-drag">
        <NavButtons activeTab={activeTab} />
        <OmniboxPill activeTab={activeTab} onOpenPalette={props.onOpenPalette} compact />
        <ShieldButton {...props} />
        <StarButton {...props} />
        <browser-action-list partition="persist:offshore" />
        <FindBar find={find} onFindQuery={props.onFindQuery} onCloseFind={props.onCloseFind} />
        <Downloads downloads={downloads} />
        <button
          className="chrome-btn"
          title="Settings (⌘,)"
          onClick={() => void offshore.tabs.create('offshore://settings')}
        >
          <IconGear size={15} />
        </button>
      </div>
    </div>
  )
}
