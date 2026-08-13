import React, { useEffect } from 'react'
import type { Settings, TabInfo } from '@shared/types'
import { offshore, prettyHost } from './api'
import { IconSparkle } from './icons'

interface ModesChipProps {
  tab: TabInfo
  settings: Settings
  open: boolean
  onToggle: (open: boolean) => void
}

/**
 * The Page Cleaner's face in the chrome: a chip beside the pencil with the
 * two switches a page can be read under. Clean hides what the slop detector
 * flagged; Focus hides the furniture around the content. Both are remembered
 * for the site, so a page you cleaned stays clean next week.
 */
export function ModesChip({ tab, settings, open, onToggle }: ModesChipProps): React.JSX.Element | null {
  const onPage =
    settings.cleaner.enabled && /^https?:/.test(tab.url) && !tab.displayUrl.startsWith('offshore://')
  // navigation can carry the tab somewhere the chip doesn't show — close with it
  useEffect(() => {
    if (open && !onPage) onToggle(false)
  }, [open, onPage, onToggle])
  if (!onPage) return null
  const active = tab.modes.clean || tab.modes.focus
  return (
    <div className="modes-chip-wrap">
      <button
        className={`chrome-btn modes-chip ${active ? 'active' : ''} ${open ? 'open' : ''}`}
        title="Page Cleaner — Clean and Focus modes"
        onClick={() => onToggle(!open)}
      >
        <IconSparkle size={14} />
      </button>
      {open && <ModesPanel tab={tab} settings={settings} />}
    </div>
  )
}

function ModesPanel({ tab, settings }: { tab: TabInfo; settings: Settings }): React.JSX.Element {
  const detectorOn = settings.slop.detector
  return (
    <div className="modes-panel surface-card no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mp-head">
        <span>Page Cleaner</span>
        <span className="mp-host">{prettyHost(tab.url)}</span>
      </div>
      <div className="mp-row">
        <div className="mp-meta">
          <div className="mp-title">Clean</div>
          <div className="mp-sub">
            {detectorOn
              ? 'Hide the prose the slop detector flags'
              : 'Needs the Slop Detector switched on'}
          </div>
        </div>
        <button
          className="si-action"
          disabled={!detectorOn}
          onClick={() => void offshore.pageEdits.setMode('clean', !tab.modes.clean)}
        >
          {tab.modes.clean ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <div className="mp-row">
        <div className="mp-meta">
          <div className="mp-title">Focus</div>
          <div className="mp-sub">Hide rails, promos and sticky bars around the content</div>
        </div>
        <button
          className="si-action"
          onClick={() => void offshore.pageEdits.setMode('focus', !tab.modes.focus)}
        >
          {tab.modes.focus ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <div className="mp-fine">Remembered for this site until you turn it back off.</div>
    </div>
  )
}
