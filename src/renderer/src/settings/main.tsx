import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { OffshoreInternalApi } from '@shared/bridge'
import type {
  AccentId,
  BookmarkNode,
  DevToolsDock,
  ExpiredSite,
  NewTabWidgets,
  ExtensionInfo,
  GeocodeResult,
  MorningStatus,
  PasswordMeta,
  PasswordsStatus,
  Settings,
  ShieldStats,
  ThemePref,
  ToolbarDensity
} from '@shared/types'
import {
  ACCENTS,
  ADBLOCK_LISTS,
  DEFAULT_SETTINGS,
  HOME_WIDGETS,
  SEARCH_ENGINES,
  accentColors,
  resolveAccentColors
} from '@shared/types'
import { Favicon } from '../theme/Favicon'
import { moonPhase, timezoneCity } from '../theme/moon'
import { applyMuted, useIsDark } from '../theme/useTheme'
import '../theme/theme.css'
import './settings.css'

const internal = (window as unknown as { offshoreInternal?: OffshoreInternalApi })
  .offshoreInternal

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button className={`toggle ${on ? 'on' : ''} ${disabled ? 'disabled' : ''}`} onClick={() => !disabled && onChange(!on)}>
      <span className="knob" />
    </button>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? 'seg-on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** Success labels that reset themselves. */
function useFlash(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flash = (m: string): void => {
    if (timer.current) clearTimeout(timer.current)
    setMsg(m)
    timer.current = setTimeout(() => setMsg(null), 1800)
  }
  return [msg, flash]
}

// ---------------- Passwords section ----------------

