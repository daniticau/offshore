import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { OffshoreInternalApi } from '@shared/bridge'
import type { MorningAnswer, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { applyMuted } from '../theme/useTheme'
import { HomeCanvas } from './HomeCanvas'

const internal = (window as unknown as { offshoreInternal?: OffshoreInternalApi })
  .offshoreInternal

/*
 * The morning brief is asked for once per document — module-level flags, so the
 * visibilitychange re-load() never re-asks and a remount keeps the answer.
 * Main's day gate makes the ask idempotent for this document anyway (a reload
 * keeps its claim); this just spares the chatter.
 */
let morningAsked = false
let morningCache: MorningAnswer | null = null

/**
 * The new tab page — a thin shell around HomeCanvas, which the zero-tab window
 * renders too. Same widgets, same settings.
 *
 * Which half carries the search depends on the layout, and the rule is: whatever
 * is already in front of you. The sidebar keeps its omnibox tucked away down the
 * side, so a vertical new tab puts a pill in the middle of the page and hands it
 * the cursor. The top bar's address bar is right there above the page — so in
 * horizontal layout there is no pill at all, and the cursor starts in the
 * address bar, exactly where Chrome leaves it.
 *
 * Whether that pill is up is main's to know, not this page's: the sidebar shows
 * it too, and its ✕ is how you put it away from the other side. So the state
 * lives on the tab, and this page follows it.
 */
function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [editSignal, setEditSignal] = useState(0)
  const [searchOpen, setSearchOpen] = useState(true)
  const [morning, setMorning] = useState<MorningAnswer | null>(morningCache)

  /*
   * "The page is on screen." Main holds a new tab off screen until this lands,
   * because the document is parsed long before React has drawn into it — and a
   * tab swapped in during that gap shows its bare backdrop for a few frames,
   * which is the black flash you get opening a new tab from a new tab. The
   * settings decide what gets drawn, so the report waits for them; main gives up
   * waiting after a moment either way, so a slow read costs a beat, never a tab.
   */
  const painted = useRef(false)
  const reportPainted = (): void => {
    if (painted.current) return
    painted.current = true
    requestAnimationFrame(() => requestAnimationFrame(() => internal?.home?.painted()))
  }

  /*
   * Ask whether today's brief is this page's to show — strictly after
   * reportPainted() has fired, so the brief can never delay the home:painted
   * handshake that swaps a new tab in (tabs.ts markPainted gates on it).
   */
  const askMorning = (): void => {
    if (morningAsked || !internal?.morning) return
    morningAsked = true
    void internal.morning
      .get()
      .then((a) => {
        morningCache = a
        setMorning(a)
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    const take = (s: Settings): void => {
      setSettings(s)
      applyMuted(s.appearance?.muted === true)
    }
    const load = (): void => {
      if (!internal) return
      void internal.settings
        .get()
        .then((s) => s && take(s))
        .catch(() => undefined)
        .finally(() => {
          reportPainted()
          askMorning()
        })
    }
    load()
    // Main pushes settings changes to internal pages live (a Muted or accent
    // flip must land while this page is on screen); the visibility re-read
    // stays as belt-and-braces for anything the push predates.
    internal?.settings.onChanged(take)
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

  // horizontal layout: the address bar above the page is the search, so this
  // page carries none — and takes no focus away from it either
  const pill = settings.tabOrientation !== 'horizontal'

  return (
    <HomeCanvas
      settings={settings}
      onPatch={patch}
      onSubmit={(input) => void internal?.open(input)}
      fetchSuggestions={async (input) => (await internal?.home?.suggest(input)) ?? []}
      fetchWeather={async () => (await internal?.brief.weather()) ?? null}
      searchPill={pill}
      searchOpen={searchOpen}
      onDismissSearch={() => {
        setSearchOpen(false)
        void internal?.home.setSearch(false)
      }}
      autoFocus={pill}
      editSignal={editSignal}
      morning={morning}
      onMorningDismiss={() => {
        morningCache = { kind: 'none' }
        setMorning(null)
        void internal?.morning.dismiss()
      }}
    />
  )
}

createRoot(document.getElementById('root')!).render(<App />)
