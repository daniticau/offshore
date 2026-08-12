import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { OffshoreInternalApi } from '@shared/bridge'
import type { NewTabWidgets, SearchEngineId, Settings, TabOrientation, ThemePref } from '@shared/types'
import { DEFAULT_SETTINGS, SEARCH_ENGINES, accentColors } from '@shared/types'
import { playArrival, playTone } from '../chrome/sounds'
import { DitheredWaves } from '../theme/DitheredWaves'
import logoUrl from '../theme/offshore-logo.png'
import { useIsDark } from '../theme/useTheme'
import '../theme/theme.css'
import './welcome.css'

const internal = (window as unknown as { offshoreInternal?: OffshoreInternalApi })
  .offshoreInternal

const STEPS = 5

function Logo(): React.JSX.Element {
  return (
    <div className="logo">
      <img src={logoUrl} alt="" width={96} height={96} />
    </div>
  )
}

function App(): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [orientation, setOrientation] = useState<TabOrientation>('vertical')
  const [engine, setEngine] = useState<SearchEngineId>(DEFAULT_SETTINGS.searchEngine)
  const [theme, setTheme] = useState<ThemePref>('system')
  const [widgets, setWidgets] = useState<NewTabWidgets>(DEFAULT_SETTINGS.newTabWidgets)
  const isDark = useIsDark()

  const advance = (): void => {
    playTone(step + 1)
    setStep((s) => Math.min(s + 1, STEPS - 1))
  }

  const pickTheme = (t: ThemePref): void => {
    setTheme(t)
    // apply immediately — the whole window retints live
    void internal?.settings.set({ appearance: { ...DEFAULT_SETTINGS.appearance, theme: t } })
  }

  const finish = (skip = false): void => {
    if (!skip) playArrival()
    const patch: Partial<Settings> = skip
      ? { onboarded: true }
      : {
          tabOrientation: orientation,
          searchEngine: engine,
          appearance: { ...DEFAULT_SETTINGS.appearance, theme },
          newTabWidgets: widgets,
          onboarded: true
        }
    void internal?.settings.set(patch).then(() => internal?.open('offshore://start'))
  }

  const acc = accentColors('sea', isDark)

  const slideClass = (i: number): string =>
    `slide ${step === i ? 'active' : step > i ? 'passed' : ''}`

  return (
    <div className="welcome">
      <button className="skip" onClick={() => finish(true)}>
        Skip
      </button>

      <div className="slides">
        {/* 1 — hero */}
        <section className={slideClass(0)}>
          <Logo />
          <h1 className="wordmark">Offshore</h1>
          <p className="tagline">A calm, human browser.</p>
          <button className="cta" onClick={advance}>
            Get started
          </button>
        </section>

        {/* 2 — layout */}
        <section className={slideClass(1)}>
          <h2>Where do your tabs live?</h2>
          <p className="sub">⌘⇧B switches this any time.</p>
          <div className="layout-choices">
            <button
              className={`layout-card ${orientation === 'vertical' ? 'chosen' : ''}`}
              onClick={() => setOrientation('vertical')}
            >
              <div className="mock">
                <div className="mock-side" />
                <div className="mock-content" />
              </div>
              <span>Sidebar</span>
            </button>
            <button
              className={`layout-card ${orientation === 'horizontal' ? 'chosen' : ''}`}
              onClick={() => setOrientation('horizontal')}
            >
              <div className="mock">
                <div className="mock-top" />
                <div className="mock-content wide" />
              </div>
              <span>Top bar</span>
            </button>
          </div>
          <button className="cta" onClick={advance}>
            Next
          </button>
        </section>

        {/* 3 — search engine */}
        <section className={slideClass(2)}>
          <h2>Search with…</h2>
          <p className="sub">Change it later in Settings.</p>
          <div className="engine-choices">
            {(Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => (
              <button
                key={id}
                className={`engine-pill ${engine === id ? 'chosen' : ''}`}
                onClick={() => setEngine(id)}
              >
                {SEARCH_ENGINES[id].name}
              </button>
            ))}
          </div>
          <p className="shield-note">Suggestions are always local — keystrokes never leave your Mac.</p>
          <button className="cta" onClick={advance}>
            Next
          </button>
        </section>

        {/* 4 — new tab widgets */}
        <section className={slideClass(3)}>
          <h2>Your new tab</h2>
          <p className="sub">Time and date are always there. Add more if you like.</p>
          <div className="widget-choices">
            {(
              [
                ['greeting', 'Greeting', 'A serif good-morning line'],
                ['weather', 'Weather', 'Current conditions, no account'],
                ['forecast', 'Hourly forecast', 'The hours ahead at a glance'],
                ['sun', 'Sunrise & sunset', 'Golden-hour bookkeeping'],
                ['moon', 'Moon phase', 'Pure math, no API']
              ] as [keyof NewTabWidgets, string, string][]
            ).map(([key, label, sub]) => (
              <button
                key={key}
                className={`widget-card ${widgets[key] ? 'chosen' : ''}`}
                onClick={() => setWidgets({ ...widgets, [key]: !widgets[key] })}
              >
                <span className="widget-name">{label}</span>
                <span className="widget-sub">{sub}</span>
              </button>
            ))}
          </div>
          <p className="shield-note">
            Weather needs a location — set it any time in Settings → New Tab.
          </p>
          <button className="cta" onClick={advance}>
            Next
          </button>
        </section>

        {/* 5 — done + theme */}
        <section className={slideClass(4)}>
          <h2>You’re all set.</h2>
          <p className="sub">One more thing — pick your light.</p>
          <div className="theme-choices">
            {(
              [
                ['system', 'Auto'],
                ['light', 'Light'],
                ['dark', 'Dark']
              ] as [ThemePref, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                className={`theme-card theme-${t} ${theme === t ? 'chosen' : ''}`}
                onClick={() => pickTheme(t)}
              >
                <span className="theme-swatch" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <button className="cta big" onClick={() => finish()}>
            Start browsing
          </button>
        </section>
      </div>

      <div className="dots">
        {Array.from({ length: STEPS }, (_, i) => (
          <span key={i} className={`dot ${i === step ? 'on' : ''}`} />
        ))}
      </div>

      <DitheredWaves colors={[acc.waveA, acc.waveB, acc.waveC]} height={220} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
