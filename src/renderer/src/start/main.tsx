import React, { useCallback, useEffect, useState } from 'react'
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
 * Widget-based new tab: time and date by default, everything else opt-in from
 * onboarding or Settings. No inputs here, ever — typing happens in the omnibox.
 */
function App(): React.JSX.Element {
  const [now, setNow] = useState(new Date())
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const isDark = useIsDark()

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    void internal?.settings.get().then((s) => s && setSettings(s))
  }, [])

  const widgets: NewTabWidgets = settings.newTabWidgets ?? DEFAULT_SETTINGS.newTabWidgets
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

  return (
    <div
      className="start"
      style={{
        background: `linear-gradient(180deg, ${acc.tintTop} 0%, ${acc.tintBottom} 100%)`
      }}
    >
      <div className="start-center">
        {widgets.clock && <SlidingClock time={time} />}
        {widgets.date && <div className="date">{date}</div>}
        {widgets.greeting && <div className="brief-line greet">{greeting(now.getHours())}.</div>}
        {widgets.weather && weather && <WeatherNow weather={weather} />}
        {widgets.forecast && weather && <ForecastHours weather={weather} />}
        {widgets.sun && weather?.sunrise && weather?.sunset && (
          <div className="widget-line">
            ☀️ {weather.sunrise} → 🌙 {weather.sunset}
          </div>
        )}
        {widgets.moon && (
          <div className="widget-line">
            {moonPhase(now).icon} {moonPhase(now).name}
          </div>
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

createRoot(document.getElementById('root')!).render(<App />)
