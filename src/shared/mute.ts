import type { AccentModeColors } from './types'

/**
 * Muted — the same water, seen through fog.
 *
 * One derivation layer, no parallel palettes: every identity color passes
 * through `muteColor`, which clamps saturation to a whisper and preserves hue,
 * lightness and alpha exactly. Preserving L keeps every lightness relationship
 * — and therefore every contrast pairing — the palette was designed around.
 *
 * Semantic colors (danger, star, slop grades, traffic-light hovers, download
 * states) are never routed through here: Muted hushes the water; it never
 * repaints signals.
 */

/** Ceiling on saturation when muted: a whisper of the hue survives, nothing more. */
export const MUTE_SAT = 0.06

/**
 * `#rrggbb` | `rgb()`/`rgba()` | `hsl(h s% l%[ / a])` → `[r, g, b, a]` | null.
 * The one color parser the wave renderers and the muting transform share —
 * `customAccentColors` emits `hsl()` strings, which the old per-component
 * parsers silently dropped for a stock blue.
 */
export function parseColorRgba(c: string): [number, number, number, number] | null {
  const s = c.trim()
  const hex = /^#([0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const v = parseInt(hex[1], 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1]
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s)
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]]
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/i.exec(s)
  if (hsl) {
    const a = hsl[4] === undefined ? 1 : hsl[4].endsWith('%') ? parseFloat(hsl[4]) / 100 : +hsl[4]
    const [r, g, b] = hslToRgb(+hsl[1], +hsl[2] / 100, +hsl[3] / 100)
    return [r, g, b, a]
  }
  return null
}

/** Same parse, reported as `{h∈[0,360), s,l,a∈[0,1]}`. */
export function parseColorHsl(c: string): { h: number; s: number; l: number; a: number } | null {
  const rgba = parseColorRgba(c)
  if (!rgba) return null
  const [h, s, l] = rgbToHsl(rgba[0], rgba[1], rgba[2])
  return { h, s, l, a: rgba[3] }
}

function rgbToHsl(r255: number, g255: number, b255: number): [number, number, number] {
  const r = r255 / 255
  const g = g255 / 255
  const b = b255 / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [((h * 360) % 360 + 360) % 360, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 60
  const c = (1 - Math.abs(2 * l - 1)) * Math.max(0, Math.min(1, s))
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hh < 1) [r, g, b] = [c, x, 0]
  else if (hh < 2) [r, g, b] = [x, c, 0]
  else if (hh < 3) [r, g, b] = [0, c, x]
  else if (hh < 4) [r, g, b] = [0, x, c]
  else if (hh < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

/** Alpha with up to three decimals, no trailing zeros — `0.4`, not `0.400`. */
function fmtAlpha(a: number): string {
  return String(Math.round(a * 1000) / 1000)
}

/**
 * The muting transform: H, L and alpha preserved exactly; S clamped to
 * `min(S, MUTE_SAT)`. Output is ALWAYS an `rgba()` string (the wave parsers
 * accept rgba/hex only). Unparseable input is returned untouched.
 */
export function muteColor(c: string): string {
  const p = parseColorHsl(c)
  if (!p) return c
  const [r, g, b] = hslToRgb(p.h, Math.min(p.s, MUTE_SAT), p.l)
  return `rgba(${r}, ${g}, ${b}, ${fmtAlpha(p.a)})`
}

/** Field-wise `muteColor` over accent, accentStrong, tints, waves, and every tile pair. */
export function muteAccentColors(acc: AccentModeColors): AccentModeColors {
  return {
    accent: muteColor(acc.accent),
    accentStrong: muteColor(acc.accentStrong),
    tintTop: muteColor(acc.tintTop),
    tintBottom: muteColor(acc.tintBottom),
    waveA: muteColor(acc.waveA),
    waveB: muteColor(acc.waveB),
    waveC: muteColor(acc.waveC),
    tiles: acc.tiles.map(([a, b]) => [muteColor(a), muteColor(b)]) as [string, string][]
  }
}