function PasswordsSection({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }): React.JSX.Element {
  const [status, setStatus] = useState<PasswordsStatus>({ available: false, canTouchId: false })
  const [entries, setEntries] = useState<PasswordMeta[]>([])
  const [never, setNever] = useState<string[]>([])
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const refresh = (): void => {
    void internal?.passwords.list().then((l) => l && setEntries(l))
    void internal?.passwords.neverList().then((l) => l && setNever(l))
  }

  useEffect(() => {
    void internal?.passwords.status().then((s) => s && setStatus(s))
    refresh()
  }, [])

  useEffect(() => {
    if (!revealed) return
    const t = setTimeout(() => setRevealed(null), 15_000)
    return () => clearTimeout(t)
  }, [revealed])

  return (
    <section>
      <h2>Passwords</h2>
      <div className="card">
        <div className="row">
          <div className="row-title">
            Save and fill passwords
            <div className="row-sub">
              Encrypted with your Mac’s Keychain. Filled only on the exact site they were saved on.
            </div>
          </div>
          <Toggle
            on={settings.passwords.enabled && status.available}
            disabled={!status.available}
            onChange={(v) => patch({ passwords: { enabled: v } })}
          />
        </div>
        {!status.available && (
          <div className="row">
            <div className="row-sub">Keychain encryption is unavailable on this system, so the vault is disabled.</div>
          </div>
        )}
        {entries.map((e) => (
          <div className="row" key={e.id}>
            <div className="pw-meta">
              <div className="row-title clamp">{e.host}</div>
              <div className="row-sub clamp">
                {e.username || '—'}
                {revealed?.id === e.id && <span className="pw-secret"> · {revealed.value}</span>}
              </div>
            </div>
            <div className="row-actions">
              <button
                className="ghost"
                onClick={() => {
                  if (revealed?.id === e.id) {
                    setRevealed(null)
                    return
                  }
                  void internal?.passwords.reveal(e.id).then((v) => {
                    if (v != null) setRevealed({ id: e.id, value: v })
                  })
                }}
              >
                {revealed?.id === e.id ? 'Hide' : 'Reveal'}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  void internal?.passwords.copy(e.id).then((ok) => {
                    if (ok) {
                      setCopied(e.id)
                      setTimeout(() => setCopied(null), 1500)
                    }
                  })
                }}
              >
                {copied === e.id ? 'Copied ✓' : 'Copy'}
              </button>
              <button
                className="danger"
                onClick={() => {
                  void internal?.passwords.delete(e.id).then(refresh)
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {status.available && entries.length === 0 && (
          <div className="row">
            <div className="row-sub">Nothing saved yet — sign in to a site and Offshore will offer to remember it.</div>
          </div>
        )}
        {never.length > 0 && (
          <div className="row column">
            <div className="row-title">Never saved for</div>
            <div className="chips">
              {never.map((origin) => (
                <span className="chip" key={origin}>
                  {origin.replace(/^https?:\/\//, '')}
                  <button onClick={() => void internal?.passwords.removeNever(origin).then(refresh)}>×</button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------- Privacy section ----------------

function PrivacySection({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }): React.JSX.Element {
  const [expired, setExpired] = useState<ExpiredSite[]>([])
  const [historyFlash, flashHistory] = useFlash()
  const [siteDataFlash, flashSiteData] = useFlash()

  const refreshExpired = (): void => {
    void internal?.privacy.expired().then((l) => l && setExpired(l))
  }
  useEffect(refreshExpired, [])

  const p = settings.privacy
  const patchPrivacy = (pp: Partial<Settings['privacy']>): void => patch({ privacy: { ...p, ...pp } })
  const fmtDay = (ms: number): string =>
    new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })

  const exceptions: { title: string; key: 'keepSites' | 'blockSites' | 'disabledSites' }[] = [
    { title: 'Always allowed', key: 'keepSites' },
    { title: 'Blocked', key: 'blockSites' },
    { title: 'Protections off', key: 'disabledSites' }
  ]
  const noExceptions = exceptions.every(({ key }) => p[key].length === 0)

  return (
    <section>
      <h2>Privacy</h2>
      <div className="card">
        <div className="row">
          <div className="row-title">
            Answer cookie prompts for you
            <div className="row-sub">
              Always the most private choice — reject everything rejectable. Runs entirely on
              this Mac; leftover banners are hidden by the EasyList Cookie filter.
            </div>
          </div>
          <Toggle on={p.consentAuto} onChange={(v) => patchPrivacy({ consentAuto: v })} />
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="row-title">
            Keep tracker cookies out
            <div className="row-sub">
              Strips cookies from requests already known to be tracking. Sign-ins, checkouts
              and the site you&apos;re on are never touched.
            </div>
          </div>
          <Toggle on={p.cookieGuard} onChange={(v) => patchPrivacy({ cookieGuard: v })} />
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="row-title">
            Let the tide take old cookies
            <div className="row-sub">
              Cookies and site data from sites you haven&apos;t visited in a while wash out.
              Sites you keep open, bookmark, save a password for, or always-allow are never
              touched. To know when you last visited, Offshore keeps one line per site — the
              site&apos;s name and the day — and nothing else.
            </div>
          </div>
          <Toggle on={p.tide} onChange={(v) => patchPrivacy({ tide: v })} />
        </div>
        {p.tide && (
          <div className="row">
            <div className="row-title">Wash out after</div>
            <Segmented
              value={String(p.tideDays)}
              options={[
                ['14', '2 weeks'],
                ['30', 'Month'],
                ['60', '2 months'],
                ['90', '3 months']
              ]}
              onChange={(v) => patchPrivacy({ tideDays: Number(v) })}
            />
          </div>
        )}
        {expired.length > 0 && (
          <>
            <div className="row">
              <div className="row-title">Recently expired</div>
            </div>
            {expired.map((e) => (
              <div className="row" key={e.domain}>
                <div className="row-title clamp">
                  {e.domain}
                  <div className="row-sub">
                    {e.cookieCount} cookie{e.cookieCount === 1 ? '' : 's'} · {fmtDay(e.expiredAt)}
                  </div>
                </div>
                <button
                  className="ghost"
                  onClick={() => void internal?.privacy.restore(e.domain).then(refreshExpired)}
                >
                  Restore
                </button>
              </div>
            ))}
            <div className="row">
              <div className="row-sub">
                Restoring brings cookies back; anything the site stored is gone.
              </div>
            </div>
          </>
        )}
      </div>

      <div className="card">
        {noExceptions ? (
          <div className="row">
            <div className="row-sub">
              Nothing yet — set these from the site button in the address bar.
            </div>
          </div>
        ) : (
          exceptions.map(
            ({ title, key }) =>
              p[key].length > 0 && (
                <div className="row column" key={key}>
                  <div className="row-title">{title}</div>
                  <div className="chips">
                    {p[key].map((domain) => (
                      <span className="chip" key={domain}>
                        {domain}
                        <button
                          onClick={() => patchPrivacy({ [key]: p[key].filter((d) => d !== domain) })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )
          )
        )}
      </div>

      <div className="card">
        <div className="row">
          <div className="row-title">
            Remember pages you visit
            <div className="row-sub">
              Off by default. When off, nothing is written down and the address bar never suggests
              somewhere you&apos;ve been.
            </div>
          </div>
          <Toggle on={settings.keepHistory} onChange={(v) => patch({ keepHistory: v })} />
        </div>
        <div className="row">
          <div className="row-title">
            Suggestions from {SEARCH_ENGINES[settings.searchEngine].name}
            <div className="row-sub">
              Finishes what you type in the address bar. It is the one thing here that
              sends a half-typed word anywhere: the query goes out from Offshore itself,
              with no cookies and nothing that says who asked. Turn it off and the address
              bar only ever offers your own tabs, bookmarks and history.
            </div>
          </div>
          <Toggle
            on={settings.searchSuggestions}
            onChange={(v) => patch({ searchSuggestions: v })}
          />
        </div>
        <div className="row">
          <div className="row-title">Clear browsing history</div>
          <button
            className="danger"
            onClick={() => {
              void internal?.history.clear()
              flashHistory('Cleared ✓')
            }}
          >
            {historyFlash ?? 'Clear history'}
          </button>
        </div>
        <div className="row">
          <div className="row-title">
            Clear cookies &amp; site data
            <div className="row-sub">
              Signs you out of every site, in every space. Also clears the tide&apos;s
              site-name map and the recently-expired list.
            </div>
          </div>
          <button
            className="danger"
            onClick={() => {
              void internal?.privacy.clearSiteData().then(() => {
                flashSiteData('Cleared ✓')
                refreshExpired()
              })
            }}
          >
            {siteDataFlash ?? 'Clear site data'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ---------------- Bookmarks manager ----------------

function BookmarksSection(): React.JSX.Element {
  const [nodes, setNodes] = useState<BookmarkNode[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const refresh = (): void => {
    void internal?.bookmarks.list().then((b) => b && setNodes(b))
  }
  useEffect(refresh, [])

  const children = (parentId: string | null): BookmarkNode[] =>
    nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.index - b.index)

  const rows = useMemo(() => {
    const out: { node: BookmarkNode; depth: number }[] = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const n of children(parentId)) {
        out.push({ node: n, depth })
        if (n.type === 'folder' && open[n.id] !== false) walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [nodes, open])

  const commitRename = (): void => {
    if (renaming && renameText.trim()) {
      void internal?.bookmarks.update(renaming, { title: renameText.trim() }).then(refresh)
    }
    setRenaming(null)
  }

  return (
    <section>
      <h2>Bookmarks</h2>
      <div className="card">
        <div className="row">
          <div className="row-title">Organize into folders — drag them in the sidebar, or manage here</div>
          <button
            className="primary"
            onClick={() => {
              void internal?.bookmarks.addFolder('New Folder', null).then((f) => {
                refresh()
                if (f) {
                  setRenaming(f.id)
                  setRenameText(f.title)
                }
              })
            }}
          >
            New Folder
          </button>
        </div>
        {rows.length === 0 && (
          <div className="row">
            <div className="row-sub">No bookmarks yet — hit ⌘D on a page you love.</div>
          </div>
        )}
        {rows.map(({ node, depth }) => (
          <div className="row bm-row" key={node.id} style={{ paddingLeft: 18 + depth * 22 }}>
            <div className="bm-info">
              {node.type === 'folder' ? (
                <button
                  className={`bm-chev ${open[node.id] !== false ? 'open' : ''}`}
                  onClick={() => setOpen((o) => ({ ...o, [node.id]: o[node.id] === false }))}
                >
                  ▸
                </button>
              ) : (
                <Favicon
                  url={node.url}
                  stored={node.favicon}
                  className="bm-fav"
                  fallback={<span className="bm-fav ghost" />}
                />
              )}
              {renaming === node.id ? (
                <input
                  className="bm-rename"
                  autoFocus
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <div className="bm-text">
                  <div
                    className="row-title clamp"
                    onDoubleClick={() => {
                      setRenaming(node.id)
                      setRenameText(node.title)
                    }}
                  >
                    {node.type === 'folder' ? `📁 ${node.title}` : node.title}
                  </div>
                  {node.url && (
                    <button className="link clamp" onClick={() => void internal?.open(node.url!)}>
                      {node.url}
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="row-actions">
              <button
                className="ghost"
                onClick={() => {
                  setRenaming(node.id)
                  setRenameText(node.title)
                }}
              >
                Rename
              </button>
              <button className="danger" onClick={() => void internal?.bookmarks.remove(node.id).then(refresh)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------- New Tab (widgets) section ----------------

/** One status sentence for the Morning brief card, from morning:status. */
function MorningStatusRow({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }): React.JSX.Element {
  const [status, setStatus] = useState<MorningStatus | null>(null)

  useEffect(() => {
    void internal?.morning.status().then((s) => s && setStatus(s))
  }, [])

  if (!settings.keepHistory) {
    return (
      <div className="row">
        <div className="row-sub">Needs local history.</div>
        <button className="ghost" onClick={() => patch({ keepHistory: true })}>
          Turn on
        </button>
      </div>
    )
  }
  if (!status) return <div className="row"><div className="row-sub">Checking for a local model…</div></div>
  return (
    <div className="row">
      <div className="row-sub">
        {status.ollama.reachable && status.ollama.model
          ? `Composed by ${status.ollama.model} — Ollama on this machine.`
          : `Ollama not found at ${status.ollama.host} — using Offshore's built-in heuristics. Everything stays local either way.`}
      </div>
    </div>
  )
}

function NewTabSection({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GeocodeResult[]>([])
  const [locating, setLocating] = useState(false)
  const [now, setNow] = useState(new Date())
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDark = useIsDark()

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])

  const widgets = settings.newTabWidgets ?? DEFAULT_SETTINGS.newTabWidgets
  const setWidget = (key: keyof NewTabWidgets, v: boolean): void => {
    patch({ newTabWidgets: { ...widgets, [key]: v } })
  }
  const wantsWeather = widgets.weather || widgets.forecast || widgets.sun
  const acc = resolveAccentColors(settings.appearance ?? DEFAULT_SETTINGS.appearance, isDark)

  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  const hour = now.getHours()
  const greet =
    hour >= 5 && hour < 11 ? 'Good morning' : hour >= 11 && hour < 17 ? 'Good afternoon' : hour >= 17 && hour < 23 ? 'Good evening' : 'Up late'
  const moon = moonPhase(now)

  // live previews, rendered the way the real page renders them
  const DEFS: { key: keyof NewTabWidgets; label: string; preview: React.ReactNode }[] = [
    { key: 'clock', label: 'Time', preview: <div className="we-clock">{time}</div> },
    { key: 'date', label: 'Date', preview: <div className="we-date">{date}</div> },
    { key: 'greeting', label: 'Greeting', preview: <div className="we-greet">{greet}.</div> },
    {
      key: 'weather',
      label: 'Weather',
      preview: (
        <div className="we-line">
          <strong>72°</strong> and clear <span className="we-dim">H 78° · L 64°</span>
        </div>
      )
    },
    {
      key: 'forecast',
      label: 'Hourly forecast',
      preview: (
        <div className="we-hours">
          {['3 PM', '4 PM', '5 PM', '6 PM'].map((h, i) => (
            <span key={h} className="we-hour">
              {h} {[74, 73, 71, 68][i]}°
            </span>
          ))}
        </div>
      )
    },
    { key: 'sun', label: 'Sunrise & sunset', preview: <div className="we-line">☀️ 6:12 AM → 🌙 8:04 PM</div> },
    {
      key: 'moon',
      label: 'Moon phase',
      preview: (
        <div className="we-line">
          {moon.icon} {moon.name}
        </div>
      )
    }
  ]
  const enabled = DEFS.filter((d) => widgets[d.key])
  const available = DEFS.filter((d) => !widgets[d.key])

  const search = (q: string): void => {
    setQuery(q)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      if (q.trim().length < 2) {
        setResults([])
        return
      }
      void internal?.brief.geocode(q).then((r) => setResults(r ?? []))
    }, 250)
  }

  const pickLocation = (r: GeocodeResult): void => {
    patch({
      brief: { ...settings.brief, enabled: true, locationName: r.name, lat: r.lat, lon: r.lon }
    })
    setQuery('')
    setResults([])
  }

  // "Current location" without tracking: your Mac's timezone names a city,
  // and the only network request is the Open-Meteo lookup you already trust.
  const useMyLocation = (): void => {
    const city = timezoneCity()
    if (!city) return
    setLocating(true)
    void internal?.brief
      .geocode(city)
      .then((r) => {
        if (r && r[0]) pickLocation(r[0])
      })
      .finally(() => setLocating(false))
  }

  /*
   * The widget board is parked (HOME_WIDGETS in shared/types), so there is
   * nothing here to edit: the new tab is the time and the search in front of it.
   * The editor below is untouched and comes back with the flag.
   */
  if (!HOME_WIDGETS) {
    return (
      <section>
        <h2>New Tab</h2>
        <div className="card we-card">
          <div
            className="we-preview"
            style={{ background: `linear-gradient(180deg, ${acc.tintTop} 0%, ${acc.tintBottom} 100%)` }}
          >
            <div className="we-widget">
              <div className="we-clock">{time}</div>
            </div>
          </div>
          <div className="row">
            <div className="row-title">
              The time, and the search
              <div className="row-sub">
                A new tab is the clock over the waves, with the search bar springing up in front
                of it. Click past the search (or press Escape) and the page stays where it is.
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="row">
            <div className="row-title">
              Morning brief
              <div className="row-sub">
                The first new tab of the day can greet you with sites to revisit, topics to
                learn, and new videos from channels you watch. Built from your local history,
                entirely on this Mac.
              </div>
            </div>
            <Toggle
              on={settings.morning.enabled}
              onChange={(v) => patch({ morning: { enabled: v } })}
            />
          </div>
          {settings.morning.enabled && <MorningStatusRow settings={settings} patch={patch} />}
        </div>
      </section>
    )
  }

  return (
    <section>
      <h2>New Tab</h2>
      <div className="card we-card">
        <div
          className="we-preview"
          style={{ background: `linear-gradient(180deg, ${acc.tintTop} 0%, ${acc.tintBottom} 100%)` }}
        >
          {enabled.length === 0 && <div className="we-empty">A perfectly calm, blank page.</div>}
          {enabled.map((d) => (
            <div className="we-widget" key={d.key}>
              {d.preview}
              <button className="we-remove" title={`Remove ${d.label}`} onClick={() => setWidget(d.key, false)}>
                −
              </button>
            </div>
          ))}
        </div>
        {available.length > 0 && (
          <div className="we-gallery">
            {available.map((d) => (
              <button className="we-add" key={d.key} onClick={() => setWidget(d.key, true)}>
                <span className="we-add-badge">+</span>
                {d.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {wantsWeather && (
        <>
          <h2 className="h2-gap">Location</h2>
          <div className="card">
            <div className="row">
              <div className="row-title">
                {settings.brief.locationName ? settings.brief.locationName : 'No location set'}
                <div className="row-sub">
                  Weather needs a place. "Use my location" reads your Mac's timezone — nothing is
                  tracked, and only Open-Meteo sees the lookup.
                </div>
              </div>
              <button className="ghost" onClick={useMyLocation} disabled={locating}>
                {locating ? 'Finding…' : 'Use my location'}
              </button>
            </div>
            <div className="row column">
              <input
                className="text-input"
                placeholder="Or search for a city…"
                value={query}
                onChange={(e) => search(e.target.value)}
              />
              {results.length > 0 && (
                <div className="geo-results">
                  {results.map((r, i) => (
                    <button key={`${r.lat}-${r.lon}-${i}`} className="geo-result" onClick={() => pickLocation(r)}>
                      {r.name}
                      <span className="geo-sub">{[r.admin1, r.country].filter(Boolean).join(', ')}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="row">
              <div className="row-title">Units</div>
              <Segmented
                value={settings.brief.unit}
                options={[
                  ['auto', 'Auto'],
                  ['c', '°C'],
                  ['f', '°F']
                ]}
                onChange={(v) => patch({ brief: { ...settings.brief, unit: v } })}
              />
            </div>
          </div>
        </>
      )}
    </section>
  )
}

// ---------------- App ----------------

type SectionId =
  | 'general'
  | 'appearance'
  | 'newtab'
  | 'shield'
  | 'passwords'
  | 'extensions'
  | 'bookmarks'
  | 'privacy'
  | 'about'

const NAV: { id: SectionId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'newtab', label: 'New Tab' },
  { id: 'shield', label: 'Shield' },
  { id: 'passwords', label: 'Passwords' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'about', label: 'About' }
]

/** The filter lists behind the one "block ads & trackers" switch — everything
 * on by default; the annoyances list keeps its own toggle below. */
const CORE_LISTS = ADBLOCK_LISTS.filter((l) => l.defaultOn).map((l) => l.id)

function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([])
  const [shieldStats, setShieldStats] = useState<ShieldStats | null>(null)
  const [focusSites, setFocusSites] = useState<string[]>([])
  const [rulesDraft, setRulesDraft] = useState('')
  const [rulesFlash, flashRules] = useFlash()
  const [version, setVersion] = useState('')
  const [active, setActive] = useState<SectionId>(() => {
    const h = window.location.hash.slice(1) as SectionId
    return NAV.some((n) => n.id === h) ? h : 'general'
  })
  const isDark = useIsDark()

  useEffect(() => {
    void internal?.settings.get().then((s) => {
      if (s) {
        setSettings(s)
        setRulesDraft(s.adblock.customRules)
        applyMuted(s.appearance?.muted === true)
      }
    })
    // stay live: a Muted/accent/theme flip from the chrome lands here too
    internal?.settings.onChanged((s) => {
      setSettings(s)
      applyMuted(s.appearance?.muted === true)
    })
    void internal?.extensions.list().then((e) => e && setExtensions(e))
    void internal?.focus.sites().then((s) => s && setFocusSites(s))
    void internal?.app.info().then((i) => i && setVersion(i.version))
  }, [])

  // The lifetime blocked count is ambient, not live-critical: fetch it while a
  // section that shows it is open, on a lazy interval, and let it rest otherwise.
  useEffect(() => {
    if (active !== 'extensions' && active !== 'shield') return
    const load = (): void => {
      void internal?.shield.stats().then((s) => s && setShieldStats(s))
    }
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [active])

  const patch = (p: Partial<Settings>): void => {
    const next = {
      ...settings,
      ...p,
      adblock: { ...settings.adblock, ...(p.adblock ?? {}) },
      appearance: { ...settings.appearance, ...(p.appearance ?? {}) },
      popups: { ...settings.popups, ...(p.popups ?? {}) },
      privacy: { ...settings.privacy, ...(p.privacy ?? {}) },
      passwords: { ...settings.passwords, ...(p.passwords ?? {}) },
      brief: { ...settings.brief, ...(p.brief ?? {}) },
      newTabWidgets: { ...(settings.newTabWidgets ?? DEFAULT_SETTINGS.newTabWidgets), ...(p.newTabWidgets ?? {}) }
    }
    setSettings(next)
    void internal?.settings.set(p)
  }

  const patchAdblock = (p: Partial<Settings['adblock']>): void => {
    patch({ adblock: { ...settings.adblock, ...p } })
  }

  /** The one Shield switch — the Shield section row and the Extensions row both flip this. */
  const patchShieldEnabled = (v: boolean): void => {
    patchAdblock({
      enabled: v,
      // flipping the big switch restores the standard bundle
      lists: v
        ? { ...settings.adblock.lists, ...Object.fromEntries(CORE_LISTS.map((l) => [l, true])) }
        : settings.adblock.lists
    })
  }

  /** "N requests blocked so far." — or nothing while the number is still loading. */
  const blockedSoFar = shieldStats
    ? ` ${shieldStats.blockedTotal.toLocaleString()} requests blocked so far.`
    : ''

  const annoyancesOn = settings.adblock.lists['annoyances'] ?? false

  return (
    <div className="settings-shell">
      <nav className="settings-nav">
        <h1>Settings</h1>
        {NAV.map(({ id, label }) => (
          <button key={id} className={`nav-item ${active === id ? 'nav-on' : ''}`} onClick={() => setActive(id)}>
            {label}
          </button>
        ))}
      </nav>

      <main className="settings-main">
        <div className="settings-page">
          {active === 'general' && (
            <section>
              <h2>General</h2>
              <div className="card">
                <div className="row">
                  <div className="row-title">Search engine</div>
                  <select
                    value={settings.searchEngine}
                    onChange={(e) => patch({ searchEngine: e.target.value as Settings['searchEngine'] })}
                  >
                    {Object.entries(SEARCH_ENGINES).map(([id, e]) => (
                      <option key={id} value={id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row">
                  <div className="row-title">Tab layout</div>
                  <Segmented
                    value={settings.tabOrientation}
                    options={[
                      ['vertical', 'Vertical'],
                      ['horizontal', 'Horizontal']
                    ]}
                    onChange={(v) => patch({ tabOrientation: v })}
                  />
                </div>
                <div className="row">
                  <div className="row-title">
                    Toolbar
                    <div className="row-sub">Dynamic tucks the chrome away until you reach for it (⌘S).</div>
                  </div>
                  <Segmented<ToolbarDensity>
                    value={settings.toolbarDensity}
                    options={[
                      ['classic', 'Classic'],
                      ['compact', 'Compact'],
                      ['dynamic', 'Dynamic']
                    ]}
                    onChange={(v) => patch({ toolbarDensity: v })}
                  />
                </div>
                <div className="row">
                  <div className="row-title">
                    Show bookmarks
                    <div className="row-sub">The tree in the sidebar, or a bar under the toolbar in horizontal layout.</div>
                  </div>
                  <Toggle on={settings.bookmarksBar} onChange={(v) => patch({ bookmarksBar: v })} />
                </div>
                <div className="row">
                  <div className="row-title">
                    Developer Tools
                    <div className="row-sub">
                      Where ⌥⌘I opens them. Docked ones can be sent to a window (and back) from the
                      button beside the toolbar&apos;s DevTools icon.
                    </div>
                  </div>
                  <Segmented<DevToolsDock>
                    value={settings.devtoolsDock}
                    options={[
                      ['right', 'Side'],
                      ['bottom', 'Bottom'],
                      ['window', 'Window']
                    ]}
                    onChange={(v) => patch({ devtoolsDock: v })}
                  />
                </div>
                <div className="row">
                  <div className="row-title">Restore tabs on launch</div>
                  <Toggle on={settings.restoreSession} onChange={(v) => patch({ restoreSession: v })} />
                </div>
                <div className="row">
                  <div className="row-title">
                    Auto mini-player
                    <div className="row-sub">Playing video pops into a floating player when you switch tabs.</div>
                  </div>
                  <Toggle on={settings.autoPip} onChange={(v) => patch({ autoPip: v })} />
                </div>
                <div className="row">
                  <div className="row-title">Interface sounds</div>
                  <Toggle on={settings.uiSounds} onChange={(v) => patch({ uiSounds: v })} />
                </div>
                <div className="row">
                  <div className="row-title">Onboarding</div>
                  <button className="ghost" onClick={() => void internal?.open('offshore://welcome')}>
                    Show welcome again
                  </button>
                </div>
              </div>
            </section>
          )}

          {active === 'appearance' && (
            <section>
              <h2>Appearance</h2>
              <div className="card">
                <div className="row">
                  <div className="row-title">Theme</div>
                  <Segmented<ThemePref>
                    value={settings.appearance.theme}
                    options={[
                      ['system', 'System'],
                      ['light', 'Light'],
                      ['dark', 'Dark']
                    ]}
                    onChange={(v) => patch({ appearance: { ...settings.appearance, theme: v } })}
                  />
                </div>
                <div className="row">
                  <div className="row-title">
                    Mood
                    <div className="row-sub">Muted grays the whole chrome and stills the water.</div>
                  </div>
                  <Segmented<'water' | 'muted'>
                    value={settings.appearance.muted ? 'muted' : 'water'}
                    options={[
                      ['water', 'Water'],
                      ['muted', 'Muted']
                    ]}
                    onChange={(v) =>
                      patch({ appearance: { ...settings.appearance, muted: v === 'muted' } })
                    }
                  />
                </div>
                <div className="row">
                  <div className="row-title">
                    Accent
                    <div className="row-sub">Tints the chrome, the waves, and the new-tab page.</div>
                  </div>
                  <div className="accent-dots">
                    {(Object.keys(ACCENTS) as AccentId[]).map((id) => {
                      const c = accentColors(id, isDark)
                      const chosen = !settings.appearance.accentCustom && settings.appearance.accent === id
                      return (
                        <button
                          key={id}
                          className={`accent-dot ${chosen ? 'chosen' : ''}`}
                          style={{ background: c.accent }}
                          title={ACCENTS[id].name}
                          onClick={() =>
                            patch({ appearance: { ...settings.appearance, accent: id, accentCustom: null } })
                          }
                        />
                      )
                    })}
                    <label
                      className={`accent-dot accent-custom ${settings.appearance.accentCustom ? 'chosen' : ''}`}
                      style={
                        settings.appearance.accentCustom
                          ? { background: settings.appearance.accentCustom }
                          : undefined
                      }
                      title="Custom color"
                    >
                      <input
                        type="color"
                        value={settings.appearance.accentCustom ?? '#1d84ad'}
                        onChange={(e) =>
                          patch({ appearance: { ...settings.appearance, accentCustom: e.target.value } })
                        }
                      />
                      {!settings.appearance.accentCustom && <span className="accent-plus">+</span>}
                    </label>
                  </div>
                </div>
                <div className="row">
                  <div className="row-title">Waves on the new-tab page</div>
                  <Toggle
                    on={settings.appearance.waves}
                    onChange={(v) => patch({ appearance: { ...settings.appearance, waves: v } })}
                  />
                </div>
                {settings.appearance.waves && (
                  <div className="row">
                    <div className="row-title">Wave style</div>
                    <Segmented
                      value={settings.appearance.waveStyle}
                      options={[
                        ['dithered', 'Dithered'],
                        ['classic', 'Classic']
                      ]}
                      onChange={(v) => patch({ appearance: { ...settings.appearance, waveStyle: v } })}
                    />
                  </div>
                )}
              </div>
            </section>
          )}

          {active === 'newtab' && <NewTabSection settings={settings} patch={patch} />}

          {active === 'shield' && (
            <section>
              <h2>Shield</h2>
              <div className="card">
                <div className="row">
                  <div className="row-title">
                    Block ads &amp; trackers
                    <div className="row-sub">
                      Removes ads and stops trackers with the full uBlock Origin filter set.
                      Pages load faster and sites learn less about you.{blockedSoFar}
                    </div>
                  </div>
                  <Toggle on={settings.adblock.enabled} onChange={patchShieldEnabled} />
                </div>
                <div className="row">
                  <div className="row-title">
                    Hide cookie banners &amp; annoyances
                    <div className="row-sub">
                      Also hides "accept cookies" walls, newsletter popovers, and floating widgets.
                    </div>
                  </div>
                  <Toggle
                    on={annoyancesOn}
                    disabled={!settings.adblock.enabled}
                    onChange={(v) => patchAdblock({ lists: { ...settings.adblock.lists, annoyances: v } })}
                  />
                </div>
                <div className="row">
                  <div className="row-title">
                    Block popups
                    <div className="row-sub">Popups open only after a real click — no drive-bys.</div>
                  </div>
                  <Toggle on={settings.popups.block} onChange={(v) => patch({ popups: { ...settings.popups, block: v } })} />
                </div>
                <div className="row">
                  <div className="row-title">
                    AI slop detector
                    <div className="row-sub">
                      Scores every page for the tells of machine-generated filler — stock phrases,
                      formula structure. A chip on the address bar carries the score; press it for
                      the full report. Plain local heuristics: no AI involved, nothing leaves your Mac.
                    </div>
                  </div>
                  <Toggle
                    on={settings.slop.detector}
                    onChange={(v) => patch({ slop: { ...settings.slop, detector: v } })}
                  />
                </div>
                <div className="row">
                  <div className="row-title">
                    Bar the flagged prose
                    <div className="row-sub">
                      A slim colored bar at the edge of each block that carries the tells —
                      amber for a lean, red for the worst of it.
                    </div>
                  </div>
                  <Toggle
                    on={settings.slop.highlight}
                    disabled={!settings.slop.detector}
                    onChange={(v) => patch({ slop: { ...settings.slop, highlight: v } })}
                  />
                </div>
              </div>

              <h2 className="h2-gap">Custom rules</h2>
              <div className="card">
                <div className="row column">
                  <div className="row-sub">
                    One rule per line, uBlock Origin syntax — e.g. <code>||example.com^</code> blocks a domain,
                    <code>example.org##.ad-banner</code> hides an element.
                  </div>
                  <textarea
                    value={rulesDraft}
                    spellCheck={false}
                    placeholder={'||example.com^\nexample.org##.ad-banner'}
                    onChange={(e) => setRulesDraft(e.target.value)}
                  />
                  <button
                    className="primary"
                    onClick={() => {
                      patchAdblock({ customRules: rulesDraft })
                      flashRules('Saved ✓')
                    }}
                  >
                    {rulesFlash ?? 'Apply rules'}
                  </button>
                </div>
                {settings.adblock.allowlist.length > 0 && (
                  <div className="row column">
                    <div className="row-title">Sites with Shield off</div>
                    <div className="chips">
                      {settings.adblock.allowlist.map((host) => (
                        <span className="chip" key={host}>
                          {host}
                          <button
                            onClick={() =>
                              patchAdblock({
                                allowlist: settings.adblock.allowlist.filter((h) => h !== host)
                              })
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {settings.popups.allowlist.length > 0 && (
                  <div className="row column">
                    <div className="row-title">Sites allowed to open popups</div>
                    <div className="chips">
                      {settings.popups.allowlist.map((host) => (
                        <span className="chip" key={host}>
                          {host}
                          <button
                            onClick={() =>
                              patch({
                                popups: {
                                  ...settings.popups,
                                  allowlist: settings.popups.allowlist.filter((h) => h !== host)
                                }
                              })
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {settings.slop.quiet.length > 0 && (
                  <div className="row column">
                    <div className="row-title">Sites where the detector is quiet</div>
                    <div className="chips">
                      {settings.slop.quiet.map((host) => (
                        <span className="chip" key={host}>
                          {host}
                          <button
                            onClick={() =>
                              patch({
                                slop: {
                                  ...settings.slop,
                                  quiet: settings.slop.quiet.filter((h) => h !== host)
                                }
                              })
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {active === 'passwords' && <PasswordsSection settings={settings} patch={patch} />}

          {active === 'extensions' && (
            <section>
              <h2>Extensions</h2>
              <div className="card">
                <div className="row">
                  <div className="row-title">
                    Built into Offshore
                    <div className="row-sub">
                      Extensions that ship with the browser — no store, no install, nothing
                      leaves your Mac.
                    </div>
                  </div>
                </div>
                <div className="row">
                  <div className="ext-info">
                    <span className="ext-icon builtin">🛡</span>
                    <div className="row-title">
                      Shield
                      <div className="row-sub">
                        The full uBlock Origin filter set on the Ghostery engine — ads, trackers,
                        and malware domains never load.{blockedSoFar} Tuning lives in
                        Settings → Shield.
                      </div>
                    </div>
                  </div>
                  <Toggle on={settings.adblock.enabled} onChange={patchShieldEnabled} />
                </div>
                <div className="row">
                  <div className="ext-info">
                    <span className="ext-icon builtin">☔</span>
                    <div className="row-title">
                      Slop Detector
                      <div className="row-sub">
                        Scores every page for machine-generated filler and bars the guilty prose
                        at its edge, amber to red. Tuning lives in Settings → Shield.
                      </div>
                    </div>
                  </div>
                  <Toggle
                    on={settings.slop.detector}
                    onChange={(v) => patch({ slop: { ...settings.slop, detector: v } })}
                  />
                </div>
                <div className="row">
                  <div className="ext-info">
                    <span className="ext-icon builtin">◉</span>
                    <div className="row-title">
                      Focus
                      <div className="row-sub">
                        One switch on any page: ads, cookie nags, sticky bars, comments and
                        recommendation rails come off, and the layout closes up around what&apos;s
                        left. Remembered per site
                        {focusSites.length > 0
                          ? ` — on for ${focusSites.length} site${focusSites.length === 1 ? '' : 's'}.`
                          : '.'}
                      </div>
                    </div>
                  </div>
                  {focusSites.length > 0 && (
                    <button
                      className="ghost"
                      onClick={() => void internal?.focus.forgetAll().then(() => setFocusSites([]))}
                    >
                      Forget sites
                    </button>
                  )}
                  <Toggle
                    on={settings.focus.enabled}
                    onChange={(v) => patch({ focus: { enabled: v } })}
                  />
                </div>
                {extensions.map((ext) => (
                  <div className="row" key={ext.id}>
                    <div className="ext-info">
                      {ext.icon ? <img className="ext-icon" src={ext.icon} alt="" /> : <span className="ext-icon placeholder" />}
                      <div className="row-title">
                        {ext.name} <span className="ext-version">v{ext.version}</span>
                      </div>
                    </div>
                    <button
                      className="danger"
                      onClick={() => {
                        void internal?.extensions.uninstall(ext.id).then(() => {
                          setExtensions((prev) => prev.filter((e) => e.id !== ext.id))
                        })
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div className="row">
                  <div className="row-title">
                    Chrome Web Store
                    <div className="row-sub">Extensions apply in shared-login spaces.</div>
                  </div>
                  <button className="primary" onClick={() => void internal?.open('https://chromewebstore.google.com/')}>
                    Open Web Store
                  </button>
                </div>
              </div>
            </section>
          )}

          {active === 'bookmarks' && <BookmarksSection />}

          {active === 'privacy' && <PrivacySection settings={settings} patch={patch} />}

          {active === 'about' && (
            <section>
              <h2>About</h2>
              <div className="card">
                <div className="row">
                  <div className="row-title">Offshore {version || '…'}</div>
                </div>
                <div className="row">
                  <div className="row-sub">
                    A calm, human browser. No telemetry, no AI — just you and the water. Built on the same
                    Chromium engine as Chrome, wearing considerably better clothes.
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
