import React from 'react'
import type { WeatherIcon } from '@shared/types'

interface Props {
  icon: WeatherIcon
  isDay: boolean
  size?: number
}

function wrap(children: React.ReactNode, size: number): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

const sun = (
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19" />
  </>
)
const moon = <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
const cloud = <path d="M6.5 18a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 16.6 8.6 4.2 4.2 0 0 1 17 17H7z" />
const cloudSmall = <path d="M8 19a3.4 3.4 0 0 1-.5-6.75A4.7 4.7 0 0 1 16.6 10a3.6 3.6 0 0 1 .4 7H8z" />

export function Weather({ icon, isDay, size = 18 }: Props): React.JSX.Element {
  switch (icon) {
    case 'sun':
      return wrap(isDay ? sun : moon, size)
    case 'cloud-sun':
      return wrap(
        <>
          {isDay ? (
            <>
              <circle cx="7.5" cy="7.5" r="2.8" />
              <path d="M7.5 2.6v1.4M2.6 7.5h1.4M4 4l1 1M11 4l-1 1" />
            </>
          ) : (
            <path d="M10 7.2A4.2 4.2 0 0 1 4.8 2 4.2 4.2 0 1 0 10 7.2z" />
          )}
          {cloudSmall}
        </>,
        size
      )
    case 'cloud':
      return wrap(cloud, size)
    case 'fog':
      return wrap(
        <>
          <path d="M6.5 13a4 4 0 0 1-.6-7.9A5.5 5.5 0 0 1 16.6 4.6 4.2 4.2 0 0 1 17 12H7z" opacity={0.9} />
          <path d="M4 16.5h16M6 20h12" />
        </>,
        size
      )
    case 'drizzle':
      return wrap(
        <>
          {cloud}
          <path d="M9 21v.2M13 21v.2M11 23v.2" strokeWidth={2.4} />
        </>,
        size
      )
    case 'rain':
      return wrap(
        <>
          {cloud}
          <path d="M8.5 20.5l-.8 1.8M12.5 20.5l-.8 1.8M16.5 20.5l-.8 1.8" transform="translate(0 -1)" />
        </>,
        size
      )
    case 'snow':
      return wrap(
        <>
          {cloud}
          <path d="M9 21h.01M13 20h.01M11 23h.01M15 22h.01" strokeWidth={2.4} />
        </>,
        size
      )
    case 'storm':
      return wrap(
        <>
          {cloud}
          <path d="M12 18l-2 3.5h3L11 25" transform="translate(0 -1.5)" />
        </>,
        size
      )
    default:
      return wrap(cloud, size)
  }
}
