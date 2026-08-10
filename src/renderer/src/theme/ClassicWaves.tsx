import React, { useEffect, useMemo, useRef } from 'react'
import { disturbAt, REDUCED_MOTION, trackWaveCursor, waveTime } from './waveMouse'

/**
 * Layered, near-realistic ocean swell in pure SVG — and alive: five depth
 * layers, each an organic sum-of-sines surface with a vertical gradient and a
 * foam stroke on the near water. Every layer drifts the same direction at its
 * own speed (far water slower), and the water shoves aside under the cursor —
 * a tight dip with crests piled either side, skewed into a bow wave and wake
 * when the pointer sweeps, deepest on the front layer.
 * Paths are recomputed per frame; with reduced motion it renders once.
 */

const PERIOD = 720
const VIEW_W = PERIOD * 2
const HEIGHT = 240
/** dense enough to resolve the tight cursor disturbance without faceting */
const SAMPLES = 240

interface Harmonic {
  k: number
  amp: number
  phase: number
}

function parseColor(c: string): [number, number, number, number] {
  const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
  if (m) return [+m[1], +m[2], +m[3], m[4] ? +m[4] : 1]
  const hex = c.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const v = parseInt(hex[1], 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1]
  }
  return [90, 160, 200, 0.4]
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a.toFixed(3)})`
}

function mix(
  c1: [number, number, number, number],
  c2: [number, number, number, number],
  t: number
): [number, number, number, number] {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t,
    c1[3] + (c2[3] - c1[3]) * t
  ]
}

interface LayerSpec {
  base: number
  harmonics: Harmonic[]
  color: [number, number, number, number]
  /** drift speed in viewBox px/s; same sign everywhere = one direction */
  speed: number
  /** cursor trough depth in viewBox px */
  trough: number
  foam: boolean
}

export interface ClassicWavesProps {
  /** back / mid / front water colors (rgba() or #hex) */
  colors: [string, string, string]
  height?: number
}

export function ClassicWaves({ colors, height = 200 }: ClassicWavesProps): React.JSX.Element {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '')
  const hostRef = useRef<HTMLDivElement>(null)
  const fillRefs = useRef<(SVGPathElement | null)[]>([])
  const foamRefs = useRef<(SVGPathElement | null)[]>([])

  // keyed on the colour *values*, not the array identity: callers pass a fresh
  // literal every render, and restarting the animation on each one is what made
  // the drift visibly hitch
  const colorKey = colors.join('|')
  const layers = useMemo<LayerSpec[]>(() => {
    const [ca, cb, cc] = colorKey.split('|')
    const a = parseColor(ca)
    const b = parseColor(cb)
    const c = parseColor(cc)
    return [
      {
        base: 96,
        harmonics: [
          { k: 1, amp: 10, phase: 0.4 },
          { k: 2, amp: 5, phase: 2.1 },
          { k: 5, amp: 2, phase: 4.6 }
        ],
        color: mix(a, b, -0.35),
        speed: 9,
        trough: 11,
        foam: false
      },
      {
        base: 118,
        harmonics: [
          { k: 1, amp: 12, phase: 3.2 },
          { k: 3, amp: 6, phase: 0.9 },
          { k: 6, amp: 2.4, phase: 2.8 }
        ],
        color: a,
        speed: 14,
        trough: 17,
        foam: false
      },
      {
        base: 142,
        harmonics: [
          { k: 2, amp: 11, phase: 1.6 },
          { k: 3, amp: 6, phase: 4.4 },
          { k: 7, amp: 2.6, phase: 0.3 }
        ],
        color: b,
        speed: 21,
        trough: 24,
        foam: true
      },
      {
        base: 166,
        harmonics: [
          { k: 1, amp: 9, phase: 5.1 },
          { k: 4, amp: 7, phase: 2.4 },
          { k: 9, amp: 2.2, phase: 3.7 }
        ],
        color: mix(b, c, 0.55),
        speed: 30,
        trough: 32,
        foam: true
      },
      {
        base: 192,
        harmonics: [
          { k: 2, amp: 10, phase: 3.9 },
          { k: 5, amp: 5, phase: 1.2 },
          { k: 11, amp: 1.8, phase: 5.5 }
        ],
        color: mix(c, [12, 30, 44, c[3] + 0.12], 0.4),
        speed: 42,
        trough: 42,
        foam: true
      }
    ]
  }, [colorKey])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const cursor = trackWaveCursor(host)
    const reduced = REDUCED_MOTION()

    const surface = (layer: LayerSpec, tSec: number, viewPerPx: number): string => {
      const drift = tSec * layer.speed
      let d = ''
      for (let i = 0; i <= SAMPLES; i++) {
        const x = (i / SAMPLES) * VIEW_W
        let y = layer.base
        for (const h of layer.harmonics) {
          y += h.amp * Math.sin((2 * Math.PI * h.k * (x + drift)) / PERIOD + h.phase)
        }
        // the cursor disturbance lives in screen space, tight to the pointer
        y += disturbAt(x / viewPerPx, cursor.current, layer.trough, 74, tSec)
        d += i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`
      }
      return d
    }

    const draw = (tSec: number): void => {
      const w = host.clientWidth || 1440
      const viewPerPx = VIEW_W / w
      for (let i = 0; i < layers.length; i++) {
        const s = surface(layers[i], tSec, viewPerPx)
        fillRefs.current[i]?.setAttribute('d', `${s} L ${VIEW_W} ${HEIGHT} L 0 ${HEIGHT} Z`)
        foamRefs.current[i]?.setAttribute('d', s)
      }
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
    return () => {
      cursor.detach()
      cancelAnimationFrame(raf)
    }
  }, [layers])

  return (
    <div ref={hostRef} className="classic-waves" style={{ height }} aria-hidden>
      <svg className="cw-svg cw-live" viewBox={`0 0 ${VIEW_W} ${HEIGHT}`} preserveAspectRatio="none">
        <defs>
          {layers.map((l, i) => {
            const [r, g, b, alpha] = l.color
            const crest = mix([r, g, b, alpha], [255, 255, 255, alpha], 0.34)
            const deep = mix([r, g, b, alpha], [8, 20, 32, Math.min(1, alpha + 0.18)], 0.45)
            return (
              <linearGradient key={i} id={`cw${uid}${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={rgba(crest[0], crest[1], crest[2], 1)} stopOpacity={crest[3]} />
                <stop offset="0.35" stopColor={rgba(r, g, b, 1)} stopOpacity={alpha} />
                <stop offset="1" stopColor={rgba(deep[0], deep[1], deep[2], 1)} stopOpacity={deep[3]} />
              </linearGradient>
            )
          })}
        </defs>
        {layers.map((l, i) => (
          <g key={i}>
            <path
              ref={(el) => {
                fillRefs.current[i] = el
              }}
              fill={`url(#cw${uid}${i})`}
            />
            {l.foam && (
              <path
                ref={(el) => {
                  foamRefs.current[i] = el
                }}
                fill="none"
                stroke="rgba(255,255,255,0.55)"
                strokeOpacity={0.32}
                strokeWidth={1.6}
                strokeLinecap="round"
              />
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}
