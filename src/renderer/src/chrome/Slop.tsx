import React, { useEffect } from 'react'
import type { Settings, TabInfo } from '@shared/types'
import { SLOP_FLAG_MIN, SLOP_VEIL_MIN } from '@shared/types'
import { offshore, prettyHost } from './api'
import { IconSlop } from './icons'

interface SlopChipProps {
  tab: TabInfo
  settings: Settings
  open: boolean
  onToggle: (open: boolean) => void
}

/**
 * The slop detector's face in the chrome: a chip on the address bar's trailing
 * edge, worn only by pages that earned it. The number is the score; pressing it
 * opens the report — what was counted, and the ways out (read anyway, spare the
 * site). Quiet pages get no chip at all: the detector reports in the site
 * panel, like the Shield.
 */
export function SlopChip({ tab, settings, open, onToggle }: SlopChipProps): React.JSX.Element | null {
  const report = tab.slop
  const worn = !!report && settings.slop.detector && (report.score >= SLOP_FLAG_MIN || !!report.veil)
  // a navigation clears the report out from under an open panel — the open
  // state must go with it, or the next flagged page pops the panel unasked
  useEffect(() => {
    if (open && !worn) onToggle(false)
  }, [open, worn, onToggle])
  if (!worn || !report) return null
  const heavy = report.score >= SLOP_VEIL_MIN
  return (
    <div className="slop-chip-wrap">
      <button
        className={`chrome-btn slop-chip ${heavy ? 'heavy' : ''} ${open ? 'open' : ''}`}
        title={`Reads like AI-generated filler — slop score ${report.score}/100`}
        onClick={() => onToggle(!open)}
      >
        <IconSlop size={14} />
        <span className="slop-score">{report.score}</span>
      </button>
      {open && <SlopPanel tab={tab} settings={settings} onToggle={onToggle} />}
    </div>
  )
}

function verdictLine(score: number, veil?: 'up' | 'lifted'): string {
  if (score >= SLOP_VEIL_MIN) {
    if (veil === 'up') return 'Heavy machine-generated filler — veiled before you sink time into it.'
    if (veil === 'lifted') return 'Heavy machine-generated filler. You chose to read it anyway.'
    return 'Heavy machine-generated filler.'
  }
  if (score >= SLOP_FLAG_MIN) return 'Carries several of the tells of machine-generated filler.'
  return 'Reads fine — few of the usual tells.'
}

function SlopPanel({ tab, settings, onToggle }: Omit<SlopChipProps, 'open'>): React.JSX.Element {
  const report = tab.slop!
  const host = prettyHost(tab.url)
  const allowed = settings.slop.allowlist.includes(host)
  const heavy = report.score >= SLOP_VEIL_MIN
  return (
    <div className="slop-panel surface-card no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="slop-panel-head">
        <span>Slop report</span>
        <span className="slop-panel-score">{report.score} / 100</span>
      </div>
      <div className={`slop-meter ${heavy ? 'heavy' : ''}`}>
        <i style={{ width: `${report.score}%` }} />
      </div>
      <div className="slop-verdict">{verdictLine(report.score, report.veil)}</div>
      {report.signals.length > 0 && (
        <div className="slop-signals">
          {report.signals.map((s) => (
            <span className="slop-signal" key={s.label}>
              {s.label}
              {s.count > 1 && <em>×{s.count}</em>}
            </span>
          ))}
        </div>
      )}
      <div className="slop-fine">
        Judged from {report.words.toLocaleString()} words, on this Mac — plain heuristics, no AI,
        nothing sent anywhere.
      </div>
      {report.veil === 'up' && (
        <button
          className="slop-action primary"
          onClick={() => {
            void offshore.slop.readAnyway(tab.id)
            onToggle(false)
          }}
        >
          Read anyway
        </button>
      )}
      {allowed ? (
        <div className="slop-allowed-row">
          <span>Never veiled on {host}</span>
          <button className="slop-undo" onClick={() => void offshore.slop.setAllowed(tab.id, false)}>
            Undo
          </button>
        </div>
      ) : (
        <button className="slop-action" onClick={() => void offshore.slop.setAllowed(tab.id, true)}>
          Never veil {host}
        </button>
      )}
      <button
        className="slop-action"
        onClick={() => {
          void offshore.tabs.create('offshore://settings')
          onToggle(false)
        }}
      >
        Detector settings…
      </button>
    </div>
  )
}
