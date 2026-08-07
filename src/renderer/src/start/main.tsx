import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AccentSpec, HomeShortcut, Settings } from '@shared/types'
import { ACCENTS, DEFAULT_SETTINGS, SEARCH_ENGINES } from '@shared/types'
import './start.css'

interface InternalApi {
  settings: { get(): Promise<Settings | null>; set(p: Partial<Settings>): Promise<Settings> }
  open(url: string): Promise<void>
}

const internal = (window as unknown as { offshoreInternal?: InternalApi }).offshoreInternal

function resolveInput(input: string, settings: Settings): string {
  const t = input.trim()
  if (!t) return ''
  if (/^(https?|offshore):/i.test(t)) return t
  if (!/\s/.test(t)) {
    const host = t.split(/[/?#]/)[0]
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(host)) return `https://${t}`
  }
  const engine = SEARCH_ENGINES[settings.searchEngine] ?? SEARCH_ENGINES.duckduckgo
  return engine.searchUrl.replace('%s', encodeURIComponent(t))
}

function Waves({ acc }: { acc: AccentSpec }): React.JSX.Element {
  return (
    <div className="waves" aria-hidden>
      <svg className="wave wave-back" viewBox="0 0 2880 220" preserveAspectRatio="none">
        <path
          style={{ fill: acc.waveA }}
          d="M0,110 C240,60 480,160 720,110 C960,60 1200,160 1440,110 C1680,60 1920,160 2160,110 C2400,60 2640,160 2880,110 L2880,220 L0,220 Z"
        />
      </svg>
      <svg className="wave wave-mid" viewBox="0 0 2880 220" preserveAspectRatio="none">
        <path
          style={{ fill: acc.waveB }}
          d="M0,130 C240,80 480,180 720,130 C960,80 1200,180 1440,130 C1680,80 1920,180 2160,130 C2400,80 2640,180 2880,130 L2880,220 L0,220 Z"
        />
      </svg>
      <svg className="wave wave-front" viewBox="0 0 2880 220" preserveAspectRatio="none">
        <path
          style={{ fill: acc.waveC }}
          d="M0,155 C240,110 480,200 720,155 C960,110 1200,200 1440,155 C1680,110 1920,200 2160,155 C2400,110 2640,200 2880,155 L2880,220 L0,220 Z"
        />
      </svg>
    </div>
  )
}

/** Chunky retro dithered waves rendered on a tiny canvas, upscaled with pixelated rendering. */
function DitheredWaves({ acc }: { acc: AccentSpec }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const W = 240
    const H = 52
    canvas.width = W * 2
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(W * 2, H)
    const bayer = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5]
    ]
    const parse = (rgba: string): [number, number, number, number] => {
      const m = rgba.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
      return m ? [+m[1], +m[2], +m[3], m[4] ? +m[4] : 1] : [100, 180, 220, 0.4]
    }
    // wavelengths divide W so the -50% drift loop is seamless
    const bands = [
      { color: acc.waveA, base: 20, amp: 6, lambda: W / 2, phase: 0.6 },
      { color: acc.waveB, base: 29, amp: 7, lambda: W / 3, phase: 2.4 },
      { color: acc.waveC, base: 38, amp: 6, lambda: W / 4, phase: 4.1 }
    ]
    for (const band of bands) {
      const [r, g, b, a] = parse(band.color)
      for (let x = 0; x < W * 2; x++) {
        const y0 = band.base + band.amp * Math.sin((2 * Math.PI * x) / band.lambda + band.phase)
        for (let y = 0; y < H; y++) {
          const d = y - y0
          const cover = d > 3 ? 1 : d < -3 ? 0 : (d + 3) / 6
          if (cover <= 0) continue
          const threshold = (bayer[y % 4][x % 4] + 0.5) / 16
          if (cover < 1 && cover < threshold) continue
          const i = (y * W * 2 + x) * 4
          const da = img.data[i + 3] / 255
          const oa = a + da * (1 - a)
          img.data[i] = (r * a + img.data[i] * da * (1 - a)) / (oa || 1)
          img.data[i + 1] = (g * a + img.data[i + 1] * da * (1 - a)) / (oa || 1)
          img.data[i + 2] = (b * a + img.data[i + 2] * da * (1 - a)) / (oa || 1)
          img.data[i + 3] = oa * 255
        }
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [acc])

  return (
    <div className="waves" aria-hidden>
      <canvas ref={ref} className="dither-canvas" />
    </div>
  )
}

