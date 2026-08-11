import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Suggestion, TabInfo } from '@shared/types'
import { offshore, prettyHost } from './api'
import { Favicon } from '../theme/Favicon'
import {
  IconArrowUpRight,
  IconBolt,
  IconCheck,
  IconClock,
  IconGlobe,
  IconGear,
  IconLink,
  IconSearch,
  IconStarFilled,
  IconTune,
  IconWave
} from './icons'

const KIND_ICON: Record<Suggestion['kind'], React.ComponentType<{ size?: number }>> = {
  url: IconGlobe,
  search: IconSearch,
  history: IconClock,
  bookmark: IconStarFilled,
  internal: IconWave,
  tab: IconArrowUpRight,
  action: IconBolt
}

function hintFor(s: Suggestion): string {
  switch (s.kind) {
    case 'tab':
      return 'Switch to Tab'
    case 'action':
      return 'Action'
    case 'bookmark':
      return prettyHost(s.url)
    case 'search':
      return 'Search'
    case 'history':
      return prettyHost(s.url)
    default:
      return ''
  }
}

/** How a url reads in a suggestion row: "x.com/home" — no scheme, no www. */
function displayPath(url: string): string {
  if (!url || !/^https?:/i.test(url)) return ''
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
}

/** The completable form of a suggestion: "youtube.com/…" — no scheme, no www. */
function completionOf(s: Suggestion): string | null {
  if (s.kind !== 'url' && s.kind !== 'bookmark' && s.kind !== 'history' && s.kind !== 'internal') {
    return null
  }
  if (!s.url) return null
  return s.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
}

export interface OmniboxProps {
  activeTab?: TabInfo
  compact?: boolean
  /** Bumped by the app when ⌘T/⌘L want the cursor here. */
  focusNonce: number
  /** True while the dropdown needs to float over the page. */
  onOverlayNeed: (need: boolean) => void
  /**
   * True while the bar has the cursor. A hidden chrome peeking in for ⌘L has to
   * know: the pointer is nowhere near it, so nothing else would keep it there.
   */
  onEditingChange?: (editing: boolean) => void
  onNavigate: (input: string) => void
  /** Site-info panel toggle — shown as the tune button when a site is loaded. */
  onSiteInfo?: () => void
  /** Page chips (shield, star, …) shown at the bar's trailing edge. */
  actions?: React.ReactNode
}

/**
 * The one and only search bar: a real inline input in the toolbar. Focus lands
 * here on every new tab; suggestions drop down underneath; the top match
 * type-completes ahead of the cursor like a classic omnibox.
 */
