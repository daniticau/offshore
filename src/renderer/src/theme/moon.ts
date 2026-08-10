/** Synodic month phase, pure local math — no network, obviously no AI. */
export function moonPhase(date: Date): { name: string; icon: string } {
  const synodic = 29.53058867
  const known = Date.UTC(2000, 0, 6, 18, 14) // a known new moon
  const days = (date.getTime() - known) / 86_400_000
  const phase = (((days % synodic) + synodic) % synodic) / synodic
  if (phase < 0.033 || phase > 0.967) return { name: 'New moon', icon: '🌑' }
  if (phase < 0.216) return { name: 'Waxing crescent', icon: '🌒' }
  if (phase < 0.283) return { name: 'First quarter', icon: '🌓' }
  if (phase < 0.467) return { name: 'Waxing gibbous', icon: '🌔' }
  if (phase < 0.533) return { name: 'Full moon', icon: '🌕' }
  if (phase < 0.717) return { name: 'Waning gibbous', icon: '🌖' }
  if (phase < 0.783) return { name: 'Last quarter', icon: '🌗' }
  return { name: 'Waning crescent', icon: '🌘' }
}

/** "America/New_York" → "New York": the city your Mac already believes in. */
export function timezoneCity(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const city = tz.split('/').pop()?.replace(/_/g, ' ')
    return city && city.length > 1 ? city : null
  } catch {
    return null
  }
}
