import React, { useEffect, useRef } from 'react'
import { liftAt, REDUCED_MOTION, swirlAt, trackWaveCursor, waveTime } from './waveMouse'

/**
 * Chunky retro waves, now fully live: three bands rendered every frame on one
 * small canvas (Bayer-dithered, pixelated upscale). All bands drift the same
 * direction at different speeds, deeper water darker and denser — and the
 * cursor rides in the water like an object, each band shoved radially aside
 * around it and piled into a soft rim (front band most).
 * Everything is deterministic math; with reduced motion it renders once.
 */

const CELL = 4
/** cursor influence radius, screen px */
const CURSOR_R = 66
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
]

function parseRgba(rgba: string): [number, number, number, number] {
  const m = rgba.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
  if (m) return [+m[1], +m[2], +m[3], m[4] ? +m[4] : 1]
  const hex = rgba.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const v = parseInt(hex[1], 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1]
  }
  return [100, 180, 220, 0.4]
}

interface Band {
  rgba: [number, number, number, number]
  foamRgb: [number, number, number]
  base: number
  harmonics: { k: number; amp: number; phase: number }[]
  /** drift speed, cells per second (same sign = same direction) */
  speed: number
  /** how hard the cursor shoves this band aside; 1 = full */
  push: number
  /** height of the rim piled around the cursor, cells */
  rim: number
  foam: boolean
}

function buildBands(colors: [string, string, string], H: number): Band[] {
  const defs = [
    {
      color: colors[0],
      base: 0.38,
      speed: 2.2,
      push: 0.5,
      rim: H * 0.03,
      foam: false,
      harmonics: [
        { k: 2, amp: 0.095, phase: 0.6 },
        { k: 5, amp: 0.038, phase: 2.9 },
        { k: 11, amp: 0.014, phase: 4.4 }
      ]
    },
    {
      color: colors[1],
      base: 0.56,
      speed: 3.6,
      push: 0.8,
      rim: H * 0.045,
      foam: true,
      harmonics: [
        { k: 3, amp: 0.105, phase: 2.4 },
        { k: 7, amp: 0.042, phase: 0.8 },
        { k: 13, amp: 0.016, phase: 3.6 }
      ]
    },
    {
      color: colors[2],
      base: 0.73,
      speed: 5.4,
      push: 1.15,
      rim: H * 0.062,
      foam: true,
      harmonics: [
        { k: 4, amp: 0.09, phase: 4.1 },
        { k: 9, amp: 0.04, phase: 1.7 },
        { k: 17, amp: 0.015, phase: 5.2 }
      ]
    }
  ]
  return defs.map((d) => {
    const rgba = parseRgba(d.color)
    return {
      rgba,
      foamRgb: [
        rgba[0] + (255 - rgba[0]) * 0.72,
        rgba[1] + (255 - rgba[1]) * 0.72,
        rgba[2] + (255 - rgba[2]) * 0.72
      ] as [number, number, number],
      base: d.base * H,
      harmonics: d.harmonics.map((h) => ({ k: h.k, amp: h.amp * H, phase: h.phase })),
      speed: d.speed,
      push: d.push,
      rim: d.rim,
      foam: d.foam
    }
  })
}

export interface DitheredWavesProps {
  /** back / mid / front band colors (rgba() or #hex strings) */
  colors: [string, string, string]
  /** rendered height in css px */
  height?: number
  className?: string
}

