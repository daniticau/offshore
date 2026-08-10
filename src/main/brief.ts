import { app, net } from 'electron'
import type { BriefWeather, GeocodeResult } from '@shared/types'
import { JsonFile, settingsStore } from './stores'

/**
 * Weather brief: fetched directly from Open-Meteo (no API key, no account),
 * cached in memory + on disk so the start page paints instantly and degrades
 * gracefully offline. Location only ever comes from the user typing a city.
 * Zero AI, by principle.
 */

const TTL = 15 * 60 * 1000
const FAHRENHEIT_COUNTRIES = new Set(['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW'])

interface BriefCache {
  key: string
  weather: BriefWeather | null
}

let memory: BriefCache | null = null
let disk: JsonFile<BriefCache> | null = null

function diskCache(): JsonFile<BriefCache> {
  if (!disk) disk = new JsonFile<BriefCache>('brief-cache.json', { key: '', weather: null })
  return disk
}

function resolveUnit(pref: 'auto' | 'c' | 'f'): 'c' | 'f' {
  if (pref !== 'auto') return pref
  try {
    return FAHRENHEIT_COUNTRIES.has(app.getLocaleCountryCode()) ? 'f' : 'c'
  } catch {
    return 'c'
  }
}

function fmtSunTime(iso?: string): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (isNaN(d.getTime())) return undefined
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export async function fetchWeather(): Promise<BriefWeather | null> {
  const brief = settingsStore.get().brief
  if (!brief.enabled || brief.lat == null || brief.lon == null) return null
  const unit = resolveUnit(brief.unit)
  const key = `${brief.lat.toFixed(2)},${brief.lon.toFixed(2)},${unit}`

  const fresh = (c: BriefCache | null): BriefWeather | null =>
    c && c.key === key && c.weather && Date.now() - c.weather.fetchedAt < TTL ? c.weather : null

  const cached = fresh(memory) ?? fresh(diskCache().data)
  if (cached) return cached

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${brief.lat}&longitude=${brief.lon}` +
      `&current=temperature_2m,weather_code,is_day` +
      `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset` +
      `&hourly=temperature_2m,weather_code,is_day` +
      `&forecast_days=2&timezone=auto` +
      `&temperature_unit=${unit === 'f' ? 'fahrenheit' : 'celsius'}`
    const res = await net.fetch(url)
    if (!res.ok) throw new Error(`weather http ${res.status}`)
    const j = (await res.json()) as {
      current: { temperature_2m: number; weather_code: number; is_day: number; time: string }
      daily: {
        temperature_2m_max: number[]
        temperature_2m_min: number[]
        sunrise?: string[]
        sunset?: string[]
      }
      hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; is_day: number[] }
    }
    const nowIdx = j.hourly.time.findIndex((t) => t >= j.current.time)
    const hours = []
    for (let i = Math.max(0, nowIdx); i < j.hourly.time.length && hours.length < 6; i++) {
      hours.push({
        hour: j.hourly.time[i].slice(11, 16),
        temp: Math.round(j.hourly.temperature_2m[i]),
        code: j.hourly.weather_code[i],
        isDay: j.hourly.is_day[i] === 1
      })
    }
    const weather: BriefWeather = {
      location: brief.locationName,
      unit,
      now: {
        temp: Math.round(j.current.temperature_2m),
        code: j.current.weather_code,
        isDay: j.current.is_day === 1
      },
      hi: Math.round(j.daily.temperature_2m_max[0]),
      lo: Math.round(j.daily.temperature_2m_min[0]),
      hours,
      sunrise: fmtSunTime(j.daily.sunrise?.[0]),
      sunset: fmtSunTime(j.daily.sunset?.[0]),
      fetchedAt: Date.now()
    }
    memory = { key, weather }
    diskCache().data = { key, weather }
    diskCache().save()
    return weather
  } catch (err) {
    console.warn('[brief] weather fetch failed:', err)
    // Serve stale cache of any age rather than an error state
    const stale = memory?.key === key ? memory.weather : diskCache().data.key === key ? diskCache().data.weather : null
    return stale ?? null
  }
}

export async function geocode(query: string): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (q.length < 2) return []
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`
    const res = await net.fetch(url)
    if (!res.ok) return []
    const j = (await res.json()) as {
      results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[]
    }
    return (j.results ?? []).map((r) => ({
      name: r.name,
      admin1: r.admin1,
      country: r.country,
      lat: r.latitude,
      lon: r.longitude
    }))
  } catch {
    return []
  }
}
