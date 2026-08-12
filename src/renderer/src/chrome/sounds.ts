/**
 * Tiny interface sounds, synthesized on the fly — no assets, calm-coastal
 * character: triangles and sines through a gentle lowpass, everything quiet
 * and under ~150ms. Sound is a garnish, never an error.
 */

type SoundName =
  | 'tab-close'
  | 'download-complete'
  | 'bookmark-saved'
  | 'space-switch'
  | 'password-saved'

let ctx: AudioContext | null = null
let enabled = true
const lastPlayed = new Map<SoundName, number>()
let activeVoices = 0

const MIN_INTERVAL = 150
const MAX_VOICES = 3

export function setSoundsEnabled(v: boolean): void {
  enabled = v
}

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

function voice(run: (ac: AudioContext, out: GainNode, t: number) => number): void {
  if (!enabled || activeVoices >= MAX_VOICES) return
  const ac = audio()
  if (!ac) return
  try {
    const out = ac.createGain()
    out.connect(ac.destination)
    const endsAt = run(ac, out, ac.currentTime)
    activeVoices += 1
    setTimeout(() => {
      activeVoices = Math.max(0, activeVoices - 1)
      try {
        out.disconnect()
      } catch {
        /* already gone */
      }
    }, Math.max(0, (endsAt - ac.currentTime) * 1000) + 60)
  } catch {
    /* sound is a garnish, never an error */
  }
}

function tone(
  ac: AudioContext,
  out: GainNode,
  t: number,
  opts: {
    type?: OscillatorType
    from: number
    to?: number
    glideMs?: number
    gain: number
    attackMs?: number
    decayMs: number
    lowpass?: number
  }
): number {
  const osc = ac.createOscillator()
  osc.type = opts.type ?? 'sine'
  osc.frequency.setValueAtTime(opts.from, t)
  if (opts.to && opts.glideMs) {
    osc.frequency.exponentialRampToValueAtTime(opts.to, t + opts.glideMs / 1000)
  }
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attackMs ?? 10) / 1000)
  const end = t + opts.decayMs / 1000
  g.gain.exponentialRampToValueAtTime(0.0001, end)
  let node: AudioNode = osc
  if (opts.lowpass) {
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = opts.lowpass
    osc.connect(lp)
    node = lp
  }
  node.connect(g)
  g.connect(out)
  osc.start(t)
  osc.stop(end + 0.05)
  return end
}

const SOUNDS: Record<SoundName, () => void> = {
  // a soft "plip" falling like a droplet
  'tab-close': () =>
    voice((ac, out, t) =>
      tone(ac, out, t, {
        type: 'triangle',
        from: 520,
        to: 330,
        glideMs: 90,
        gain: 0.05,
        attackMs: 8,
        decayMs: 120,
        lowpass: 900
      })
    ),
  // small rising "done"
  'download-complete': () =>
    voice((ac, out, t) => {
      tone(ac, out, t, { from: 392, gain: 0.055, decayMs: 160, lowpass: 1400 })
      return tone(ac, out, t + 0.07, { from: 523, gain: 0.055, decayMs: 160, lowpass: 1400 })
    }),
  // a tiny glass "dink"
  'bookmark-saved': () =>
    voice((ac, out, t) => {
      tone(ac, out, t, { from: 659, gain: 0.03, decayMs: 110, lowpass: 2000 })
      return tone(ac, out, t, { from: 880, gain: 0.045, decayMs: 110, lowpass: 2000 })
    }),
  // a brushed "whoosh" like a small wave
  'space-switch': () =>
    voice((ac, out, t) => {
      const len = 0.14
      const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * len), ac.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      const src = ac.createBufferSource()
      src.buffer = buf
      const bp = ac.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 1.1
      bp.frequency.setValueAtTime(400, t)
      bp.frequency.exponentialRampToValueAtTime(900, t + len)
      const g = ac.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.03, t + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, t + len)
      src.connect(bp)
      bp.connect(g)
      g.connect(out)
      src.start(t)
      src.stop(t + len + 0.02)
      return t + len
    }),
  // sibling of bookmark, slightly warmer
  'password-saved': () =>
    voice((ac, out, t) => {
      tone(ac, out, t, { from: 523, gain: 0.045, decayMs: 140, lowpass: 1600 })
      return tone(ac, out, t + 0.06, { from: 659, gain: 0.045, decayMs: 140, lowpass: 1600 })
    })
}

export function playSound(name: SoundName): void {
  const now = Date.now()
  if (now - (lastPlayed.get(name) ?? 0) < MIN_INTERVAL) return
  lastPlayed.set(name, now)
  SOUNDS[name]()
}

// ---------------- onboarding tones (welcome page imports these) ----------------

/** D-major pentatonic rise, one note per onboarding step. */
export function playTone(step: number): void {
  const freqs = [294, 370, 440, 494]
  const f = freqs[Math.min(step, freqs.length - 1)]
  voice((ac, out, t) =>
    tone(ac, out, t, { type: 'triangle', from: f, gain: 0.05, attackMs: 15, decayMs: 350, lowpass: 900 })
  )
}

/** Completion flourish: A4 + D5 dyad, staggered. */
export function playArrival(): void {
  voice((ac, out, t) => {
    tone(ac, out, t, { from: 440, gain: 0.055, decayMs: 700, lowpass: 1200 })
    return tone(ac, out, t + 0.08, { from: 587, gain: 0.06, decayMs: 800, lowpass: 1200 })
  })
}
