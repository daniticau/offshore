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
export interface WaveCursor {
  /** cursor x relative to the host, px */
  x: number
  /** 0 = far away, 1 = at/inside the water */
  strength: number
}

/**
 * The instant the still water is drawn at — one agreed frame of the one ocean.
 * Not the wall clock: a fixed instant means every window, tab and screenshot
 * shows the identical frame, and the appearance flow's frame-hash assertion
 * has a stable target.
 */
export const WAVE_STILL_TIME = 0

/** A cursor that was never in the water — what a stilled renderer reads. */
export const DEAD_CURSOR: WaveCursor = { x: -10_000, strength: 0 }

/**
 * The water is one ocean, and every screen showing it is a window onto the same
 * one — so the clock behind it is the wall clock, not the page's own.
 *
 * `performance.now()` counts from whenever *this document* started, which makes
 * every new tab start its swell from zero: flick between two of them and the
 * waves jump, because they are two different oceans an hour apart. Reading the
 * wall clock instead means a tab opened now and one opened this morning are
 * drawing the same instant of the same water, and switching between them shows
 * no seam at all. It still survives a remount, which is what the page clock was
 * for: `timeOrigin + now()` is the same number either side of it.
 *
 * The epoch keeps the figure small enough that a float still has room for the
 * fraction of a second the drift is actually made of.
 */
const WAVE_EPOCH = Date.UTC(2026, 0, 1)

export const waveTime = (): number =>
  (performance.timeOrigin + performance.now() - WAVE_EPOCH) / 1000

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
