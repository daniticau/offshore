/**
 * Shared cursor state for the interactive waves. The pointer shoves the water
 * around rather than merely bending it: a tight core is pushed down right under
 * the cursor, the displaced water piles into crests just either side, and
 * movement skews the whole thing — a bow wave ahead, a rippling wake behind.
 * Renderers read `current` every frame; values are already smoothed here so
 * both wave styles feel identical.
 */
export interface WaveCursor {
  /** cursor x relative to the host, px */
  x: number
  /** 0 = far away, 1 = at/inside the water */
  strength: number
  /** smoothed horizontal pointer velocity, px/s (signed) */
  vx: number
}

/**
 * Seconds on the page clock. Shared by every renderer so a remount (a colour
 * change, a resize, a parent re-render) resumes exactly where it left off
 * instead of snapping the drift back to zero.
 */
export const waveTime = (): number => performance.now() / 1000

export function trackWaveCursor(host: HTMLElement): { current: WaveCursor; detach: () => void } {
  const current: WaveCursor = { x: -10_000, strength: 0, vx: 0 }
  const target: WaveCursor = { x: -10_000, strength: 0, vx: 0 }
  let seeded = false
  let lastX = 0
  let lastT = 0
  let raf = 0

  const onMove = (e: MouseEvent): void => {
    const r = host.getBoundingClientRect()
    if (r.height === 0) return
    const x = e.clientX - r.left
    if (seeded && e.timeStamp > lastT) {
      const v = ((x - lastX) / (e.timeStamp - lastT)) * 1000
      target.vx = Math.max(-2200, Math.min(2200, v))
    } else {
      current.x = x
      seeded = true
    }
    lastX = x
    lastT = e.timeStamp
    target.x = x
    const d = e.clientY - r.top
    // approaching from above ramps in over ~120px; inside the water = full
    target.strength = d >= 0 ? 1 : Math.max(0, 1 + d / 120)
  }
  const onLeave = (): void => {
    target.strength = 0
    target.vx = 0
  }
  const tick = (): void => {
    // tight tracking: the disturbance sits on the cursor, not trailing it
    current.x += (target.x - current.x) * 0.4
    current.strength += (target.strength - current.strength) * 0.16
    current.vx += (target.vx - current.vx) * 0.25
    target.vx *= 0.9 // momentum bleeds off once the pointer stops
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
 * Surface displacement under the cursor, in the same units as `depth` (+y is
 * down, so a positive result digs the water down). `radius` is the core width
 * in px; the kernel has compact support at ~3.5x that, so there is no wide
 * soft halo — the effect stays local to the pointer.
 */
export function disturbAt(
  x: number,
  cursor: WaveCursor,
  depth: number,
  radius: number,
  tSec: number
): number {
  const s = cursor.strength
  if (s <= 0.001) return 0
  const r = (x - cursor.x) / radius
  if (r < -3.5 || r > 3.5) return 0
  const g = Math.exp(-1.7 * r * r)
  // Mexican hat: a dip in the core, water piled into crests at |r| ~ 1
  const core = (1 - 1.55 * r * r) * g
  // sweeping the pointer pushes a bow wave ahead and hollows out behind it
  const push = Math.max(-1, Math.min(1, cursor.vx / 900))
  const bow = -1.5 * r * g * push
  // ripples riding out of the wake, fading as the pointer settles
  const wake = Math.sin(5.2 * r - tSec * 6.5) * g * Math.abs(push) * 0.32
  return s * depth * (core + bow + wake)
}

export const REDUCED_MOTION = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
