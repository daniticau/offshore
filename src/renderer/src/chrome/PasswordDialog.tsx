import React, { useEffect, useRef, useState } from 'react'
import type { BlockedPopup, PasswordOffer, TabInfo } from '@shared/types'
import { offshore, prettyHost } from './api'
import { playSound } from './sounds'
import { IconKey, IconPopupBlocked } from './icons'

interface PasswordDialogProps {
  offer: PasswordOffer
  onResolve: () => void
}

/**
 * "Save password for host?" — a dialog in the middle of the window, over a page
 * that has been dimmed out of the way.
 *
 * It used to be a banner pinned to the side of the chrome, where it collided
 * with the tab strip and was easy to miss. A password is a decision worth
 * stopping for, so it stops you: the answer is right where you are looking, and
 * nothing happens until you give one. It never times out — a prompt that
 * vanishes on its own asks you to notice it, which is backwards.
 */
export function PasswordDialog({ offer, onResolve }: PasswordDialogProps): React.JSX.Element {
  const saveRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    saveRef.current?.focus()
  }, [])

  const resolve = (action: 'save' | 'never' | 'dismiss'): void => {
    void offshore.passwords.resolveOffer(offer.offerId, action)
    if (action === 'save') playSound('password-saved')
    onResolve()
  }
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve

  // Escape means "not now" from wherever the cursor happens to be
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolveRef.current('dismiss')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const update = offer.kind === 'update'

  return (
    <div className="pw-scrim no-drag" onMouseDown={() => resolve('dismiss')}>
      <div
        className="pw-modal surface-card"
        role="dialog"
        aria-modal="true"
        aria-label={update ? 'Update password' : 'Save password'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="pw-icon">
          <IconKey size={22} />
        </span>
        <div className="pw-title">{update ? 'Update this password?' : 'Save this password?'}</div>
        <div className="pw-sub">
          {offer.username ? `${offer.username} · ` : ''}
          {offer.host}
        </div>
        <div className="pw-note">
          Kept on this Mac only, encrypted with your keychain. Nothing is synced anywhere.
        </div>
        <div className="pw-actions">
          <button ref={saveRef} className="pw-save" onClick={() => resolve('save')}>
            {update ? 'Update' : 'Save'}
          </button>
          <button className="pw-not-now" onClick={() => resolve('dismiss')}>
            Not now
          </button>
        </div>
        <button className="pw-never" onClick={() => resolve('never')}>
          Never for this site
        </button>
      </div>
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
