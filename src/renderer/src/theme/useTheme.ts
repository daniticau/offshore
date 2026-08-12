import { useEffect, useState } from 'react'
import type { AccentModeColors } from '@shared/types'

/** Tracks prefers-color-scheme, which main drives via nativeTheme.themeSource. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

/** CSS custom-property overrides for the given accent, spread onto a root element's style. */
export function accentVars(acc: AccentModeColors): Record<string, string> {
  return {
    '--accent': acc.accent,
    '--accent-strong': acc.accentStrong,
    '--tint-top': acc.tintTop,
    '--tint-bottom': acc.tintBottom
  }
}
