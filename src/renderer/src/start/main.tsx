import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { OffshoreInternalApi } from '@shared/bridge'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { HomeCanvas } from './HomeCanvas'

const internal = (window as unknown as { offshoreInternal?: OffshoreInternalApi })
  .offshoreInternal

/**
 * The new tab page — a thin shell around HomeCanvas, which the zero-tab window
 * renders too. Same widgets, same settings; the tab is the half that carries
 * the search, and it opens with the cursor already in it, so a new tab is a
 * place you can start typing the moment it appears.
 *
 * Whether the search is up is main's to know, not this page's: the sidebar shows
 * it too, and its ✕ is how you put it away from the other side. So the state
 * lives on the tab, and this page follows it.
 */
function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [editSignal, setEditSignal] = useState(0)
  const [searchOpen, setSearchOpen] = useState(true)

  useEffect(() => {
    const load = (): void => {
      void internal?.settings.get().then((s) => s && setSettings(s))
    }
    load()
    // Settings changes reach the chrome, not tab pages — so re-read whenever
    // this page comes back into view (layout switched, widgets edited on the
    // zero-tab screen) instead of showing a stale home.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    internal?.onEditWidgets(() => setEditSignal((n) => n + 1))
    internal?.home.onSearch(setSearchOpen)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  const patch = (p: Partial<Settings>): void => {
    setSettings((prev) => ({
      ...prev,
      ...p,
      newTabWidgets: { ...prev.newTabWidgets, ...(p.newTabWidgets ?? {}) },
      newTabWidgetLayout: { ...prev.newTabWidgetLayout, ...(p.newTabWidgetLayout ?? {}) }
    }))
    void internal?.settings.set(p)
  }

  return (
    <HomeCanvas
      settings={settings}
      onPatch={patch}
      onSubmit={(input) => void internal?.open(input)}
      fetchWeather={async () => (await internal?.brief.weather()) ?? null}
      searchPill
      searchOpen={searchOpen}
      onDismissSearch={() => {
        setSearchOpen(false)
        void internal?.home.setSearch(false)
      }}
      autoFocus
      editSignal={editSignal}
    />
  )
}

createRoot(document.getElementById('root')!).render(<App />)
