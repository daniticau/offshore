import React, { useEffect, useMemo, useState } from 'react'
import { faviconCandidates } from '@shared/favicon'

interface FaviconProps {
  url?: string
  /** icon captured while the page was open, if we have one */
  stored?: string
  className?: string
  /** rendered once every candidate has failed */
  fallback: React.ReactNode
}

/** Site icon that walks its candidates on load failure before giving up. */
export function Favicon({ url, stored, className, fallback }: FaviconProps): React.JSX.Element {
  const candidates = useMemo(() => faviconCandidates(url, stored), [url, stored])
  const [step, setStep] = useState(0)

  // a new url/icon deserves a fresh run through the chain
  useEffect(() => setStep(0), [candidates])

  const src = candidates[step]
  if (!src) return <>{fallback}</>
  return (
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setStep((s) => s + 1)}
    />
  )
}
