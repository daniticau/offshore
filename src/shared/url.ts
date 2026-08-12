/** Hostname as a human reads it — no scheme, no www., offshore:// pages kept whole. */
export function prettyHost(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'offshore:') return url.replace(/\/$/, '')
    return u.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
