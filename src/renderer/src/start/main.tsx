import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { BriefWeather, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { HomeCanvas } from './HomeCanvas'

interface InternalApi {
  settings: { get(): Promise<Settings | null>; set(p: Partial<Settings>): Promise<Settings> }
  brief: { weather(): Promise<BriefWeather | null> }
  open(url: string): Promise<void>
  onEditWidgets?(cb: () => void): void
}

const internal = (window as unknown as { offshoreInternal?: InternalApi }).offshoreInternal

/**
 * The new tab page — a thin shell around HomeCanvas, which the zero-tab window
 * renders too. Everything visible lives there; this only wires up settings,
 * weather, and where a submitted query goes (this tab navigates in place).
 */
function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [editSignal, setEditSignal] = useState(0)

  useEffect(() => {
    void internal?.settings.get().then((s) => s && setSettings(s))
    internal?.onEditWidgets?.(() => setEditSignal((n) => n + 1))
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
      editSignal={editSignal}
    />
  )
}

createRoot(document.getElementById('root')!).render(<App />)
