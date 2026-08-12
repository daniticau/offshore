import React from 'react'
import type { DevToolsDock, Settings, SpaceInfo, TabsState } from '@shared/types'
import { ACCENTS, type AccentId } from '@shared/types'
import { offshore } from './api'
import { IconCheck, IconPlus, IconTrash } from './icons'

/**
 * Chromium's menus, not the system's.
 *
 * These used to be `Menu.popup()` — a real NSMenu, which on this Mac means
 * Apple's rounded translucent panel with Apple's metrics, in the middle of a
 * browser that looks nothing like that. Chromium draws its own kebab menu on
 * every platform for exactly this reason, so we do too: our type, our spacing,
 * our accent. The page still behind them comes from PageFreeze.
 */

function MenuRow({
  label,
  hint,
  checked,
  danger,
  onClick
}: {
  label: string
  hint?: string
  checked?: boolean
  danger?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button className={`cr-item ${danger ? 'danger' : ''}`} onClick={onClick}>
      <span className="cr-check">{checked && <IconCheck size={13} />}</span>
      <span className="cr-label">{label}</span>
      {hint && <span className="cr-hint">{hint}</span>}
    </button>
  )
}

function MenuSep(): React.JSX.Element {
  return <div className="cr-sep" />
}

export function AppMenu({
  tabsState,
  settings,
  onClose,
  onPatchSettings
}: {
  tabsState: TabsState
  settings: Settings
  onClose: () => void
  onPatchSettings: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const run = (fn: () => void): (() => void) => () => {
    fn()
    onClose()
  }
  const split = tabsState.splitPair !== null
  const dt = tabsState.devtools

  return (
    <div className="cr-menu surface-card no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <MenuRow label="New Tab" hint="⌘T" onClick={run(() => void offshore.actions.run('new-tab'))} />
      <MenuRow
        label="New Window"
        hint="⌘N"
        onClick={run(() => void offshore.actions.run('new-window'))}
      />
      <MenuRow
        label="New Space"
        hint="⌥⌘N"
        onClick={run(() => void offshore.actions.run('new-space'))}
      />
      <MenuSep />
      <MenuRow
        label={split ? 'Exit Split View' : 'Split View with New Tab'}
        hint="⇧⌘S"
        checked={split}
        onClick={run(() => void offshore.tabs.toggleSplit())}
      />
      <MenuRow
        label="Bookmarks Bar"
        checked={settings.bookmarksBar}
        onClick={run(() => onPatchSettings({ bookmarksBar: !settings.bookmarksBar }))}
      />
      <MenuRow
        label={settings.tabOrientation === 'vertical' ? 'Tabs on Top' : 'Tabs in Sidebar'}
        onClick={run(() => void offshore.actions.run('toggle-layout'))}
      />
      <MenuSep />
      <MenuRow
        label="Downloads"
        onClick={run(() => void offshore.actions.run('open-downloads'))}
      />
      <MenuRow
        label={dt ? 'Close Developer Tools' : 'Developer Tools'}
        hint="⌥⌘I"
        checked={dt !== null}
        onClick={run(() => void offshore.tabs.devtools())}
      />
      {/* Which side they dock to, and which side they'll take next time — one
          control for both. A window of their own is not on offer: it was the one
          place they couldn't be closed the way Chromium closes them. */}
      <div className="cr-choice">
        <span className="cr-choice-label">DevTools dock to</span>
        <div className="cr-segmented">
          {(
            [
              ['right', 'Side'],
              ['bottom', 'Bottom']
            ] as [DevToolsDock, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={settings.devtoolsDock === id ? 'on' : ''}
              onClick={() => {
                onPatchSettings({ devtoolsDock: id })
                if (dt) void offshore.tabs.devtoolsDock(id)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <MenuSep />
      <MenuRow
        label="Welcome Tour"
        onClick={run(() => void offshore.actions.run('show-welcome'))}
      />
      <MenuRow
        label="Settings…"
        hint="⌘,"
        onClick={run(() => void offshore.tabs.create('offshore://settings'))}
      />
    </div>
  )
}

/**
 * The profile card. A profile in Offshore is a space — its name, its accent, and
 * whether it keeps its own cookie jar — so this is where those live, laid out
 * the way Helium lays out an account: the identity up top, the switcher under it.
 */
export function ProfileMenu({
  tabsState,
  accentFor,
  onClose
}: {
  tabsState: TabsState
  accentFor: (space: SpaceInfo) => string
  onClose: () => void
}): React.JSX.Element | null {
  const space = tabsState.spaces.find((s) => s.id === tabsState.activeSpaceId)
  if (!space) return null
  const separate = space.profile === 'separate'
  const name = space.name.trim() || 'Space'
  const others = tabsState.spaces.filter((s) => s.id !== space.id)

  return (
    <div className="profile-menu surface-card no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="pm-head">
        <span className="pm-avatar" style={{ '--space-color': accentFor(space) } as React.CSSProperties}>
          {name[0].toUpperCase()}
        </span>
        <div className="pm-id">
          <div className="pm-name">{name}</div>
          <div className="pm-sub">{separate ? 'Separate logins' : 'Shared logins'}</div>
        </div>
      </div>

      <div className="pm-accents">
        <button
          className={`pm-swatch follow ${!space.accent ? 'on' : ''}`}
          title="Follow the browser accent"
          onClick={() => void offshore.spaces.setAccent(space.id, null)}
        />
        {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
          <button
            key={id}
            className={`pm-swatch ${space.accent === id ? 'on' : ''}`}
            title={ACCENTS[id].name}
            style={{ '--swatch': ACCENTS[id].light.accent } as React.CSSProperties}
            onClick={() => void offshore.spaces.setAccent(space.id, id)}
          />
        ))}
      </div>

      <MenuSep />
      <MenuRow
        label="Separate logins"
        checked={separate}
        onClick={() => {
          void offshore.spaces.setProfile(space.id, separate ? 'shared' : 'separate')
          onClose()
        }}
      />
      <MenuRow
        label="Rename…"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('offshore:space-rename', { detail: space.id }))
          onClose()
        }}
      />

      {others.length > 0 && (
        <>
          <MenuSep />
          <div className="cr-section">Switch to</div>
          {others.map((s) => (
            <button
              key={s.id}
              className="cr-item"
              onClick={() => {
                void offshore.spaces.activate(s.id)
                onClose()
              }}
            >
              <span
                className="cr-check pm-dot"
                style={{ '--space-color': accentFor(s) } as React.CSSProperties}
              />
              <span className="cr-label">{s.name}</span>
              {s.profile === 'separate' && <span className="cr-hint">separate</span>}
            </button>
          ))}
        </>
      )}

      <MenuSep />
      <button
        className="cr-item"
        onClick={() => {
          void offshore.actions.run('new-space')
          onClose()
        }}
      >
        <span className="cr-check">
          <IconPlus size={13} />
        </span>
        <span className="cr-label">New space</span>
      </button>
      {tabsState.spaces.length > 1 && (
        <button
          className="cr-item danger"
          onClick={() => {
            void offshore.spaces.remove(space.id)
            onClose()
          }}
        >
          <span className="cr-check">
            <IconTrash size={13} />
          </span>
          <span className="cr-label">Delete space…</span>
        </button>
      )}
    </div>
  )
}
