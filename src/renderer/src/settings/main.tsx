import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AccentId, Bookmark, ExtensionInfo, Settings } from '@shared/types'
import { ACCENTS, ADBLOCK_LISTS, DEFAULT_SETTINGS, SEARCH_ENGINES } from '@shared/types'
import './settings.css'

interface InternalApi {
  settings: { get(): Promise<Settings | null>; set(p: Partial<Settings>): Promise<Settings> }
  bookmarks: { list(): Promise<Bookmark[]>; remove(idOrUrl: string): Promise<void> }
  extensions: { list(): Promise<ExtensionInfo[]>; uninstall(id: string): Promise<void> }
  history: { clear(): Promise<void> }
  open(url: string): Promise<void>
}

const internal = (window as unknown as { offshoreInternal?: InternalApi }).offshoreInternal

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  )
}

function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([])
  const [rulesDraft, setRulesDraft] = useState('')
  const [rulesSaved, setRulesSaved] = useState(false)
  const [historyCleared, setHistoryCleared] = useState(false)

  useEffect(() => {
    void internal?.settings.get().then((s) => {
      if (s) {
        setSettings(s)
        setRulesDraft(s.adblock.customRules)
      }
    })
    void internal?.bookmarks.list().then((b) => b && setBookmarks(b))
    void internal?.extensions.list().then((e) => e && setExtensions(e))
  }, [])

  const patch = (p: Partial<Settings>): void => {
    const next = { ...settings, ...p, adblock: { ...settings.adblock, ...(p.adblock ?? {}) } }
    setSettings(next)
    void internal?.settings.set(p)
  }

  const patchAdblock = (p: Partial<Settings['adblock']>): void => {
    patch({ adblock: { ...settings.adblock, ...p } })
  }

  return (
    <div className="settings">
      <header>
        <h1>Settings</h1>
      </header>

      {/* ---------------- General ---------------- */}
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
            <div className="segmented">
              <button
                className={settings.tabOrientation === 'vertical' ? 'seg-on' : ''}
                onClick={() => patch({ tabOrientation: 'vertical' })}
              >
                Sidebar
              </button>
              <button
                className={settings.tabOrientation === 'horizontal' ? 'seg-on' : ''}
                onClick={() => patch({ tabOrientation: 'horizontal' })}
              >
                Top bar
              </button>
            </div>
          </div>
          <div className="row">
            <div className="row-title">Restore tabs on launch</div>
            <Toggle on={settings.restoreSession} onChange={(v) => patch({ restoreSession: v })} />
          </div>
          <div className="row">
            <div className="row-title">Auto mini-player</div>
            <Toggle on={settings.autoPip} onChange={(v) => patch({ autoPip: v })} />
          </div>
        </div>
      </section>

      {/* ---------------- Appearance ---------------- */}
      <section>
        <h2>Appearance</h2>
        <div className="card">
          <div className="row">
            <div className="row-title">Accent</div>
            <div className="accent-dots">
              {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
                <button
                  key={id}
                  className={`accent-dot ${settings.appearance.accent === id ? 'chosen' : ''}`}
                  style={{
                    background: `linear-gradient(145deg, ${ACCENTS[id].tiles[0][0]}, ${ACCENTS[id].tiles[0][1]})`
                  }}
                  title={ACCENTS[id].name}
                  onClick={() => patch({ appearance: { ...settings.appearance, accent: id } })}
                />
              ))}
            </div>
          </div>
          <div className="row">
            <div className="row-title">Waves on the start page</div>
            <Toggle
              on={settings.appearance.waves}
              onChange={(v) => patch({ appearance: { ...settings.appearance, waves: v } })}
            />
          </div>
          {settings.appearance.waves && (
            <div className="row">
              <div className="row-title">Wave style</div>
              <div className="segmented">
                <button
                  className={settings.appearance.waveStyle === 'classic' ? 'seg-on' : ''}
                  onClick={() =>
                    patch({ appearance: { ...settings.appearance, waveStyle: 'classic' } })
                  }
                >
                  Classic
                </button>
                <button
                  className={settings.appearance.waveStyle === 'dithered' ? 'seg-on' : ''}
                  onClick={() =>
                    patch({ appearance: { ...settings.appearance, waveStyle: 'dithered' } })
                  }
                >
                  Dithered
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ---------------- Shield ---------------- */}
      <section>
        <h2>Shield</h2>
        <div className="card">
          <div className="row">
            <div className="row-title">Enable Shield</div>
            <Toggle on={settings.adblock.enabled} onChange={(v) => patchAdblock({ enabled: v })} />
          </div>
          {ADBLOCK_LISTS.map((list) => (
            <div className="row" key={list.id}>
              <div className="row-title">{list.name}</div>
              <Toggle
                on={settings.adblock.lists[list.id] ?? list.defaultOn}
                onChange={(v) => patchAdblock({ lists: { ...settings.adblock.lists, [list.id]: v } })}
              />
            </div>
          ))}
          <div className="row column">
            <div className="row-title">Custom rules</div>
            <textarea
              value={rulesDraft}
              spellCheck={false}
              placeholder={'||example.com^\nexample.org##.ad-banner'}
              onChange={(e) => {
                setRulesDraft(e.target.value)
                setRulesSaved(false)
              }}
            />
            <button
              className="primary"
              onClick={() => {
                patchAdblock({ customRules: rulesDraft })
                setRulesSaved(true)
              }}
            >
              {rulesSaved ? 'Saved ✓' : 'Apply rules'}
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
        </div>
      </section>

      {/* ---------------- Extensions ---------------- */}
      <section>
        <h2>Extensions</h2>
        <div className="card">
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
            <div className="row-title">Chrome Web Store</div>
            <button className="primary" onClick={() => void internal?.open('https://chromewebstore.google.com/')}>
              Open Web Store
            </button>
          </div>
        </div>
      </section>

      {/* ---------------- Bookmarks ---------------- */}
      <section>
        <h2>Bookmarks</h2>
        <div className="card">
          {bookmarks.length === 0 && (
            <div className="row">
              <div className="row-title">No bookmarks yet</div>
            </div>
          )}
          {bookmarks.map((b) => (
            <div className="row" key={b.id}>
              <div className="bm-info">
                <div className="row-title clamp">{b.title}</div>
                <button className="link" onClick={() => void internal?.open(b.url)}>
                  {b.url}
                </button>
              </div>
              <button
                className="danger"
                onClick={() => {
                  void internal?.bookmarks.remove(b.id).then(() => {
                    setBookmarks((prev) => prev.filter((x) => x.id !== b.id))
                  })
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- Privacy ---------------- */}
      <section>
        <h2>Privacy</h2>
        <div className="card">
          <div className="row">
            <div className="row-title">Clear browsing history</div>
            <button
              className="danger"
              onClick={() => {
                void internal?.history.clear()
                setHistoryCleared(true)
              }}
            >
              {historyCleared ? 'Cleared ✓' : 'Clear history'}
            </button>
          </div>
        </div>
      </section>

      <footer>Offshore 0.1.0</footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
