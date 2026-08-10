import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { BriefWeather, NewTabWidgets, Settings } from '@shared/types'
import { DEFAULT_SETTINGS, resolveAccentColors, weatherCondition } from '@shared/types'
import { ClassicWaves } from '../theme/ClassicWaves'
import { moonPhase } from '../theme/moon'
import { DitheredWaves } from '../theme/DitheredWaves'
import { Weather } from '../theme/WeatherIcons'
import { useIsDark } from '../theme/useTheme'
import '../theme/theme.css'
import './start.css'

interface InternalApi {
  settings: { get(): Promise<Settings | null>; set(p: Partial<Settings>): Promise<Settings> }
  brief: { weather(): Promise<BriefWeather | null> }
  open(url: string): Promise<void>
  onEditWidgets?(cb: () => void): void
}

const internal = (window as unknown as { offshoreInternal?: InternalApi }).offshoreInternal

/** Each character keys on its value, so only changed digits roll in. */
function SlidingClock({ time }: { time: string }): React.JSX.Element {
  return (
    <div className="clock" aria-label={time}>
      {time.split('').map((ch, i) => (
        <span className="clock-ch" key={`${i}-${ch}`}>
          {ch === ' ' ? '\u00A0' : ch}
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

/** Single fetch shared by the weather + forecast widgets. */
function useWeather(enabled: boolean, hasLocation: boolean): BriefWeather | null {
  const [weather, setWeather] = useState<BriefWeather | null>(null)

  const refresh = useCallback(() => {
    void internal?.brief.weather().then(setWeather)
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

function WeatherNow({ weather }: { weather: BriefWeather }): React.JSX.Element {
  const cond = weatherCondition(weather.now.code)
  return (
    <div className="widget-weather">
      <span className="brief-icon">
        <Weather icon={cond.icon} isDay={weather.now.isDay} size={19} />
      </span>{' '}
      <strong>{weather.now.temp}°</strong> and {cond.label}
      <span className="brief-hilo">
        {'  '}H {weather.hi}° · L {weather.lo}°
      </span>
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

/**
 * Widget-based new tab: time and date by default, everything else opt-in.
 * Right-click → Edit Widgets (or press-and-hold the page) enters an
 * iOS-home-screen edit mode: widgets jiggle, − removes, drag reorders,
 * and a tray below offers the rest. No inputs here otherwise — typing
 * happens in the omnibox.
 */

const ALL_WIDGETS: (keyof NewTabWidgets)[] = ['clock', 'date', 'greeting', 'weather', 'forecast', 'sun', 'moon']

const WIDGET_LABELS: Record<keyof NewTabWidgets, string> = {
  clock: 'Time',
  date: 'Date',
  greeting: 'Greeting',
  weather: 'Weather',
  forecast: 'Hourly forecast',
  sun: 'Sunrise & sunset',
  moon: 'Moon phase'
}

function App(): React.JSX.Element {
  const [now, setNow] = useState(new Date())
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [editing, setEditing] = useState(false)
  const [dragKey, setDragKey] = useState<keyof NewTabWidgets | null>(null)
  const [previewOrder, setPreviewOrder] = useState<(keyof NewTabWidgets)[] | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDark = useIsDark()

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    void internal?.settings.get().then((s) => s && setSettings(s))
    internal?.onEditWidgets?.(() => setEditing(true))
  }, [])

  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') setEditing(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  const patch = (p: Partial<Settings>): void => {
    setSettings((prev) => ({ ...prev, ...p }))
    void internal?.settings.set(p)
  }

  const widgets: NewTabWidgets = settings.newTabWidgets ?? DEFAULT_SETTINGS.newTabWidgets
  const baseOrder = (settings.newTabWidgetOrder?.length ? settings.newTabWidgetOrder : ALL_WIDGETS).filter(
    (k) => ALL_WIDGETS.includes(k)
  )
  const fullOrder = [...baseOrder, ...ALL_WIDGETS.filter((k) => !baseOrder.includes(k))]
  const order = previewOrder ?? fullOrder
  const enabledKeys = order.filter((k) => widgets[k])
  const availableKeys = ALL_WIDGETS.filter((k) => !widgets[k])

  const hasLocation = settings.brief?.lat != null
  const wantsWeather = widgets.weather || widgets.forecast || widgets.sun
  const weather = useWeather(wantsWeather, hasLocation)

  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const date = now.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
  const acc = resolveAccentColors(settings.appearance ?? DEFAULT_SETTINGS.appearance, isDark)

  const renderWidget = (key: keyof NewTabWidgets): React.ReactNode => {
    switch (key) {
      case 'clock':
        return <SlidingClock time={time} />
      case 'date':
        return <div className="date">{date}</div>
      case 'greeting':
        return <div className="brief-line greet">{greeting(now.getHours())}.</div>
      case 'weather':
        return weather ? (
          <WeatherNow weather={weather} />
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
          <div className="widget-line dim">Sunrise & sunset</div>
        ) : null
      case 'moon':
        return (
          <div className="widget-line">
            {moonPhase(now).icon} {moonPhase(now).name}
          </div>
        )
    }
  }

  const commitOrder = (): void => {
    if (previewOrder) patch({ newTabWidgetOrder: previewOrder })
    setDragKey(null)
    setPreviewOrder(null)
  }

  const removeWidget = (key: keyof NewTabWidgets): void => {
    patch({ newTabWidgets: { ...widgets, [key]: false } })
  }

  const addWidget = (key: keyof NewTabWidgets): void => {
    patch({ newTabWidgets: { ...widgets, [key]: true } })
  }

  // iOS-style: press and hold empty space to start editing
  const startHold = (e: React.PointerEvent): void => {
    if (editing) return
    if ((e.target as HTMLElement).closest('.widget-slot, .we-done, .we-tray')) return
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
      className={`start ${editing ? 'editing' : ''}`}
      style={{
        background: `linear-gradient(180deg, ${acc.tintTop} 0%, ${acc.tintBottom} 100%)`
      }}
      onPointerDown={startHold}
      onPointerUp={cancelHold}
      onPointerMove={cancelHold}
      onPointerLeave={cancelHold}
    >
      {editing && (
        <button className="we-done" onClick={() => setEditing(false)}>
          Done
        </button>
      )}

      <div className="start-center">
        {enabledKeys.length === 0 && editing && (
          <div className="widget-line dim">A perfectly calm, blank page. Add something below.</div>
        )}
        {enabledKeys.map((key, i) => {
          const inner = renderWidget(key)
          if (!inner) return null
          return (
            <div
              key={key}
              className={`widget-slot ${editing ? 'jiggle' : ''} ${dragKey === key ? 'dragging' : ''}`}
              style={editing ? { animationDelay: `${(i % 3) * -0.09}s` } : undefined}
              draggable={editing}
              onDragStart={(e) => {
                setDragKey(key)
                setPreviewOrder(order)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (!dragKey || dragKey === key) return
                e.preventDefault()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                const before = e.clientY < rect.top + rect.height / 2
                setPreviewOrder((prev) => {
                  const cur = [...(prev ?? order)]
                  const from = cur.indexOf(dragKey)
                  let to = cur.indexOf(key)
                  if (from === -1 || to === -1) return cur
                  cur.splice(from, 1)
                  to = cur.indexOf(key)
                  cur.splice(before ? to : to + 1, 0, dragKey)
                  return cur
                })
              }}
              onDragEnd={commitOrder}
              onDrop={(e) => {
                e.preventDefault()
                commitOrder()
              }}
            >
              {editing && (
                <button className="widget-remove" title={`Remove ${WIDGET_LABELS[key]}`} onClick={() => removeWidget(key)}>
                  −
                </button>
              )}
              {inner}
            </div>
          )
        })}
      </div>

      {editing && availableKeys.length > 0 && (
        <div className="we-tray">
          {availableKeys.map((key) => (
            <button key={key} className="we-tray-add" onClick={() => addWidget(key)}>
              <span className="we-tray-badge">+</span>
              {WIDGET_LABELS[key]}
            </button>
          ))}
        </div>
      )}

      {settings.appearance?.waves !== false &&
        (settings.appearance?.waveStyle === 'classic' ? (
          <ClassicWaves colors={[acc.waveA, acc.waveB, acc.waveC]} height={200} />
        ) : (
          <DitheredWaves colors={[acc.waveA, acc.waveB, acc.waveC]} height={190} />
        ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