function App(): React.JSX.Element {
  const [now, setNow] = useState(new Date())
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newUrl, setNewUrl] = useState('')

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    void internal?.settings.get().then((s) => s && setSettings(s))
  }, [])

  const submit = (): void => {
    const url = resolveInput(query, settings)
    if (url) window.location.href = url
  }

  const openShortcut = (s: HomeShortcut): void => {
    window.location.href = s.url
  }

  const removeShortcut = (idx: number): void => {
    const next = settings.homeShortcuts.filter((_, i) => i !== idx)
    setSettings({ ...settings, homeShortcuts: next })
    void internal?.settings.set({ homeShortcuts: next })
  }

  const addShortcut = (): void => {
    if (!newUrl.trim()) return
    const url = /^https?:/i.test(newUrl) ? newUrl.trim() : `https://${newUrl.trim()}`
    let title = newTitle.trim()
    if (!title) {
      try {
        title = new URL(url).hostname.replace(/^www\./, '').split('.')[0]
        title = title.charAt(0).toUpperCase() + title.slice(1)
      } catch {
        title = url
      }
    }
    const next = [...settings.homeShortcuts, { title, url }]
    setSettings({ ...settings, homeShortcuts: next })
    void internal?.settings.set({ homeShortcuts: next })
    setNewTitle('')
    setNewUrl('')
  }

  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const date = now.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
  const acc = ACCENTS[settings.appearance?.accent ?? 'sea'] ?? ACCENTS.sea

  return (
    <div
      className="start"
      style={{
        background: `linear-gradient(180deg, ${acc.tintTop} 0%, ${acc.tintBottom} 100%)`
      }}
    >
      <div className="start-center">
        <div className="clock">{time}</div>
        <div className="date">{date}</div>

        <div className="search-pill">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            autoFocus
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>

        <div className="shortcuts">
          {settings.homeShortcuts.map((s, i) => {
            const [c1, c2] = acc.tiles[i % acc.tiles.length]
            return (
              <div key={`${s.url}-${i}`} className="shortcut-wrap">
                <button className="shortcut" onClick={() => openShortcut(s)} title={s.url}>
                  <span
                    className="shortcut-tile"
                    style={{ background: `linear-gradient(145deg, ${c1}, ${c2})` }}
                  >
                    {s.title.charAt(0).toUpperCase()}
                  </span>
                  <span className="shortcut-title">{s.title}</span>
                </button>
                {editing && (
                  <button className="shortcut-remove" onClick={() => removeShortcut(i)}>
                    ×
                  </button>
                )}
              </div>
            )
          })}
          <button
            className={`shortcut edit-toggle ${editing ? 'editing' : ''}`}
            onClick={() => setEditing(!editing)}
          >
            <span className="shortcut-tile ghost">{editing ? '✓' : '✎'}</span>
            <span className="shortcut-title">{editing ? 'Done' : 'Edit'}</span>
          </button>
        </div>

        {editing && (
          <div className="add-row">
            <input
              placeholder="Title (optional)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <input
              placeholder="example.com"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addShortcut()}
            />
            <button onClick={addShortcut}>Add</button>
          </div>
        )}
      </div>

      {settings.appearance?.waves !== false &&
        (settings.appearance?.waveStyle === 'dithered' ? (
          <DitheredWaves acc={acc} />
        ) : (
          <Waves acc={acc} />
        ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
