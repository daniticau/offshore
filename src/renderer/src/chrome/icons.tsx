import React from 'react'

interface IconProps {
  size?: number
  className?: string
}

function svg(path: React.ReactNode, viewBox = '0 0 24 24') {
  return function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        {path}
      </svg>
    )
  }
}

export const IconBack = svg(<path d="M15 18l-6-6 6-6" />)
export const IconForward = svg(<path d="M9 18l6-6-6-6" />)
export const IconReload = svg(
  <>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </>
)
export const IconStop = svg(
  <>
    <path d="M18 6L6 18" />
    <path d="M6 6l12 12" />
  </>
)
export const IconPlus = svg(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>
)
export const IconClose = svg(
  <>
    <path d="M18 6L6 18" />
    <path d="M6 6l12 12" />
  </>
)
export const IconSearch = svg(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </>
)
export const IconGlobe = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
  </>
)
export const IconClock = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 3" />
  </>
)
export const IconStar = svg(
  <path d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.1-5.6-3.1-5.6 3.1 1.2-6.1L3 9.6l6.3-.8z" />
)
export const IconStarFilled = function IconStarFilled({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.1-5.6-3.1-5.6 3.1 1.2-6.1L3 9.6l6.3-.8z" />
    </svg>
  )
}
export const IconShield = svg(<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" />)
export const IconShieldFilled = function IconShieldFilled({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" />
    </svg>
  )
}
export const IconGear = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </>
)
export const IconAudio = svg(
  <>
    <path d="M11 5L6 9H2v6h4l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </>
)
export const IconMuted = svg(
  <>
    <path d="M11 5L6 9H2v6h4l5 4z" />
    <path d="M23 9l-6 6" />
    <path d="M17 9l6 6" />
  </>
)
export const IconWave = svg(
  <path d="M2 12c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3" />
)
export const IconDownload = svg(
  <>
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <path d="M4 21h16" />
  </>
)
export const IconSidebar = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9.5 4v16" />
  </>
)
export const IconFolder = svg(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
)
export const IconChevron = svg(<path d="M9 6l6 6-6 6" />)
export const IconBookmarkTray = svg(
  <>
    <path d="M7 3h10a1 1 0 0 1 1 1v16l-6-4-6 4V4a1 1 0 0 1 1-1z" />
  </>
)
export const IconArrowUpRight = svg(
  <>
    <path d="M7 17L17 7" />
    <path d="M9 7h8v8" />
  </>
)
export const IconBolt = svg(<path d="M13 2L4 14h6l-1 8 9-12h-6z" />)
export const IconKey = svg(
  <>
    <circle cx="8" cy="15" r="4.5" />
    <path d="M11.2 11.8L20 3" />
    <path d="M16.5 6.5l3 3" />
    <path d="M14 9l2.2 2.2" />
  </>
)
export const IconPopupBlocked = svg(
  <>
    <rect x="3" y="5" width="13" height="11" rx="2" />
    <path d="M9 19h12" opacity="0" />
    <rect x="11" y="10" width="10" height="9" rx="2" />
  </>
)
export const IconFinder = svg(
  <>
    <path d="M3 8l9-5 9 5" />
    <path d="M5 10v9h14v-9" />
  </>
)

export const IconLink = svg(
  <>
    <path d="M10 14a4.5 4.5 0 0 0 6.6.4l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4L11.4 6.8" />
    <path d="M14 10a4.5 4.5 0 0 0-6.6-.4l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4" />
  </>
)
export const IconCheck = svg(<path d="M4.5 12.5l5 5 10-11" />)

export const IconTune = svg(
  <>
    <path d="M4 8h10" />
    <path d="M18 8h2" />
    <circle cx="16" cy="8" r="2.2" />
    <path d="M4 16h2" />
    <path d="M10 16h10" />
    <circle cx="8" cy="16" r="2.2" />
  </>
)
export const IconMore = svg(
  <>
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="19" r="1" />
  </>
)
export const IconCode = svg(
  <>
    <path d="M8 8l-4 4 4 4" />
    <path d="M16 8l4 4-4 4" />
  </>
)
export const IconSplit = svg(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M12 5v14" />
  </>
)
export const IconLock = svg(
  <>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </>
)
export const IconUnlock = svg(
  <>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 7.4-2" />
  </>
)

export const IconAlert = svg(
  <>
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v5" />
    <circle cx="12" cy="18" r="0.4" />
  </>
)
export const IconSlop = svg(
  <>
    <path d="M5 13c2-2.4 4-2.4 6 0s4 2.4 6 0" />
    <path d="M4 4l16 16" />
    <path d="M16 5.5l0.9 2.1 2.1 0.9-2.1 0.9-0.9 2.1-0.9-2.1-2.1-0.9 2.1-0.9z" />
  </>
)
