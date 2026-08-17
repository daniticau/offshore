import React, { useState } from 'react'
import type { MorningAnswer, MorningBrief as MorningBriefData } from '@shared/types'

/**
 * The morning brief panel — and the enable-history card. One component, two
 * states, keyed off the answer's kind. It mounts only once main has answered,
 * so it animates in after the page is already alive, and it never delays the
 * home:painted handshake (the ask happens strictly after that fires).
 *
 * House rules it keeps: only theme tokens, no eyebrow labels anywhere — every
 * heading carries its own meaning — and nothing here ever fetches anything
 * (no favicons: a monogram square instead, so no site hears about its own
 * suggestion).
 */

interface MorningBriefProps {
  answer: Exclude<MorningAnswer, { kind: 'none' }>
  /** The accent tile gradients HomeCanvas already resolved — monogram paint. */
  tiles: [string, string][]
  /** px from the top of the stage — just below the search band. */
  top: number
  /** Room to the waves. Below ~200px the brief simply waits for a roomier day. */
  maxHeight: number
  /** A row was chosen: a URL or a query, resolved by the omnibox rules. */
  onOpen(input: string): void
  onDismiss(): void
  onEnableHistory(): void
}

function DismissButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button className="morning-dismiss" title="Dismiss for today" onClick={onClick}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
      </svg>
    </button>
  )
}

function timeAgo(publishedAt: number): string {
  const ms = Math.max(0, Date.now() - publishedAt)
  const days = Math.floor(ms / 86_400_000)
  if (days < 1) return `${Math.max(1, Math.floor(ms / 3_600_000))}h ago`
  return `${days}d ago`
}

export function MorningBrief({
  answer,
  tiles,
  top,
  maxHeight,
  onOpen,
  onDismiss,
  onEnableHistory
}: MorningBriefProps): React.JSX.Element | null {
  const [leaving, setLeaving] = useState(false)
  const [historyOn, setHistoryOn] = useState(false)

  const brief: MorningBriefData | null = answer.kind === 'brief' ? answer.brief : null

  // The brief never crowds a short window; it waits for a day with more room.
  if (maxHeight < (brief ? 220 : 180)) return null

  const dismiss = (): void => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(onDismiss, 160)
  }

  if (!brief) {
    // ---- the enable-history card ----
    return (
      <div className={`morning-card enable ${leaving ? 'leaving' : ''}`} style={{ top, maxHeight }}>
        <div className="morning-head">
          <div className="morning-greeting">Want a morning brief?</div>
          <DismissButton onClick={dismiss} />
        </div>
        {historyOn ? (
          <p className="morning-enable-done">History is on. Your first brief lands tomorrow.</p>
        ) : (
          <>
            <p className="morning-enable-body">
              Turn on local history and the first tab of each day can suggest sites to revisit,
              topics to dig into, and new videos from channels you watch. It stays on this Mac —
              nothing is sent anywhere.
            </p>
            <button
              className="morning-enable-btn"
              onClick={() => {
                onEnableHistory()
                setHistoryOn(true)
              }}
            >
              Turn on local history
            </button>
          </>
        )}
      </div>
    )
  }

  // ---- the brief ----
  // Row budget: fit whole rows into the room we were given rather than clipping
  // one mid-line. Columns sit side by side, so the tallest group sets the height.
  const rowBudget = Math.max(1, Math.floor((maxHeight - 112) / 47))
  const sites = brief.sites.slice(0, Math.min(5, rowBudget))
  const topics = brief.topics.slice(0, Math.min(4, rowBudget))
  const videos = brief.videos.slice(0, Math.min(3, rowBudget))
  const groups = [sites.length > 0, topics.length > 0, videos.length > 0].filter(Boolean).length
  if (groups === 0) return null

  return (
    <div
      className={`morning-card ${groups === 1 ? 'single' : ''} ${leaving ? 'leaving' : ''}`}
      style={{ top, maxHeight }}
    >
      <div className="morning-head">
        <div className="morning-greeting">{brief.greeting}</div>
        <DismissButton onClick={dismiss} />
      </div>
      <div className="morning-body">
        {sites.length > 0 && (
          <div className="morning-group">
            <h3>Worth another look</h3>
            {sites.map((site, i) => (
              <button key={site.host} className="morning-site" onClick={() => onOpen(site.url)}>
                <span
                  className="morning-mono"
                  style={{
                    background: `linear-gradient(135deg, ${tiles[i % 6][0]}, ${tiles[i % 6][1]})`
                  }}
                >
                  {[...site.host][0]?.toUpperCase() ?? '·'}
                </span>
                <span className="morning-text">
                  <span className="morning-main">{site.host}</span>
                  <span className="morning-sub">{site.note ?? `${site.daysAway} days away`}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {topics.length > 0 && (
          <div className="morning-group">
            <h3>Something to learn</h3>
            {topics.map((topic) => (
              <button key={topic.label} className="morning-topic" onClick={() => onOpen(topic.query)}>
                <span className="morning-slot">
                  <span className="morning-dot" />
                </span>
                <span className="morning-text">
                  <span className="morning-main">{topic.label}</span>
                  <span className="morning-sub">
                    {topic.note ?? (topic.hosts.length ? `seen on ${topic.hosts.join(' and ')}` : 'from your reading')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {videos.length > 0 && (
          <div className="morning-group">
            <h3>New from your channels</h3>
            {videos.map((video) => (
              <button key={video.url} className="morning-video" onClick={() => onOpen(video.url)}>
                <span className="morning-slot play">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <path d="M2.5 1.4v7.2L8.4 5z" />
                  </svg>
                </span>
                <span className="morning-text">
                  <span className="morning-main">{video.title}</span>
                  <span className="morning-sub">
                    {video.channel} · {timeAgo(video.publishedAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