export function DitheredWaves({ colors, height = 190, className }: DitheredWavesProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // keyed on the colour *values*, not the array identity: callers pass a fresh
  // literal every render, and restarting the animation on each one is what made
  // the drift visibly hitch
  const colorKey = colors.join('|')

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let W = 0
    let H = 0
    let bands: Band[] = []
    let img: ImageData | null = null

    const resize = (): void => {
      W = Math.max(60, Math.ceil((host.clientWidth || 800) / CELL))
      H = Math.max(12, Math.round(height / CELL))
      canvas.width = W
      canvas.height = H
      bands = buildBands(colorKey.split('|') as [string, string, string], H)
      img = ctx.createImageData(W, H)
    }
    resize()

    const cursor = trackWaveCursor(host)
    const reduced = REDUCED_MOTION()

    const draw = (tSec: number): void => {
      if (!img) return
      img.data.fill(0)
      const soft = Math.max(2, Math.round(H * 0.06))
      for (const band of bands) {
        const [r, g, b, a] = band.rgba
        const [fr, fg, fb] = band.foamRgb
        // wrapped at the pattern's own period: same water, small numbers (the
        // clock is the wall clock, so the raw product is enormous)
        const drift = (tSec * band.speed) % W
        for (let x = 0; x < W; x++) {
          // sample the surface in drifting pattern space; the cursor lives in
          // screen px, so the water is shoved aside around the pointer
          const sx = x * CELL
          const px = x + drift + swirlAt(sx, cursor.current, CURSOR_R, band.push) / CELL
          let y0 = band.base
          for (const h of band.harmonics) {
            y0 += h.amp * Math.sin((2 * Math.PI * h.k * px) / W + h.phase)
          }
          y0 += liftAt(sx, cursor.current, band.rim, CURSOR_R)
          for (let y = 0; y < H; y++) {
            const d = y - y0
            const threshold = (BAYER[y % 4][x % 4] + 0.5) / 16
            const i = (y * W + x) * 4
            if (band.foam && d < -soft * 0.4 && d > -soft * 2.6) {
              const center = -soft * 1.5
              const spread = soft * 1.1
              const cover = Math.max(0, 1 - Math.abs(d - center) / spread) * 0.42
              if (cover >= threshold) {
                const da = img.data[i + 3] / 255
                const pa = Math.min(1, a * 0.85)
                const oa = pa + da * (1 - pa)
                img.data[i] = (fr * pa + img.data[i] * da * (1 - pa)) / (oa || 1)
                img.data[i + 1] = (fg * pa + img.data[i + 1] * da * (1 - pa)) / (oa || 1)
                img.data[i + 2] = (fb * pa + img.data[i + 2] * da * (1 - pa)) / (oa || 1)
                img.data[i + 3] = oa * 255
              }
              continue
            }
            const cover = d > soft ? 1 : d < -soft ? 0 : (d + soft) / (soft * 2)
            if (cover <= 0) continue
            if (cover < 1 && cover < threshold) continue
            const depth = Math.min(1, Math.max(0, (y - y0) / Math.max(1, H - y0)))
            const pa = Math.min(1, a * (0.82 + 0.3 * depth))
            const da = img.data[i + 3] / 255
            const oa = pa + da * (1 - pa)
            img.data[i] = (r * pa + img.data[i] * da * (1 - pa)) / (oa || 1)
            img.data[i + 1] = (g * pa + img.data[i + 1] * da * (1 - pa)) / (oa || 1)
            img.data[i + 2] = (b * pa + img.data[i + 2] * da * (1 - pa)) / (oa || 1)
            img.data[i + 3] = oa * 255
          }
        }
      }
      ctx.putImageData(img, 0, 0)
    }

    let raf = 0
    const loop = (): void => {
      // page clock, not a per-mount origin — the phase survives a remount
      if (document.visibilityState === 'visible') draw(waveTime())
      raf = requestAnimationFrame(loop)
    }
    if (reduced) {
      draw(waveTime())
    } else {
      raf = requestAnimationFrame(loop)
    }

    const ro = new ResizeObserver(() => {
      resize()
      if (reduced) draw(waveTime())
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      cursor.detach()
      cancelAnimationFrame(raf)
    }
  }, [colorKey, height])

  return (
    <div ref={hostRef} className={`waves-host ${className ?? ''}`} style={{ height }} aria-hidden>
      <canvas ref={canvasRef} className="waves-canvas" />
    </div>
  )
}
