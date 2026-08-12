import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { OffshoreInternalApi } from '@shared/bridge'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS, accentColors } from '@shared/types'
import { prettyHost } from '@shared/url'
import { DitheredWaves } from '../theme/DitheredWaves'
import { useIsDark } from '../theme/useTheme'
import '../theme/theme.css'
import './error.css'

const internal = (window as unknown as { offshoreInternal?: OffshoreInternalApi })
  .offshoreInternal

const params = new URLSearchParams(window.location.search)
const failedUrl = params.get('url') ?? ''
const code = Number(params.get('code') ?? 0)
const desc = params.get('desc') ?? ''

function variant(): { title: string; sub: string } {
  if (desc.startsWith('crash:')) {
    return {
      title: 'This page sank.',
      sub: 'The page crashed. A reload usually brings it right back.'
    }
  }
  switch (code) {
    case -106:
      return { title: 'You’re offshore — offline.', sub: 'No internet connection right now. Reconnect and try again.' }
    case -105:
    case -137:
      return { title: 'No land in sight.', sub: 'That address couldn’t be found. Check the URL for typos.' }
    case -102:
      return { title: 'Nobody answered.', sub: 'The site refused the connection. It may be down, or blocking this network.' }
    case -7:
    case -118:
      return { title: 'Lost at sea.', sub: 'The connection timed out. The site may be slow, or your network dropped.' }
    default:
      return { title: 'Rough waters.', sub: desc ? `The page failed to load (${desc}).` : 'The page failed to load.' }
  }
}

function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const isDark = useIsDark()

  useEffect(() => {
    void internal?.settings.get().then((s) => s && setSettings(s))
  }, [])

  const acc = accentColors(settings.appearance?.accent ?? 'sea', isDark)
  const v = variant()

  return (
    <div
      className="errorpage"
      style={{ background: `linear-gradient(180deg, ${acc.tintTop}, ${acc.tintBottom})` }}
    >
      <div className="error-card">
        <h1>{v.title}</h1>
        <p className="error-sub">{v.sub}</p>
        {failedUrl && <div className="error-url">{prettyHost(failedUrl)}</div>}
        {failedUrl && (
          <button className="error-retry" onClick={() => void internal?.open(failedUrl)}>
            Try again
          </button>
        )}
      </div>
      <DitheredWaves colors={[acc.waveA, acc.waveB, acc.waveC]} height={170} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
