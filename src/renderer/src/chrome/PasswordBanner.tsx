import React, { useEffect, useState } from 'react'
import type { BlockedPopup, PasswordOffer, TabInfo } from '@shared/types'
import { offshore, prettyHost } from './api'
import { playSound } from './sounds'
import { IconKey, IconPopupBlocked } from './icons'

interface PasswordBannerProps {
  offer: PasswordOffer
  onResolve: () => void
}

/** "Save password for host?" — appears near the toolbar after a login. */
export function PasswordBanner({ offer, onResolve }: PasswordBannerProps): React.JSX.Element {
  useEffect(() => {
    const t = setTimeout(onResolve, 25_000)
    return () => clearTimeout(t)
  }, [onResolve])

  const resolve = (action: 'save' | 'never' | 'dismiss'): void => {
    void offshore.passwords.resolveOffer(offer.offerId, action)
    if (action === 'save') playSound('password-saved')
    onResolve()
  }

  return (
    <div className="password-banner banner no-drag">
      <span className="pw-icon">
        <IconKey size={15} />
      </span>
      <div className="pw-text">
        <div className="pw-title">
          {offer.kind === 'update' ? 'Update password?' : 'Save password?'}
        </div>
        <div className="pw-sub">
          {offer.username ? `${offer.username} · ` : ''}
          {offer.host}
        </div>
      </div>
      <button className="pw-save" onClick={() => resolve('save')}>
        {offer.kind === 'update' ? 'Update' : 'Save'}
      </button>
      <button className="pw-never" onClick={() => resolve('never')}>
        Never
      </button>
      <button className="pw-dismiss" onClick={() => resolve('dismiss')} title="Not now">
        ✕
      </button>
    </div>
  )
}

interface PopupChipProps {
  tab: TabInfo
  open: boolean
  onToggle: (open: boolean) => void
}

/** Blocked-popup indicator + list, next to the shield. */
export function PopupChip({ tab, open, onToggle }: PopupChipProps): React.JSX.Element | null {
  const [blocked, setBlocked] = useState<BlockedPopup[]>([])

  useEffect(() => {
    if (open) {
      void offshore.popups.getBlocked(tab.id).then(setBlocked)
    }
  }, [open, tab.id])

  if (!tab.blockedPopups && !open) return null

  return (
    <div className="popup-chip-wrap">
      <button
        className={`chrome-btn popup-chip ${open ? 'open' : ''}`}
        title={`${tab.blockedPopups} popup${tab.blockedPopups === 1 ? '' : 's'} blocked`}
        onClick={() => onToggle(!open)}
      >
        <IconPopupBlocked size={14} />
        {tab.blockedPopups > 0 && (
          <span className="shield-count">{tab.blockedPopups > 9 ? '9+' : tab.blockedPopups}</span>
        )}
      </button>
      {open && (
        <div className="popup-list surface-card no-drag" onMouseDown={(e) => e.stopPropagation()}>
          <div className="popup-list-head">Popups blocked on {prettyHost(tab.url)}</div>
          {blocked.length === 0 && <div className="popup-empty">Nothing blocked right now.</div>}
          {blocked.map((b, i) => (
            <button
              key={`${b.ts}-${i}`}
              className="popup-item"
              title={b.url}
              onClick={() => {
                void offshore.popups.open(tab.id, b.url)
                onToggle(false)
              }}
            >
              <span className="popup-url">{b.url}</span>
              <span className="popup-open">Open</span>
            </button>
          ))}
          <button
            className="popup-allow"
            onClick={() => {
              void offshore.popups.allowSite(tab.id)
              onToggle(false)
            }}
          >
            Always allow popups on this site
          </button>
        </div>
      )}
    </div>
  )
}