export function Omnibox({
  activeTab,
  compact,
  focusNonce,
  onOverlayNeed,
  onEditingChange,
  onNavigate,
  onSiteInfo,
  actions
}: OmniboxProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [typed, setTyped] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLen = useRef(0)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), [])

  const isStart = !activeTab || activeTab.displayUrl === 'offshore://start' || !activeTab.url
  // Chrome-style trim when idle: hide the boring https:// (http:// stays visible — it's a warning)
  const editValue = isStart ? '' : activeTab.displayUrl.replace(/^https:\/\//i, '').replace(/\/$/, '')
  // The sidebar pill is 200px wide with page controls in it — a full path would
  // read as "en.wikiped…". It shows the host, Arc-style, and the whole url the
  // moment you click in. The topbar has the room, so it keeps the full address.
  const idleValue =
    !compact && !isStart && /^https?:/.test(activeTab.url) ? prettyHost(activeTab.url) : editValue

  // The list is up the moment the bar takes focus — top sites before you type a
  // character, live matches after. Every browser worth using does this.
  const dropdownOpen = editing && suggestions.length > 0
  useEffect(() => {
    onOverlayNeed(dropdownOpen)
  }, [dropdownOpen, onOverlayNeed])
  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])

  // ⌘T / ⌘L / new-tab button: take the cursor
  useEffect(() => {
    if (focusNonce === 0) return
    const el = inputRef.current
    if (!el) return
    setEditing(true)
    setValue(editValue)
    setTyped('')
    setSuggestions([])
    setSelected(0)
    lastLen.current = editValue.length
    fetchSuggestions(editValue, false)
    requestAnimationFrame(() => {
      el.focus()
      el.select()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce])

  const endEditing = useCallback(
    (refocusPage: boolean) => {
      if (debounce.current) clearTimeout(debounce.current)
      setEditing(false)
      setTyped('')
      setSuggestions([])
      setSelected(0)
      inputRef.current?.blur()
      if (refocusPage) void offshore.chrome.focusPage()
    },
    []
  )

  /** Empty input is a real query here: it asks for the top-sites list. */
  const fetchSuggestions = (raw: string, grew: boolean): void => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      void offshore.omnibox.suggest(raw).then((sugs) => {
        setSuggestions(sugs)
        setSelected(0)
        // type-ahead: complete the top match past the cursor, selected
        if (grew && sugs.length) {
          const comp = completionOf(sugs[0])
          if (comp && comp.toLowerCase().startsWith(raw.toLowerCase()) && comp.length > raw.length) {
            const el = inputRef.current
            if (el && el.value === raw) {
              setValue(comp)
              requestAnimationFrame(() => el.setSelectionRange(raw.length, comp.length))
            }
          }
        }
      })
    }, 60)
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value
    const grew = raw.length > lastLen.current
    lastLen.current = raw.length
    setValue(raw)
    setTyped(raw)
    fetchSuggestions(raw, grew)
  }

  const pick = (s: Suggestion | undefined): void => {
    const fallback = typed.trim() || value.trim()
    endEditing(false)
    if (!s) {
      if (fallback) onNavigate(fallback)
      else void offshore.chrome.focusPage()
      return
    }
    if (s.kind === 'tab' && s.tabId != null) {
      void offshore.tabs.activate(s.tabId)
      return
    }
    if (s.kind === 'action' && s.action) {
      void offshore.actions.run(s.action)
      return
    }
    onNavigate(s.url || fallback)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      endEditing(true)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, Math.max(suggestions.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(suggestions[selected])
    }
  }

  const shownValue = editing ? value : idleValue
  const showFavicon = !editing && !isStart && activeTab?.favicon
  // Offshore's own pages have no site to tune and no link worth copying. (They
  // are served over http in dev, so ask the display url, not the real one.)
  const onPage =
    !editing &&
    /^https?:/.test(activeTab?.url ?? '') &&
    !(activeTab?.displayUrl ?? '').startsWith('offshore://') &&
    !!onSiteInfo
  // The page controls sit at the trailing edge in both layouts — site settings
  // and the star, the way Chromium parks them. Copy link is the exception: it
  // belongs to the address itself, so it sits at the leading edge, right on top
  // of where the link starts, and only shows up when the pointer is in the bar.
  const trailingActions = onPage

  const copyLink = (): void => {
    const url = activeTab?.url
    if (!url) return
    void offshore.chrome.copyText(url)
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1100)
  }
  // internal pages wear their own marks; the wave is the badge of a fresh tab
  const idleGlyph = activeTab?.displayUrl.startsWith('offshore://settings') ? (
    <IconGear size={13} />
  ) : (
    <IconWave size={13} />
  )

  return (
    <div
      className={`omnibox no-drag ${compact ? 'compact' : ''} ${editing ? 'editing' : ''} ${
        trailingActions ? 'has-actions' : ''
      }`}
    >
      {trailingActions ? (
        /* Sits in the address's own place: idle it takes no room at all, so the
           host still reads flush left until you bring the pointer in here. */
        <button
          className={`omni-copy omni-copy-lead ${copied ? 'done' : ''}`}
          title={copied ? 'Copied' : 'Copy link'}
          onClick={copyLink}
        >
          {copied ? <IconCheck size={14} /> : <IconLink size={14} />}
        </button>
      ) : (
        <span className="omni-icon">
          {showFavicon ? (
            <img src={activeTab.favicon} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
          ) : editing ? (
            <IconSearch size={13} />
          ) : (
            idleGlyph
          )}
        </span>
      )}
      <input
        ref={inputRef}
        className="omni-input"
        value={shownValue}
        placeholder="Search or type URL"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onFocus={(e) => {
          if (!editing) {
            setEditing(true)
            setValue(editValue)
            setTyped('')
            lastLen.current = editValue.length
            fetchSuggestions(editValue, false)
            requestAnimationFrame(() => e.target.select())
          }
        }}
        onBlur={() => {
          // clicking a suggestion fires mousedown first (preventDefault keeps focus)
          endEditing(false)
        }}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
      {trailingActions && (
        <div className="omni-actions">
          {actions}
          <button className="omni-tune boxed" title="Site information" onClick={onSiteInfo}>
            <IconTune size={14} />
          </button>
        </div>
      )}
      {dropdownOpen && (
        <div className="omni-dropdown surface-card">
          {suggestions.map((s, i) => {
            const Icon = KIND_ICON[s.kind] ?? IconGlobe
            const path = displayPath(s.url)
            // A search reads as the words you would be searching for — never as
            // the engine's query string, which is nobody's idea of a suggestion.
            const query = s.kind === 'search'
            const primary = s.kind === 'tab' || query ? s.text : s.title || (path || s.text)
            const secondary = query || s.kind === 'action' || primary === path ? '' : path
            const hint = hintFor(s)
            return (
              <div
                key={`${s.kind}-${s.url}-${s.tabId ?? ''}-${s.action ?? ''}-${i}`}
                className={`omni-suggestion ${query ? 'query' : ''} ${i === selected ? 'selected' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(s)
                }}
              >
                <span className="s-icon">
                  {/* a query wears the magnifier, not the engine's favicon */}
                  {/^https?:/.test(s.url) && !query ? (
                    <Favicon
                      url={s.url}
                      stored={s.favicon}
                      className="s-favicon"
                      fallback={<Icon size={15} />}
                    />
                  ) : (
                    <Icon size={15} />
                  )}
                </span>
                <span className="s-text">{primary}</span>
                {secondary && <span className="s-url">— {secondary}</span>}
                <span className="s-fill" />
                {(s.kind === 'tab' || s.kind === 'action' || s.kind === 'search') && (
                  <span className="s-hint">{hint}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
