import React, { useEffect, useState } from 'react'
import type { Settings, SiteReport, TabInfo } from '@shared/types'
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

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1).replace(/\.0$/, '')} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** 14px circle-with-bites — the cookie. */
function IconCookie(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-9-9c0 2 1.5 3.5 3.5 3.5S19 8 21 12Z" />
      <circle cx="9" cy="10" r="0.6" fill="currentColor" />
      <circle cx="13" cy="15" r="0.6" fill="currentColor" />
      <circle cx="8.5" cy="15.5" r="0.6" fill="currentColor" />
    </svg>
  )
}

/** Small speech-bubble-check — the answered cookie prompt. */
function IconConsent(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
      <path d="M8.5 12l2.4 2.4 4.6-4.8" />
    </svg>
  )
}

/** Two waves — the tide (the slop glyph's wave, without the strike). */
function IconTide(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 9.5c2-2.4 4-2.4 6 0s4 2.4 6 0" />
      <path d="M4 15.5c2-2.4 4-2.4 6 0s4 2.4 6 0" />
    </svg>
  )
}

/**
 * Helium/Chrome-style site panel behind the tune button in the omnibox:
 * connection security, tracker blocking, cookies + consent + the tide
 * (Harbor), popups, and this-site data controls.
 *
 * Freeze-frame contract: the panel opens over a still of the page, so every
 * row is on screen at its final height from the first paint — async report
 * data fills in behind an "…" placeholder, and nothing may grow the panel.
 * The page keeps running behind the still, so the set of rows is captured
 * once at mount (rowsAtOpen); live events may update a mounted row's text,
 * never add or remove a row.
 */
export function SiteInfo({ tab, settings, shieldOff, onToggleShield, onClose }: SiteInfoProps): React.JSX.Element {
  const [cleared, setCleared] = useState(false)
  const [report, setReport] = useState<SiteReport | null>(null)
  const host = prettyHost(tab.url)
  const secure = tab.url.startsWith('https:')
  const popupsAllowed = settings.popups.allowlist.includes(host)
  const consent = tab.privacy?.consent ?? 'none'
  const stripped = tab.privacy?.cookiesStripped ?? 0
  const scrubbed = tab.privacy?.cookiesScrubbed ?? 0
  // Row PRESENCE is decided once, at open: the page keeps running behind the
  // still, and a strip or consent event mid-open must not pop a row in (or
  // out) under the pointer. Contents inside a mounted row stay live.
  const [rowsAtOpen] = useState(() => ({
    consent: settings.privacy.consentAuto && (tab.privacy?.consent ?? 'none') !== 'none',
    stripped: (tab.privacy?.cookiesStripped ?? 0) + (tab.privacy?.cookiesScrubbed ?? 0) > 0,
    // Focus's only surface in the chrome now (the omnibox chip is retired), so
    // the row is here whenever the master switch is — on or off for the site.
    focus: settings.focus.enabled
  }))

  useEffect(() => {
    let alive = true
    void offshore.privacy.siteReport().then((r) => {
      if (alive) setReport(r)
    })
    return () => {
      alive = false
    }
    // settings.privacy changes on every list flip, so the report follows it
  }, [tab.id, tab.url, settings.privacy])

  const cookieText =
    report === null
      ? '…'
      : report.cookieCount === 0 && !report.storageBytes
        ? 'Nothing stored here'
        : `${report.cookieCount} cookie${report.cookieCount === 1 ? '' : 's'}${
            report.storageBytes ? ` · ${fmtBytes(report.storageBytes)} stored` : ''
          }`

  const tideText =
    report === null
      ? '…'
      : report.keep
        ? 'Cookies here never expire'
        : report.blocked
          ? 'Cookies from this site are blocked'
          : 'Cookies stay while you keep visiting'

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

      <div className="si-row si-cookie si-fixed">
        <span className="si-icon">
          <IconCookie />
        </span>
        <span className="si-text">{cookieText}</span>
      </div>

      {rowsAtOpen.consent && (
        <div className={`si-row si-consent si-fixed ${consent === 'handled' ? 'handled' : ''}`}>
          <span className="si-icon">
            <IconConsent />
          </span>
          <span className="si-text">
            {consent === 'handled'
              ? `Cookie prompt answered — most private choice${tab.privacy?.cmp ? ` (${tab.privacy.cmp})` : ''}`
              : consent === 'found'
                ? 'Cookie prompt found — answering…'
                : 'Cookie prompt found — couldn’t answer it'}
          </span>
        </div>
      )}

      {rowsAtOpen.stripped && (
        <div className="si-row si-strip si-fixed">
          <span className="si-icon">
            <IconShieldFilled size={12} />
          </span>
          <span className="si-text">
            {scrubbed > 0 && stripped > 0
              ? `${stripped} tracker cookie${stripped === 1 ? '' : 's'} kept out of requests · ${scrubbed} scrubbed from the jar`
              : scrubbed > 0
                ? `${scrubbed} tracker cookie${scrubbed === 1 ? '' : 's'} scrubbed from the jar`
                : `${stripped} tracker cookie${stripped === 1 ? '' : 's'} kept out of requests`}
          </span>
        </div>
      )}

      <div className="si-row si-tide si-fixed">
        <span className="si-icon">
          <IconTide />
        </span>
        <span className="si-text">{tideText}</span>
        <button
          className="si-action"
          onClick={() => void offshore.privacy.setSite('keep', !(report?.keep ?? false))}
        >
          {report?.keep ? 'Allowed ✓' : 'Always allow'}
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
            {settings.slop.quiet.includes(host)
              ? tab.slop
                ? `Detector quiet here — would score ${tab.slop.score}/100`
                : 'Detector quiet on this site'
              : !tab.slop
                ? 'Slop detector — not enough prose to judge'
                : tab.slop.score >= SLOP_FLAG_MIN
                  ? `Reads like filler — slop score ${tab.slop.score}/100`
                  : `Reads fine — slop score ${tab.slop.score}/100`}
          </span>
          <button
            className="si-action"
            onClick={() =>
              void offshore.slop.setQuiet(tab.id, !settings.slop.quiet.includes(host))
            }
          >
            {settings.slop.quiet.includes(host) ? 'Wake' : 'Quiet'}
          </button>
        </div>
      )}

      {rowsAtOpen.focus && (
        <div className="si-row">
          <span className="si-icon si-focus">
            <IconFocus size={13} />
          </span>
          <span className="si-text">{tab.focusOn ? 'Focus is on for this site' : 'Focus is off for this site'}</span>
          <button className="si-action" onClick={() => void offshore.focus.toggle()}>
            {tab.focusOn ? 'Turn off' : 'Turn on'}
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
        className="si-wide si-block"
        onClick={() => void offshore.privacy.setSite('block', !(report?.blocked ?? false))}
      >
        {report?.blocked ? 'Unblock this site' : 'Block cookies from this site'}
      </button>
      <div className="si-row si-harbor-toggle si-fixed">
        <span className="si-text">
          {report === null
            ? '…'
            : report.off
              ? 'Privacy protections are off here'
              : 'Privacy protections are on here'}
        </span>
        <button
          className="si-action"
          onClick={() => void offshore.privacy.setSite('off', !(report?.off ?? false))}
        >
          {report?.off ? 'Turn on' : 'Turn off'}
        </button>
      </div>
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
