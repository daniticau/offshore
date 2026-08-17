import React from 'react'
import type { Settings, TabInfo } from '@shared/types'
import { offshore } from './api'
import { IconFocus } from './icons'

/**
 * Focus's face in the chrome: one chip in the address pill's actions cluster,
 * where the pencil and the sparkle used to sit. No panel, no menu — Focus has
 * exactly one move, so the chip is the whole interface: press to strip the
 * page and close the gaps, press again to put everything back. Lit while the
 * site is focused; the state is per-site memory, so it survives the tab.
 */
export function FocusChip({ tab, settings }: { tab: TabInfo; settings: Settings }): React.JSX.Element | null {
  const onPage =
    settings.focus.enabled && /^https?:/.test(tab.url) && !tab.displayUrl.startsWith('offshore://')
  if (!onPage) return null
  return (
    <button
      className={`chrome-btn focus-chip ${tab.focusOn ? 'active' : ''}`}
      title={
        tab.focusOn
          ? 'Focused — distractions stripped, remembered for this site (⇧⌘F)'
          : 'Focus this page (⇧⌘F)'
      }
      onClick={() => void offshore.focus.toggle()}
    >
      <IconFocus size={14} />
    </button>
  )
}
