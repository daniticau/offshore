import React, { useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Settings, TabOrientation } from '@shared/types'
import './welcome.css'

interface InternalApi {
  settings: { get(): Promise<Settings | null>; set(p: Partial<Settings>): Promise<Settings> }
  open(url: string): Promise<void>
}

const internal = (window as unknown as { offshoreInternal?: InternalApi }).offshoreInternal

/** Soft synthesized tones — no assets, very quiet, ocean-ish. */
function useTones() {
  const ctxRef = useRef<AudioContext | null>(null)
  return useCallback((step: number) => {
    try {
      ctxRef.current ??= new AudioContext()
      const ctx = ctxRef.current
      const freqs = [392, 440, 494, 523]
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 1200
      osc.type = 'sine'
      osc.frequency.value = freqs[step % freqs.length]
      gain.gain.setValueAtTime(0, ctx.currentTime)
      gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6)
      osc.connect(filter).connect(gain).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.65)
    } catch {
      /* sound is a garnish, never an error */
    }
  }, [])
}

function Logo(): React.JSX.Element {
  return (
    <div className="logo">
      <svg viewBox="0 0 96 96" width="96" height="96">
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a9e4f7" />
            <stop offset="0.5" stopColor="#56b6dc" />
            <stop offset="1" stopColor="#17719c" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="92" height="92" rx="24" fill="url(#lg)" />
        <circle cx="66" cy="26" r="11" fill="rgba(255,255,255,0.92)" />
        <path
          d="M2,64 C18,50 34,50 42,58 C46,62 44,68 38,68 C42,72 52,71 57,64 C64,54 78,53 94,60 L94,94 L2,94 Z"
          fill="rgba(255,255,255,0.88)"
        />
      </svg>
    </div>
  )
}

function Waves(): React.JSX.Element {
  return (
    <div className="waves" aria-hidden>
      <svg className="wave wave-back" viewBox="0 0 2880 220" preserveAspectRatio="none">
        <path d="M0,110 C240,60 480,160 720,110 C960,60 1200,160 1440,110 C1680,60 1920,160 2160,110 C2400,60 2640,160 2880,110 L2880,220 L0,220 Z" />
      </svg>
      <svg className="wave wave-front" viewBox="0 0 2880 220" preserveAspectRatio="none">
        <path d="M0,155 C240,110 480,200 720,155 C960,110 1200,200 1440,155 C1680,110 1920,200 2160,155 C2400,110 2640,200 2880,155 L2880,220 L0,220 Z" />
      </svg>
    </div>
  )
}

function App(): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [orientation, setOrientation] = useState<TabOrientation>('vertical')
  const play = useTones()

  const advance = (): void => {
    play(step + 1)
    setStep((s) => Math.min(s + 1, 2))
  }

  const finish = (): void => {
    play(2)
    void internal?.settings
      .set({ tabOrientation: orientation, onboarded: true })
      .then(() => internal?.open('offshore://start'))
  }

  return (
    <div className="welcome">
      <button className="skip" onClick={finish}>
        Skip
      </button>

      <div className={`slides step-${step}`}>
        {/* 1 — hero */}
        <section className={`slide ${step === 0 ? 'active' : step > 0 ? 'passed' : ''}`}>
          <Logo />
          <h1 className="wordmark">Offshore</h1>
          <p className="tagline">A calm, human browser.</p>
          <button className="cta" onClick={advance}>
            Get started
          </button>
        </section>

        {/* 2 — layout */}
        <section className={`slide ${step === 1 ? 'active' : step > 1 ? 'passed' : ''}`}>
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

        {/* 3 — done */}
        <section className={`slide ${step === 2 ? 'active' : ''}`}>
          <Logo />
          <h2>You’re all set.</h2>
          <button className="cta big" onClick={finish}>
            Start browsing
          </button>
        </section>
      </div>

      <div className="dots">
        {[0, 1, 2].map((i) => (
          <span key={i} className={`dot ${i === step ? 'on' : ''}`} />
        ))}
      </div>

      <Waves />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
