import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BriefWeather, MorningAnswer, NewTabWidgets, Settings, WidgetLayout } from '@shared/types'
import { DEFAULT_SETTINGS, HOME_WIDGETS, resolveAccentColors, weatherCondition } from '@shared/types'
import { ClassicWaves } from '../theme/ClassicWaves'
import { moonPhase } from '../theme/moon'
import { DitheredWaves } from '../theme/DitheredWaves'
import { MorningBrief } from './MorningBrief'
import { Weather } from '../theme/WeatherIcons'
import { useIsDark } from '../theme/useTheme'
import '../theme/theme.css'
import './start.css'

type WidgetKey = keyof NewTabWidgets

/** Each character keys on its value, so only changed digits roll in. */
function SlidingClock({ time, className }: { time: string; className?: string }): React.JSX.Element {
  return (
    <div className={`clock ${className ?? ''}`} aria-label={time}>
      {time.split('').map((ch, i) => (
        <span className="clock-ch" key={`${i}-${ch}`}>
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </div>
  )
}

function greeting(hour: number): string {
  if (hour >= 5 && hour < 11) return 'Good morning'
  if (hour >= 11 && hour < 17) return 'Good afternoon'
  if (hour >= 17 && hour < 23) return 'Good evening'
  return 'Up late'
}

/** Single fetch shared by the weather / forecast / sun widgets. */
function useWeather(
  enabled: boolean,
  hasLocation: boolean,
  fetchWeather: () => Promise<BriefWeather | null>
): BriefWeather | null {
  const [weather, setWeather] = useState<BriefWeather | null>(null)
  const fetchRef = useRef(fetchWeather)
  fetchRef.current = fetchWeather

  const refresh = useCallback(() => {
    void fetchRef.current().then(setWeather)
  }, [])

  useEffect(() => {
    if (!enabled || !hasLocation) return
    refresh()
    const t = setInterval(refresh, 15 * 60 * 1000)
    const onVis = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [enabled, hasLocation, refresh])

  if (!weather || Date.now() - weather.fetchedAt > 3 * 60 * 60 * 1000) return null
  return weather
}

function WeatherNow({ weather, style }: { weather: BriefWeather; style: string }): React.JSX.Element {
  const cond = weatherCondition(weather.now.code)
  if (style === 'compact') {
    return (
      <div className="widget-weather compact">
        <span className="brief-icon">
          <Weather icon={cond.icon} isDay={weather.now.isDay} size={17} />
        </span>{' '}
        <strong>{weather.now.temp}°</strong>
      </div>
    )
  }
  return (
    <div className="widget-weather">
      <span className="brief-icon">
        <Weather icon={cond.icon} isDay={weather.now.isDay} size={19} />
      </span>{' '}
      <strong>{weather.now.temp}°</strong> and {cond.label}
      {style !== 'plain' && (
        <span className="brief-hilo">
          {'  '}H {weather.hi}° · L {weather.lo}°
        </span>
      )}
    </div>
  )
}

function ForecastHours({ weather }: { weather: BriefWeather }): React.JSX.Element | null {
  if (!weather.hours.length) return null
  return (
    <div className="brief-hours">
      {weather.hours.map((h) => {
        const c = weatherCondition(h.code)
        return (
          <span className="brief-hour" key={h.hour}>
            <span className="bh-time">{h.hour}</span>
            <Weather icon={c.icon} isDay={h.isDay} size={14} />
            <span className="bh-temp">{h.temp}°</span>
          </span>
        )
      })}
    </div>
  )
}

// ---------------- the grid ----------------

/**
 * The home screen is a grid of cells, the way a phone's is, and a widget is
 * always a whole number of them. Both counts are even and every widget size is
 * even, so anything can sit dead centre — the thing you reach for first.
 *
 * Positions are stored in cells, never pixels, so a layout means the same thing
 * in a small window and a full-screen one: the cells stretch, the arrangement
 * holds.
 */
const COLS = 12
const ROWS = 10

/**
 * The two middle rows belong to the search pill. They are held on both home
 * screens, whether or not a pill is actually drawn there, so a layout built on
 * a new tab reads identically on the zero-tab window — and nothing can ever be
 * dropped underneath the search field.
 */
const BAND_TOP = 4
const BAND_END = 6

/** Breathing room between a widget's card and its cell, in px. */
const GUTTER = 7

interface Rect {
  col: number
  row: number
  w: number
  h: number
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** On the board, and clear of the pill's band. */
function insideGrid(r: Rect): boolean {
  if (r.col < 0 || r.row < 0 || r.col + r.w > COLS || r.row + r.h > ROWS) return false
  return !(r.row < BAND_END && r.row + r.h > BAND_TOP)
}

function hits(a: Rect, b: Rect): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h
}

function isFree(r: Rect, taken: Rect[]): boolean {
  return insideGrid(r) && !taken.some((t) => hits(t, r))
}

/** The free cell of this size that scores lowest — the caller says what "best" means. */
function bestSpot(w: number, h: number, taken: Rect[], score: (r: Rect) => number): Rect | null {
  let best: Rect | null = null
  let bestScore = Infinity
  for (let row = 0; row + h <= ROWS; row++) {
    for (let col = 0; col + w <= COLS; col++) {
      const r = { col, row, w, h }
      if (!isFree(r, taken)) continue
      const s = score(r)
      if (s < bestScore) {
        bestScore = s
        best = r
      }
    }
  }
  return best
}

/**
 * Where a widget lands when nobody has placed it: as close to the middle column
 * as it can get, and as close to the pill as it can get. Centre beats proximity,
 * so widgets stack into a column above the search rather than spreading sideways
 * — which is what the page looked like before there was a grid at all.
 */
function homeScore(r: Rect): number {
  const rowGap = r.row + r.h <= BAND_TOP ? BAND_TOP - (r.row + r.h) : r.row - BAND_END
  return Math.abs(r.col - (COLS - r.w) / 2) * 8 + rowGap
}

// ---------------- widget catalogue ----------------

const ALL_WIDGETS: WidgetKey[] = ['clock', 'date', 'greeting', 'weather', 'forecast', 'sun', 'moon']

const WIDGET_LABELS: Record<WidgetKey, string> = {
  clock: 'Time',
  date: 'Date',
  greeting: 'Greeting',
  weather: 'Weather',
  forecast: 'Hourly forecast',
  sun: 'Sunrise & sunset',
  moon: 'Moon phase'
}

interface WidgetSize {
  w: number
  h: number
  label: string
}

/** The sizes each widget comes in. Every one is even on both axes. */
const WIDGET_SIZES: Record<WidgetKey, WidgetSize[]> = {
  clock: [
    { w: 4, h: 2, label: 'Small' },
    { w: 4, h: 4, label: 'Medium' },
    { w: 6, h: 4, label: 'Large' }
  ],
  date: [
    { w: 2, h: 2, label: 'Small' },
    { w: 4, h: 2, label: 'Medium' }
  ],
  greeting: [
    { w: 4, h: 2, label: 'Medium' },
    { w: 6, h: 2, label: 'Wide' }
  ],
  weather: [
    { w: 2, h: 2, label: 'Small' },
    { w: 4, h: 2, label: 'Medium' },
    { w: 4, h: 4, label: 'Large' }
  ],
  forecast: [
    { w: 6, h: 2, label: 'Wide' },
    { w: 8, h: 2, label: 'Wider' }
  ],
  sun: [
    { w: 4, h: 2, label: 'Medium' },
    { w: 6, h: 2, label: 'Wide' }
  ],
  moon: [
    { w: 2, h: 2, label: 'Small' },
    { w: 4, h: 2, label: 'Medium' }
  ]
}

const DEFAULT_SIZE: Record<WidgetKey, WidgetSize> = {
  clock: WIDGET_SIZES.clock[1],
  date: WIDGET_SIZES.date[1],
  greeting: WIDGET_SIZES.greeting[0],
  weather: WIDGET_SIZES.weather[1],
  forecast: WIDGET_SIZES.forecast[0],
  sun: WIDGET_SIZES.sun[0],
  moon: WIDGET_SIZES.moon[1]
}

/** Looks each widget can wear, chosen from its own strip in edit mode. */
const WIDGET_STYLES: Partial<Record<WidgetKey, { id: string; label: string }[]>> = {
  clock: [
    { id: 'serif', label: 'Serif' },
    { id: 'light', label: 'Light' },
    { id: 'mono', label: 'Mono' }
  ],
  date: [
    { id: 'long', label: 'Sunday, August 10' },
    { id: 'short', label: 'Sun, Aug 10' },
    { id: 'numeric', label: '8/10/26' }
  ],
  greeting: [
    { id: 'serif', label: 'Serif' },
    { id: 'plain', label: 'Plain' }
  ],
  weather: [
    { id: 'full', label: 'Full' },
    { id: 'plain', label: 'No high/low' },
    { id: 'compact', label: 'Just the temp' }
  ]
}

const DEFAULT_STYLE: Record<WidgetKey, string> = {
  clock: 'serif',
  date: 'long',
  greeting: 'serif',
  weather: 'full',
  forecast: 'strip',
  sun: 'line',
  moon: 'line'
}

/**
 * A row under the search pill. This is the omnibox's own suggestion shape, kept
 * to the fields the pill actually shows — the page is a tab like any other, so
 * it never sees the chrome's types.
 */
export interface HomeSuggestion {
  kind: 'tab' | 'url' | 'search' | 'action' | 'internal' | 'bookmark' | 'history'
  text: string
  url: string
  title?: string
}

interface HomeCanvasProps {
  settings: Settings
  /** Persist a settings change — the caller owns the copy it renders from. */
  onPatch(patch: Partial<Settings>): void
  /** A query or URL was committed in the search pill. */
  onSubmit(input: string): void
  /**
   * What the engine and your own tabs, bookmarks and history make of a
   * half-typed word. Left out on the zero-tab screen, which has no search to
   * put a list under.
   */
  fetchSuggestions?(input: string): Promise<HomeSuggestion[]>
  fetchWeather(): Promise<BriefWeather | null>
  /**
   * Does this screen have a search at all? On for a new tab, which is a page you
   * can search from; off for the zero-tab window, which is just the home screen
   * sitting there. Either way the pill's row is held, so the widgets land in
   * exactly the same place on both screens.
   */
  searchPill?: boolean
  /**
   * Is that search in front of you right now? It arrives with the tab and goes
   * away when you click past it, leaving the home screen it was standing on —
   * the tab stays exactly where it is.
   */
  searchOpen?: boolean
  /** The search was clicked away, escaped, or edit mode took the screen. */
  onDismissSearch?(): void
  /** Bump to enter widget edit mode from outside (context menu, menu bar). */
  editSignal?: number
  /**
   * Right-click handler. A tab page leaves this alone — its menu comes from
   * the WebContents. The zero-tab screen is chrome, which has no menu of its
   * own, so it passes one in.
   */
  onContextMenu?(): void
  autoFocus?: boolean
  className?: string
  /**
   * The once-a-day morning brief, when this surface owns it. Only the
   * offshore://start tab passes it; the chrome's zero-tab home and the
   * stand-in pass nothing, so they never double-claim or double-render it.
   */
  morning?: MorningAnswer | null
  onMorningDismiss?(): void
}

/**
 * Offshore's home surface. A new tab and a window with no tabs are the same
 * screen, so they are the same component, reading the same widget settings —
 * edit the widgets on either and both change.
 *
 * The widgets live on a grid that spans the whole pane, edge to edge, with the
 * search pill holding the two middle rows. Right-click → Edit Widgets (or press
 * and hold) enters iPhone-home-screen edit mode: widgets jiggle, − removes, and
 * dragging one shows the cell it will take and springs it into place on release.
 * Nothing else moves while you drag, so a widget goes where you put it.
 */
export function HomeCanvas({
  settings,
  onPatch: patch,
  onSubmit,
  fetchSuggestions,
  fetchWeather,
  searchPill = true,
  searchOpen = true,
  onDismissSearch,
  editSignal = 0,
  onContextMenu,
  autoFocus = false,
  className = '',
  morning = null,
  onMorningDismiss
}: HomeCanvasProps): React.JSX.Element {
  const [now, setNow] = useState(new Date())
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<WidgetKey | null>(null)
  const [drag, setDrag] = useState<{
    key: WidgetKey
    dx: number
    dy: number
    /** The cell it would take if you let go now. */
    target: Rect
    /** A same-size widget sitting there, which trades places with it. */
    swap: WidgetKey | null
  } | null>(null)
  const [text, setText] = useState('')
  const [pillWidth, setPillWidth] = useState<number | null>(null)
  /** The pane in px. Everything on the board is derived from this. */
  const [board, setBoard] = useState({ w: 0, h: 0 })
  /** How tall the add-a-widget tray is right now — the board stops above it. */
  const [trayH, setTrayH] = useState(56)
  /** True while the window is being resized — the widgets follow it live, not on a spring. */
  const [resizing, setResizing] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLSpanElement>(null)
  const trayRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{
    key: WidgetKey
    x: number
    y: number
    /** Where the widget was when the drag began — where a swapped neighbour goes. */
    rect: Rect
    moved: boolean
    target: Rect
    swap: WidgetKey | null
  } | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const patchRef = useRef(patch)
  patchRef.current = patch
  const isDark = useIsDark()

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])

  const showSearch = searchPill && searchOpen && !editing
  const dismissRef = useRef(onDismissSearch)
  dismissRef.current = onDismissSearch

  /*
   * The rows under the pill, and which one the arrows are on (-1 = none, so
   * Enter still means "what I typed"). Asked for a beat after you stop typing:
   * the type-ahead half of this list goes out over the network, and a request
   * per keystroke would be both slower and louder than one per word.
   */
  const [sugs, setSugs] = useState<HomeSuggestion[]>([])
  const [pick, setPick] = useState(-1)
  const suggestRef = useRef(fetchSuggestions)
  suggestRef.current = fetchSuggestions

  useEffect(() => {
    const q = text.trim()
    if (!showSearch || !suggestRef.current || !q) {
      setSugs([])
      setPick(-1)
      return undefined
    }
    let live = true
    const t = setTimeout(() => {
      void suggestRef.current?.(q).then((rows) => {
        if (!live) return
        setSugs(rows ?? [])
        // a fresh list is nobody's selection yet
        setPick(-1)
      })
    }, 90)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [text, showSearch])

  // Putting the search away takes its list with it.
  useEffect(() => {
    if (!showSearch) {
      setSugs([])
      setPick(-1)
    }
  }, [showSearch])

  // Only take the cursor when there is a pill to take it into — otherwise the
  // toolbar omnibox owns it and this would yank focus out from under it.
  useEffect(() => {
    if (autoFocus && showSearch) inputRef.current?.focus()
  }, [autoFocus, showSearch])

  /*
   * Escape puts the search away. It is the one panel on this page, so it is the
   * only thing Escape can mean — and it leaves the home screen behind rather
   * than the tab, which is the whole point of it being a panel.
   */
  useEffect(() => {
    if (!showSearch) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        dismissRef.current?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSearch])

  // editing the widgets is a different job — the search gets out of the way
  useEffect(() => {
    if (editing) dismissRef.current?.()
  }, [editing])

  // a dismissed search comes back empty, the way a closed one should
  useEffect(() => {
    if (!showSearch) setText('')
  }, [showSearch])

  useEffect(() => {
    if (editSignal > 0 && HOME_WIDGETS) setEditing(true)
  }, [editSignal])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.blur()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        setEditing(false)
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  // ---- the board measures itself; cells are whatever fits ----

  useLayoutEffect(() => {
    const el = hostRef.current
    const tray = trayRef.current
    if (!el || !tray) return
    const read = (): void => {
      setBoard({ w: el.clientWidth, h: el.clientHeight })
      setTrayH(tray.offsetHeight)
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    ro.observe(tray)
    return () => ro.disconnect()
  }, [])

  /*
   * The board's margins are part of the cell arithmetic rather than the grid
   * element's box, so the element never moves: entering edit mode changes only
   * the numbers, and every widget springs from where it was to where it now
   * belongs. A short window keeps a smaller foot so the cells stay usable.
   */
  const padX = 20
  const padTop = editing ? 58 : 24
  // the tray is measured rather than guessed: it grows to three rows on a narrow
  // window, and the board has to end above it wherever it ends up
  const padBottom = editing ? 48 + trayH : Math.min(96, Math.round(board.h * 0.14))
  const cellW = Math.max(0, board.w - padX * 2) / COLS
  const cellH = Math.max(0, board.h - padTop - padBottom) / ROWS
  const boardW = cellW * COLS
  const boardH = cellH * ROWS

  // ---- the pill grows with what you type, staying centred ----

  const measure = useCallback(() => {
    const mirror = mirrorRef.current
    const host = hostRef.current
    if (!mirror || !host) return
    const avail = host.clientWidth
    if (!avail) return
    const base = Math.min(600, avail * 0.68)
    const max = Math.max(base, Math.min(940, avail - 72))
    const pad = 22 * 2 + 18 + 12 + 10 // padding + icon + gap + caret slack
    setPillWidth(Math.round(Math.min(max, Math.max(base, mirror.offsetWidth + pad))))
  }, [])

  useLayoutEffect(measure, [measure, text])

  useEffect(() => {
    const onResize = (): void => {
      measure()
      setResizing(true)
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
      resizeTimer.current = setTimeout(() => setResizing(false), 180)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
    }
  }, [measure])

  const submit = (): void => {
    const q = text.trim()
    if (!q) return
    setText('')
    setSugs([])
    setPick(-1)
    onSubmit(q)
  }

  /**
   * Take the highlighted row, or what was typed when nothing is highlighted.
   * A row carries the url it resolved to, so picking "canva" searches for the
   * word rather than for the letters that were actually in the box.
   */
  const commit = (): void => {
    const chosen = pick >= 0 ? sugs[pick] : undefined
    if (!chosen) return submit()
    setText('')
    setSugs([])
    setPick(-1)
    onSubmit(chosen.url || chosen.text)
  }

  const widgets: NewTabWidgets = settings.newTabWidgets ?? DEFAULT_SETTINGS.newTabWidgets
  const layout = settings.newTabWidgetLayout ?? {}
  const baseOrder = (settings.newTabWidgetOrder?.length ? settings.newTabWidgetOrder : ALL_WIDGETS).filter(
    (k) => ALL_WIDGETS.includes(k)
  )
  const order: WidgetKey[] = [...baseOrder, ...ALL_WIDGETS.filter((k) => !baseOrder.includes(k))]
  const enabledKeys = order.filter((k) => widgets[k])
  const availableKeys = ALL_WIDGETS.filter((k) => !widgets[k])

  const sizeOf = (key: WidgetKey): WidgetSize => {
    const saved = layout[key]
    return WIDGET_SIZES[key].find((s) => s.w === saved?.w && s.h === saved?.h) ?? DEFAULT_SIZE[key]
  }
  const styleOf = (key: WidgetKey): string => layout[key]?.style ?? DEFAULT_STYLE[key]

  /**
   * Every enabled widget's cell. A saved position is honoured whenever it still
   * fits and nothing has taken it; otherwise the widget is placed for you. Order
   * decides who gets first claim, so the resolution is the same on every screen
   * showing this home — no two windows disagree about where the clock is.
   */
  const fingerprint = JSON.stringify(
    enabledKeys.map((k) => [k, layout[k]?.col, layout[k]?.row, layout[k]?.w, layout[k]?.h])
  )
  const placement = useMemo(() => {
    const taken: Rect[] = []
    const out = new Map<WidgetKey, Rect>()

    // Placed widgets first, all of them, before anything is placed for you —
    // otherwise adding a widget could take a cell someone already put one in.
    for (const key of enabledKeys) {
      const size = sizeOf(key)
      const saved = layout[key]
      if (!Number.isInteger(saved?.col) || !Number.isInteger(saved?.row)) continue
      const cand = { col: saved!.col!, row: saved!.row!, w: size.w, h: size.h }
      if (!isFree(cand, taken)) continue
      out.set(key, cand)
      taken.push(cand)
    }

    for (const key of enabledKeys) {
      if (out.has(key)) continue
      const size = sizeOf(key)
      // A full board is the only way past bestSpot: park it rather than drop it.
      const rect = bestSpot(size.w, size.h, taken, homeScore) ?? { col: 0, row: 0, w: size.w, h: size.h }
      out.set(key, rect)
      taken.push(rect)
    }

    // back into the order the widgets are listed in, so the − badges stagger
    // down the page rather than in whatever order the cells were resolved
    return new Map(enabledKeys.filter((k) => out.has(k)).map((k) => [k, out.get(k)!]))
  }, [fingerprint])

  // Write placements back so they stop being a guess: an old layout from before
  // the grid, or a widget just added, settles into a cell it keeps. Identical on
  // every screen, so the second one to run finds nothing to write.
  useEffect(() => {
    const next: Partial<Record<WidgetKey, WidgetLayout>> = {}
    let changed = false
    for (const [key, r] of placement) {
      const s = layout[key]
      if (s?.col === r.col && s?.row === r.row && s?.w === r.w && s?.h === r.h) continue
      next[key] = { ...s, col: r.col, row: r.row, w: r.w, h: r.h }
      changed = true
    }
    if (changed) patchRef.current({ newTabWidgetLayout: { ...layout, ...next } })
  }, [placement])

  const hasLocation = settings.brief?.lat != null
  const wantsWeather = widgets.weather || widgets.forecast || widgets.sun
  const weather = useWeather(wantsWeather, hasLocation, fetchWeather)

  const time = now.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
  const acc = resolveAccentColors(settings.appearance ?? DEFAULT_SETTINGS.appearance, isDark)

  const dateText = (style: string): string => {
    if (style === 'short')
      return now.toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      })
    if (style === 'numeric') return now.toLocaleDateString()
    return now.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    })
  }

  const renderWidget = (key: WidgetKey, style: string): React.ReactNode => {
    switch (key) {
      case 'clock':
        return <SlidingClock time={time} className={`clock-${style}`} />
      case 'date':
        return <div className="date">{dateText(style)}</div>
      case 'greeting':
        return (
          <div className={style === 'plain' ? 'greet-plain' : 'brief-line greet'}>
            {greeting(now.getHours())}.
          </div>
        )
      case 'weather':
        return weather ? (
          <WeatherNow weather={weather} style={style} />
        ) : editing ? (
          <div className="widget-line dim">Weather{hasLocation ? '…' : ' — set a location in Settings'}</div>
        ) : null
      case 'forecast':
        return weather ? (
          <ForecastHours weather={weather} />
        ) : editing ? (
          <div className="widget-line dim">Hourly forecast</div>
        ) : null
      case 'sun':
        return weather?.sunrise && weather?.sunset ? (
          <div className="widget-line">
            ☀️ {weather.sunrise} → 🌙 {weather.sunset}
          </div>
        ) : editing ? (
          <div className="widget-line dim">Sunrise &amp; sunset</div>
        ) : null
      case 'moon':
        return (
          <div className="widget-line">
            {moonPhase(now).icon} {moonPhase(now).name}
          </div>
        )
    }
  }

  // ---- dragging: the board holds still and the widget picks a cell ----

  const boxStyle = (r: Rect, dx = 0, dy = 0): React.CSSProperties => {
    const w = Math.max(0, r.w * cellW - GUTTER * 2)
    const h = Math.max(0, r.h * cellH - GUTTER * 2)
    return {
      transform: `translate3d(${padX + r.col * cellW + GUTTER + dx}px, ${
        padTop + r.row * cellH + GUTTER + dy
      }px, 0)`,
      width: w,
      height: h,
      // the content sizes itself off the box it is in, so a big clock is big
      ['--bw' as string]: `${w}px`,
      ['--bh' as string]: `${h}px`
    }
  }

  const onWidgetPointerDown = (e: React.PointerEvent, key: WidgetKey): void => {
    if (!editing) return
    if ((e.target as HTMLElement).closest('.widget-remove, .style-strip')) return
    const rect = placement.get(key)
    if (!rect) return
    e.preventDefault()
    e.stopPropagation()
    try {
      // capture keeps the drag with this widget even when the pointer runs off it
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* no live pointer to capture */
    }
    dragStart.current = { key, x: e.clientX, y: e.clientY, rect, moved: false, target: rect, swap: null }
    setDrag({ key, dx: 0, dy: 0, target: rect, swap: null })
  }

  // The drag lives in a ref, not in state: a move must be able to act on the
  // pointerdown that came a moment ago, whether or not React has re-rendered
  // for it yet. State is only what the board is painted from.
  const onWidgetPointerMove = (e: React.PointerEvent, key: WidgetKey): void => {
    const start = dragStart.current
    if (!start || start.key !== key || !cellW || !cellH) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!start.moved && Math.hypot(dx, dy) > 4) start.moved = true

    const { w, h } = start.rect
    // Where the widget's own top-left has been dragged to, in cells.
    const col = clamp(Math.round((start.rect.col * cellW + dx) / cellW), 0, Math.max(0, COLS - w))
    const row = clamp(Math.round((start.rect.row * cellH + dy) / cellH), 0, Math.max(0, ROWS - h))
    const wanted = { col, row, w, h }

    const others = enabledKeys
      .filter((k) => k !== key)
      .map((k) => ({ key: k, rect: placement.get(k)! }))
      .filter((o) => o.rect)

    let target = wanted
    let swap: WidgetKey | null = null
    if (!isFree(wanted, others.map((o) => o.rect))) {
      const under = others.filter((o) => hits(o.rect, wanted))
      if (insideGrid(wanted) && under.length === 1 && under[0].rect.w === w && under[0].rect.h === h) {
        // same size, one neighbour: the two trade places, like the home screen
        target = under[0].rect
        swap = under[0].key
      } else {
        target =
          bestSpot(
            w,
            h,
            others.map((o) => o.rect),
            (r) => (r.col - col) ** 2 + (r.row - row) ** 2
          ) ?? start.target
      }
    }
    start.target = target
    start.swap = swap
    setDrag({ key, dx, dy, target, swap })
  }

  const endDrag = (): void => setDrag(null)

  const onWidgetPointerUp = (e: React.PointerEvent, key: WidgetKey): void => {
    const start = dragStart.current
    dragStart.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
    if (!start) return
    if (!start.moved) {
      // a tap, not a drag: open this widget's size and style strip
      setSelected((prev) => (prev === key ? null : key))
      endDrag()
      return
    }
    const { target, swap } = start
    const next: Partial<Record<WidgetKey, WidgetLayout>> = {
      [key]: { ...layout[key], col: target.col, row: target.row, w: target.w, h: target.h }
    }
    if (swap) {
      next[swap] = {
        ...layout[swap],
        col: start.rect.col,
        row: start.rect.row,
        w: start.rect.w,
        h: start.rect.h
      }
    }
    patch({ newTabWidgetLayout: { ...layout, ...next } })
    endDrag()
  }

  const removeWidget = (key: WidgetKey): void => {
    if (selected === key) setSelected(null)
    patch({ newTabWidgets: { ...widgets, [key]: false } })
  }

  const addWidget = (key: WidgetKey): void => {
    patch({ newTabWidgets: { ...widgets, [key]: true } })
  }

  const setStyle = (key: WidgetKey, style: string): void => {
    patch({ newTabWidgetLayout: { ...layout, [key]: { ...layout[key], style } } })
  }

  /**
   * Growing or shrinking a widget keeps its top-left corner where it is when the
   * new size still fits there; when it does not, the widget moves the shortest
   * distance to a cell that holds it.
   */
  const setSize = (key: WidgetKey, size: WidgetSize): void => {
    const at = placement.get(key)
    const others = enabledKeys.filter((k) => k !== key).map((k) => placement.get(k)!)
    const anchor = at ?? { col: 0, row: 0, ...size }
    let rect: Rect = {
      col: clamp(anchor.col, 0, Math.max(0, COLS - size.w)),
      row: clamp(anchor.row, 0, Math.max(0, ROWS - size.h)),
      w: size.w,
      h: size.h
    }
    if (!isFree(rect, others)) {
      rect =
        bestSpot(size.w, size.h, others, (r) => (r.col - anchor.col) ** 2 + (r.row - anchor.row) ** 2) ??
        rect
    }
    patch({
      newTabWidgetLayout: {
        ...layout,
        [key]: { ...layout[key], col: rect.col, row: rect.row, w: rect.w, h: rect.h }
      }
    })
  }

  /** Anything that isn't the search itself puts the search away. */
  const onHostPointerDown = (e: React.PointerEvent): void => {
    if (showSearch && !(e.target as HTMLElement).closest('.start-search')) dismissRef.current?.()
    startHold(e)
  }

  // press and hold empty space to start editing, like the home screen
  const startHold = (e: React.PointerEvent): void => {
    if (editing || !HOME_WIDGETS) return
    if ((e.target as HTMLElement).closest('.widget-slot, .start-search, .we-done, .we-tray')) return
    holdTimer.current = setTimeout(() => setEditing(true), 550)
  }
  const cancelHold = (): void => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }

  const bandStyle: React.CSSProperties = {
    transform: `translate3d(${padX}px, ${padTop + BAND_TOP * cellH}px, 0)`,
    width: boardW,
    height: (BAND_END - BAND_TOP) * cellH
  }
  /** The pill rides the middle of the band it holds. */
  const pillTop = padTop + ((BAND_TOP + BAND_END) / 2) * cellH

  return (
    <div
      ref={hostRef}
      className={`start ${editing ? 'editing' : ''} ${resizing ? 'no-anim' : ''} ${className}`}
      style={{
        background: `linear-gradient(180deg, ${acc.tintTop} 0%, ${acc.tintBottom} 100%)`
      }}
      onPointerDown={onHostPointerDown}
      onPointerUp={cancelHold}
      onPointerMove={cancelHold}
      onPointerLeave={cancelHold}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault()
              cancelHold()
              onContextMenu()
            }
          : undefined
      }
    >
      {/* the edit chrome stays mounted and fades — mounting it on the click
          makes entering and leaving edit mode snap, which reads cheap */}
      <button
        className={`we-done ${editing ? 'on' : ''}`}
        tabIndex={editing ? 0 : -1}
        aria-hidden={!editing}
        onClick={() => {
          setEditing(false)
          setSelected(null)
        }}
      >
        Done
      </button>

      <div className="start-stage">
        {/* The board: the full width of the pane, edge to edge. In edit mode it
            pulls in from the top and bottom to clear the Done button and the
            tray, and every widget springs along with it. */}
        <div
          className="start-grid"
          style={{
            ['--cw' as string]: `${cellW}px`,
            ['--ch' as string]: `${cellH}px`,
            ['--gx' as string]: `${padX}px`,
            ['--gy' as string]: `${padTop}px`,
            ['--gw' as string]: `${boardW}px`,
            ['--gh' as string]: `${boardH}px`
          }}
        >
          {/* With the board parked, the home screen is the time and the search
              in front of it — the clock takes the top and stays out of the way. */}
          {!HOME_WIDGETS && (
            <div className="plain-clock">
              <SlidingClock time={time} className="clock-serif" />
            </div>
          )}

          {HOME_WIDGETS && <div className="grid-band" style={bandStyle} />}

          {/* The once-a-day brief, just below the search band and clear of the
              waves. It sits UNDER the dim (z 1 vs 2) and the pill + its
              suggestion list (z 3), so the search stays plainly the thing in
              front while it is up. */}
          {morning && morning.kind !== 'none' && board.h > 0 && (
            <MorningBrief
              answer={morning}
              tiles={acc.tiles}
              top={padTop + BAND_END * cellH + 18}
              maxHeight={Math.max(0, board.h - (padTop + BAND_END * cellH + 18) - 120)}
              onOpen={(input) => onSubmit(input)}
              onDismiss={() => onMorningDismiss?.()}
              onEnableHistory={() => patch({ keepHistory: true })}
            />
          )}

          {/* half a step back while the search is in front of it */}
          {searchPill && <div className={`start-dim ${showSearch ? 'on' : ''}`} />}

          {HOME_WIDGETS && drag && <div className="drop-ghost" style={boxStyle(drag.target)} />}

          {HOME_WIDGETS &&
            board.w > 0 &&
            enabledKeys.map((key, i) => {
              const rect = placement.get(key)
              if (!rect) return null
              const style = styleOf(key)
              const inner = renderWidget(key, style)
              if (!inner) return null
              const dragging = drag?.key === key
              const nudged = drag?.swap === key
              const styles = WIDGET_STYLES[key]
              const sizes = WIDGET_SIZES[key]
              const size = sizeOf(key)
              // a widget low on the board opens its strip upward
              const flip = rect.row + rect.h > ROWS - 2
              return (
                <div
                  key={key}
                  className={`widget-slot ${dragging ? 'dragging' : ''} ${nudged ? 'nudged' : ''} ${
                    selected === key ? 'selected' : ''
                  } ${rect.w <= 2 ? 'narrow' : ''}`}
                  style={{
                    ...boxStyle(rect, dragging ? drag.dx : 0, dragging ? drag.dy : 0),
                    zIndex: dragging ? 6 : selected === key ? 5 : 1
                  }}
                  onPointerDown={(e) => onWidgetPointerDown(e, key)}
                  onPointerMove={(e) => onWidgetPointerMove(e, key)}
                  onPointerUp={(e) => onWidgetPointerUp(e, key)}
                  onPointerCancel={() => {
                    dragStart.current = null
                    endDrag()
                  }}
                >
                  <button
                    className="widget-remove"
                    title={`Remove ${WIDGET_LABELS[key]}`}
                    tabIndex={editing ? 0 : -1}
                    aria-hidden={!editing}
                    style={editing ? { transitionDelay: `${Math.min(i, 5) * 22}ms` } : undefined}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeWidget(key)}
                  >
                    −
                  </button>
                  <div
                    className={`widget-inner ${editing && !dragging ? 'jiggle ambient' : ''}`}
                    style={editing && !dragging ? { animationDelay: `${(i % 3) * -0.14}s` } : undefined}
                  >
                    {inner}
                  </div>
                  {editing && selected === key && (
                    <div
                      className={`style-strip ${flip ? 'above' : ''}`}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <div className="strip-row">
                        {sizes.map((s) => (
                          <button
                            key={s.label}
                            className={`style-chip ${size.w === s.w && size.h === s.h ? 'on' : ''}`}
                            onClick={() => setSize(key, s)}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                      {styles && (
                        <div className="strip-row">
                          {styles.map((s) => (
                            <button
                              key={s.id}
                              className={`style-chip ${style === s.id ? 'on' : ''}`}
                              onClick={() => setStyle(key, s.id)}
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

          {HOME_WIDGETS && enabledKeys.length === 0 && editing && (
            <div className="grid-empty" style={{ top: padTop + 3 * cellH }}>
              A perfectly calm, blank page. Add something below.
            </div>
          )}

          {/* sits in the band it holds, rather than wherever the pane's middle
              happens to be — which is not the same place once edit mode has
              pulled the board in.

              It stays mounted and animates in and out: the widgets behind it
              never move, so putting it away really does just leave the home
              screen standing there. */}
          {searchPill && (
            <div
              className={`start-search ${showSearch ? 'on' : ''}`}
              style={{ top: pillTop, ...(pillWidth ? { width: pillWidth } : {}) }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
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
                tabIndex={showSearch ? 0 : -1}
                aria-hidden={!showSearch}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commit()
                    return
                  }
                  if (!sugs.length) return
                  // Arrow off the end of the list lands back on what you typed,
                  // which is the row Enter means when nothing is highlighted.
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setPick((p) => (p + 1 >= sugs.length ? -1 : p + 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setPick((p) => (p - 1 < -1 ? sugs.length - 1 : p - 1))
                  }
                }}
              />
              <span className="start-measure" ref={mirrorRef} aria-hidden="true">
                {text}
              </span>
              {sugs.length > 0 && (
                <div className="start-sugs" role="listbox">
                  {sugs.map((s, i) => (
                    <button
                      key={`${s.kind}:${s.url}:${i}`}
                      className={`start-sug ${i === pick ? 'on' : ''}`}
                      role="option"
                      aria-selected={i === pick}
                      // mousedown, not click: the input must not lose the cursor
                      // between pressing a row and the row being taken
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setText('')
                        setSugs([])
                        setPick(-1)
                        onSubmit(s.url || s.text)
                      }}
                      onMouseEnter={() => setPick(i)}
                    >
                      <span className="start-sug-text">{s.text}</span>
                      {s.title && <span className="start-sug-kind">{s.title}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* the tray is measured even when it has nothing in it — the board's bottom
          margin is derived from its height (see padBottom) */}
      <div className={`we-tray ${editing ? 'on' : ''}`} ref={trayRef} aria-hidden={!editing}>
        {HOME_WIDGETS &&
          (availableKeys.length > 0 ? (
            availableKeys.map((key) => (
              <button
                key={key}
                className="we-tray-add"
                tabIndex={editing ? 0 : -1}
                onClick={() => addWidget(key)}
              >
                <span className="we-tray-badge">+</span>
                {WIDGET_LABELS[key]}
              </button>
            ))
          ) : (
            <span className="we-tray-hint">Drag to move · tap a widget for its size and looks</span>
          ))}
      </div>

      {settings.appearance?.waves !== false &&
        (settings.appearance?.waveStyle === 'classic' ? (
          <ClassicWaves
            colors={[acc.waveA, acc.waveB, acc.waveC]}
            height={200}
            still={settings.appearance?.muted === true}
          />
        ) : (
          <DitheredWaves
            colors={[acc.waveA, acc.waveB, acc.waveC]}
            height={190}
            still={settings.appearance?.muted === true}
          />
        ))}
    </div>
  )
}
