/**
 * Shared cursor state for the interactive waves. The pointer behaves like an
 * object sitting in the water: it shoves the surface radially outward — the
 * swell stretches away on both sides and piles into a soft rim — rather than
 * denting the water downward. The displacement depends only on where the
 * cursor is, never on how fast it moves, so sweeping side to side slides the
 * same shape along instead of bobbing the water level.
 * Renderers read `current` every frame; values are already smoothed here so
 * both wave styles feel identical.
 */
interface WaveCursor {
  /** cursor x relative to the host, px */
  x: number
  /** 0 = far away, 1 = at/inside the water */
  strength: number
}

/**
 * Seconds on the page clock. Shared by every renderer so a remount (a colour
 * change, a resize, a parent re-render) resumes exactly where it left off
 * instead of snapping the drift back to zero.
 */
export const waveTime = (): number => performance.now() / 1000

export function trackWaveCursor(host: HTMLElement): { current: WaveCursor; detach: () => void } {
  const current: WaveCursor = { x: -10_000, strength: 0 }
  const target: WaveCursor = { x: -10_000, strength: 0 }
  let seeded = false
  let raf = 0

  const onMove = (e: MouseEvent): void => {
    const r = host.getBoundingClientRect()
    if (r.height === 0) return
    const x = e.clientX - r.left
    if (!seeded) {
      current.x = x
      seeded = true
    }
    target.x = x
    const d = e.clientY - r.top
    // approaching from above ramps in over ~120px; inside the water = full
    target.strength = d >= 0 ? 1 : Math.max(0, 1 + d / 120)
  }
  const onLeave = (): void => {
    target.strength = 0
  }
  const tick = (): void => {
    // tight tracking: the disturbance sits on the cursor, not trailing it
    current.x += (target.x - current.x) * 0.4
    current.strength += (target.strength - current.strength) * 0.16
    raf = requestAnimationFrame(tick)
  }

  window.addEventListener('mousemove', onMove)
  document.documentElement.addEventListener('mouseleave', onLeave)
  raf = requestAnimationFrame(tick)
  return {
    current,
    detach: () => {
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      cancelAnimationFrame(raf)
    }
  }
}

/**
 * Horizontal shove, px. The surface pattern is sampled at `x + swirlAt(x)`, so
 * the water flows radially away from the pointer on both sides — crests stretch
 * and lean around it the way they would around something actually sitting in
 * the swell. Odd in (x - cursor.x), so it never raises or lowers the water
 * level; `radius` sets the core width and the kernel dies out by ~3x that.
 */
export function swirlAt(x: number, cursor: WaveCursor, radius: number, scale = 1): number {
  const s = cursor.strength
  if (s <= 0.001) return 0
  const r = (x - cursor.x) / radius
  if (r < -3 || r > 3) return 0
  // capped below 1: at 1 the shove cancels dx/dx and the surface folds over
  const k = Math.min(0.72, 0.5 * scale)
  return -s * k * radius * r * Math.exp(-1.1 * r * r)
}

/**
 * The rim of water the pointer pushes up around itself, in the same units as
 * `amount` (+y is down, so this returns negative — the surface lifts). Zero at
 * the cursor and zero far away: a ring, not a dent.
 */
export function liftAt(x: number, cursor: WaveCursor, amount: number, radius: number): number {
  const s = cursor.strength
  if (s <= 0.001) return 0
  const r = (x - cursor.x) / radius
  if (r < -3 || r > 3) return 0
  // peaks at |r| ~ 0.79, normalised so the crest reaches exactly `amount`
  return -s * amount * 4.35 * r * r * Math.exp(-1.6 * r * r)
}

export const REDUCED_MOTION = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
