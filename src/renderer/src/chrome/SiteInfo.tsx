import React, { useState } from 'react'
import type { Settings, TabInfo } from '@shared/types'
import { SLOP_FLAG_MIN } from '@shared/types'
import { offshore, prettyHost } from './api'
import { IconFocus, IconLock, IconShieldFilled, IconSlop, IconUnlock } from './icons'

interface SiteInfoProps {
  tab: TabInfo
  settings: Settings
  shieldOff: boolean
  onToggleShield: () => void
  onClose: () => void
}

/**
 * Helium/Chrome-style site panel behind the tune button in the omnibox:
 * connection security, tracker blocking, popups, and this-site data controls.
 */
export function SiteInfo({ tab, settings, shieldOff, onToggleShield, onClose }: SiteInfoProps): React.JSX.Element {
  const [cleared, setCleared] = useState(false)
  const host = prettyHost(tab.url)
  const secure = tab.url.startsWith('https:')
  const popupsAllowed = settings.popups.allowlist.includes(host)

  return (
    <div className="site-info surface-card no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="si-head">
        <span className="si-host">{host}</span>
      </div>

      <div className={`si-row si-conn ${secure ? 'secure' : 'insecure'}`}>
        <span className="si-icon">{secure ? <IconLock size={14} /> : <IconUnlock size={14} />}</span>
        <span className="si-text">
          {secure ? 'Connection is secure' : 'Not secure — this page uses plain HTTP'}
        </span>
      </div>

      <div className="si-row">
        <span className="si-icon si-shield">
          <IconShieldFilled size={14} />
        </span>
        <span className="si-text">
          {shieldOff
            ? 'Shield is off for this site'
            : `Shield on — ${tab.blockedCount} blocked on this page`}
        </span>
        <button className="si-action" onClick={onToggleShield}>
          {shieldOff ? 'Turn on' : 'Turn off'}
        </button>
      </div>

      <div className="si-row">
        <span className="si-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="4" width="18" height="14" rx="2" />
            <rect x="7" y="20" width="10" height="1" rx="0.5" />
          </svg>
        </span>
        <span className="si-text">
          {popupsAllowed ? 'Popups are allowed here' : 'Popups need a real click'}
        </span>
        {popupsAllowed && (
          <button
            className="si-action"
            onClick={() =>
              void offshore.settings.set({
                popups: {
                  ...settings.popups,
                  allowlist: settings.popups.allowlist.filter((h) => h !== host)
                }
              })
            }
          >
            Revoke
          </button>
        )}
      </div>

      {settings.slop.detector && (
        <div className="si-row">
          <span className="si-icon si-slop">
            <IconSlop size={14} />
          </span>
          <span className="si-text">
            {!tab.slop
              ? 'Slop detector — not enough prose to judge'
              : tab.slop.score >= SLOP_FLAG_MIN
                ? `Reads like filler — slop score ${tab.slop.score}/100`
                : `Reads fine — slop score ${tab.slop.score}/100`}
          </span>
        </div>
      )}

      {tab.focusOn && (
        <div className="si-row">
          <span className="si-icon si-focus">
            <IconFocus size={13} />
          </span>
          <span className="si-text">Focus is on for this site</span>
          <button className="si-action" onClick={() => void offshore.focus.toggle()}>
            Turn off
          </button>
        </div>
      )}

      <div className="si-divider" />

      <button
        className="si-wide"
        onClick={() => {
          void offshore.privacy.clearSite().then((ok) => {
            if (ok) setCleared(true)
          })
        }}
      >
        {cleared ? 'Cleared — page reloaded ✓' : 'Clear cookies & data for this site'}
      </button>
      <button
        className="si-wide"
        onClick={() => {
          void offshore.tabs.create('offshore://settings')
          onClose()
        }}
      >
        All site settings…
      </button>
    </div>
  )
}
