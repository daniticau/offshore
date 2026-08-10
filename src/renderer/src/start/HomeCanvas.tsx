import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BriefWeather, NewTabWidgets, Settings, WidgetAlign, WidgetLayout } from '@shared/types'
import { DEFAULT_SETTINGS, resolveAccentColors, weatherCondition } from '@shared/types'
import { ClassicWaves } from '../theme/ClassicWaves'
import { moonPhase } from '../theme/moon'
import { DitheredWaves } from '../theme/DitheredWaves'
import { Weather } from '../theme/WeatherIcons'
import { useIsDark } from '../theme/useTheme'
import '../theme/theme.css'
import './start.css'

export type WidgetKey = keyof NewTabWidgets

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

/** Looks each widget can wear, chosen from its own strip in edit mode. */
const WIDGET_STYLES: Partial<Record<WidgetKey, { id: string; label: string }[]>> = {
  clock: [
    { id: 'serif', label: 'Serif' },
    { id: 'light', label: 'Light' },
    { id: 'mono', label: 'Mono' },
    { id: 'small', label: 'Small' }
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

export interface HomeCanvasProps {
  settings: Settings
  /** Persist a settings change — the caller owns the copy it renders from. */
  onPatch(patch: Partial<Settings>): void
  /** A query or URL was committed in the search pill. */
  onSubmit(input: string): void
  fetchWeather(): Promise<BriefWeather | null>
  /** Bump to enter widget edit mode from outside (context menu, menu bar). */
  editSignal?: number
  autoFocus?: boolean
  className?: string
}

/**
 * Offshore's home surface. A new tab and a window with no tabs are the same
 * screen, so they are the same component, reading the same widget settings —
 * edit the widgets on either and both change.
 *
 * The search pill is pinned to the middle of the pane and the widgets are
 * centred in the space above it, so they drift upward as you add more instead
 * of crowding the pill. Right-click → Edit Widgets (or press and hold) enters
 * iPhone-home-screen edit mode: widgets jiggle, − removes, drag moves and
 * reorders, and each offers its own looks. The pill steps back — dimmed and
 * inert — while editing, so it is never in the way of a drag.
 */
export function HomeCanvas({
  settings,
  onPatch: patch,
  onSubmit,
  fetchWeather,
  editSignal = 0,
  autoFocus = false,
  className = ''
}: HomeCanvasProps): React.JSX.Element {
  const [now, setNow] = useState(new Date())
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<WidgetKey | null>(null)
  const [drag, setDrag] = useState<{ key: WidgetKey; dx: number; dy: number } | null>(null)
  const [previewOrder, setPreviewOrder] = useState<WidgetKey[] | null>(null)
  const [previewAlign, setPreviewAlign] = useState<WidgetAlign | null>(null)
  const [text, setText] = useState('')
  const [pillWidth, setPillWidth] = useState<number | null>(null)

  const hostRef = useRef<HTMLDivElement>(null)
  const centerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLSpanElement>(null)
  const slotRefs = useRef<Map<WidgetKey, HTMLElement>>(new Map())
  const dragStart = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDark = useIsDark()

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (editSignal > 0) setEditing(true)
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
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const submit = (): void => {
    const q = text.trim()
    if (!q) return
    setText('')
    onSubmit(q)
  }

  const widgets: NewTabWidgets = settings.newTabWidgets ?? DEFAULT_SETTINGS.newTabWidgets
  const layout = settings.newTabWidgetLayout ?? {}
  const baseOrder = (settings.newTabWidgetOrder?.length ? settings.newTabWidgetOrder : ALL_WIDGETS).filter((k) =>
    ALL_WIDGETS.includes(k)
  )
  const fullOrder: WidgetKey[] = [...baseOrder, ...ALL_WIDGETS.filter((k) => !baseOrder.includes(k))]
  const order = previewOrder ?? fullOrder
  const enabledKeys = order.filter((k) => widgets[k])
  const availableKeys = ALL_WIDGETS.filter((k) => !widgets[k])

  const layoutFor = (key: WidgetKey): WidgetLayout => ({
    align: layout[key]?.align ?? 'center',
    style: layout[key]?.style ?? DEFAULT_STYLE[key]
  })

  const hasLocation = settings.brief?.lat != null
  const wantsWeather = widgets.weather || widgets.forecast || widgets.sun
  const weather = useWeather(wantsWeather, hasLocation, fetchWeather)

  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const acc = resolveAccentColors(settings.appearance ?? DEFAULT_SETTINGS.appearance, isDark)

  const dateText = (style: string): string => {
    if (style === 'short') return now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    if (style === 'numeric') return now.toLocaleDateString()
    return now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  }

  const renderWidget = (key: WidgetKey, style: string): React.ReactNode => {
    switch (key) {
      case 'clock':
        return <SlidingClock time={time} className={`clock-${style}`} />
      case 'date':
        return <div className="date">{dateText(style)}</div>
      case 'greeting':
        return <div className={style === 'plain' ? 'greet-plain' : 'brief-line greet'}>{greeting(now.getHours())}.</div>
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

  // ---- pointer drag: vertical position reorders, horizontal places ----

  const onWidgetPointerDown = (e: React.PointerEvent, key: WidgetKey): void => {
    if (!editing) return
    if ((e.target as HTMLElement).closest('.widget-remove, .style-strip')) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragStart.current = { x: e.clientX, y: e.clientY, moved: false }
    setDrag({ key, dx: 0, dy: 0 })
    setPreviewOrder(order)
    setPreviewAlign(layoutFor(key).align)
  }

  const onWidgetPointerMove = (e: React.PointerEvent, key: WidgetKey): void => {
    const start = dragStart.current
    if (!start || !drag || drag.key !== key) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!start.moved && Math.hypot(dx, dy) > 4) start.moved = true
    setDrag({ key, dx, dy })

    // horizontal thirds of the row decide where the widget lives
    const rect = centerRef.current?.getBoundingClientRect()
    if (rect && rect.width > 0) {
      const t = (e.clientX - rect.left) / rect.width
      setPreviewAlign(t < 0.34 ? 'left' : t > 0.66 ? 'right' : 'center')
    }

    // insertion point = how many other widgets sit above the pointer
    const others = enabledKeys.filter((k) => k !== key)
    let insertAt = 0
    for (const k of others) {
      const el = slotRefs.current.get(k)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (e.clientY > r.top + r.height / 2) insertAt++
    }
    const next = [...others]
    next.splice(insertAt, 0, key)
    setPreviewOrder([...next, ...fullOrder.filter((k) => !next.includes(k))])
  }

  const endDrag = (): void => {
    setDrag(null)
    setPreviewOrder(null)
    setPreviewAlign(null)
  }

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
      // a tap, not a drag: open this widget's style strip
      setSelected((prev) => (prev === key ? null : key))
      endDrag()
      return
    }
    patch({
      newTabWidgetOrder: previewOrder ?? fullOrder,
      newTabWidgetLayout: {
        ...layout,
        [key]: { ...layoutFor(key), align: previewAlign ?? layoutFor(key).align }
      }
    })
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
    patch({ newTabWidgetLayout: { ...layout, [key]: { ...layoutFor(key), style } } })
  }

  // press and hold empty space to start editing, like the home screen
  const startHold = (e: React.PointerEvent): void => {
    if (editing) return
    if ((e.target as HTMLElement).closest('.widget-slot, .start-search, .we-done, .we-tray')) return
    holdTimer.current = setTimeout(() => setEditing(true), 550)
  }
  const cancelHold = (): void => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }

  return (
    <div
      ref={hostRef}
      className={`start ${editing ? 'editing' : ''} ${className}`}
      style={{ background: `linear-gradient(180deg, ${acc.tintTop} 0%, ${acc.tintBottom} 100%)` }}
      onPointerDown={startHold}
      onPointerUp={cancelHold}
      onPointerMove={cancelHold}
      onPointerLeave={cancelHold}
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
        <div className="start-center" ref={centerRef}>
          {enabledKeys.length === 0 && editing && (
            <div className="widget-line dim">A perfectly calm, blank page. Add something below.</div>
          )}
          {enabledKeys.map((key, i) => {
            const conf = layoutFor(key)
            const align = drag?.key === key && previewAlign ? previewAlign : conf.align
            const style = conf.style ?? DEFAULT_STYLE[key]
            const inner = renderWidget(key, style)
            if (!inner) return null
            const dragging = drag?.key === key
            const styles = WIDGET_STYLES[key]
            return (
              <div
                key={key}
                ref={(el) => {
                  if (el) slotRefs.current.set(key, el)
                  else slotRefs.current.delete(key)
                }}
                className={`widget-slot align-${align} ${editing ? 'editable' : ''} ${dragging ? 'dragging' : ''} ${
                  selected === key ? 'selected' : ''
                }`}
                style={dragging ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, zIndex: 5 } : undefined}
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
                  className={`widget-inner ${editing && !dragging ? 'jiggle' : ''}`}
                  style={editing && !dragging ? { animationDelay: `${(i % 3) * -0.14}s` } : undefined}
                >
                  {inner}
                </div>
                {editing && selected === key && styles && (
                  <div className="style-strip" onPointerDown={(e) => e.stopPropagation()}>
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
            )
          })}
        </div>

        <div className="start-search" style={pillWidth ? { width: pillWidth } : undefined}>
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
            tabIndex={editing ? -1 : 0}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <span className="start-measure" ref={mirrorRef} aria-hidden="true">
            {text}
          </span>
        </div>
      </div>

      <div className={`we-tray ${editing ? 'on' : ''}`} aria-hidden={!editing}>
        {availableKeys.length > 0 ? (
          availableKeys.map((key) => (
            <button key={key} className="we-tray-add" tabIndex={editing ? 0 : -1} onClick={() => addWidget(key)}>
              <span className="we-tray-badge">+</span>
              {WIDGET_LABELS[key]}
            </button>
          ))
        ) : (
          <span className="we-tray-hint">Drag to move · tap a widget for its styles</span>
        )}
      </div>

      {settings.appearance?.waves !== false &&
        (settings.appearance?.waveStyle === 'classic' ? (
          <ClassicWaves colors={[acc.waveA, acc.waveB, acc.waveC]} height={200} />
        ) : (
          <DitheredWaves colors={[acc.waveA, acc.waveB, acc.waveC]} height={190} />
        ))}
    </div>
  )
}
