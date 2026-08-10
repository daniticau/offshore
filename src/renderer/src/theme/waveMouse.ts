/**
 * Shared cursor state for the interactive waves. The water parts away from
 * the pointer: each layer carves a smooth trough centered under the cursor,
 * strongest when the cursor is at (or in) the water, easing out above it.
 * Renderers read `current` every frame; values are already smoothed here so
 * both wave styles feel identical.
 */
export interface WaveCursor {
  /** cursor x relative to the host, px */
  x: number
  /** 0 = far away, 1 = at/inside the water */
  strength: number
}

export function trackWaveCursor(host: HTMLElement): { current: WaveCursor; detach: () => void } {
  const current: WaveCursor = { x: -10_000, strength: 0 }
  const target: WaveCursor = { x: -10_000, strength: 0 }
  let raf = 0

  const onMove = (e: MouseEvent): void => {
    const r = host.getBoundingClientRect()
    if (r.height === 0) return
    target.x = e.clientX - r.left
    const d = e.clientY - r.top
    // approaching from above ramps in over ~220px; inside the water = full
    target.strength = d >= 0 ? 1 : Math.max(0, 1 + d / 220)
  }
  const onLeave = (): void => {
    target.strength = 0
  }
  const tick = (): void => {
    current.x += (target.x - current.x) * 0.18
    current.strength += (target.strength - current.strength) * 0.08
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

/** The trough: a smooth dip of `depth` px centered at `cx`, ~`sigma` px wide. */
export function troughAt(x: number, cursor: WaveCursor, depth: number, sigma: number): number {
  if (cursor.strength <= 0.001) return 0
  const dx = (x - cursor.x) / sigma
  return cursor.strength * depth * Math.exp(-dx * dx)
}

export const REDUCED_MOTION = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
