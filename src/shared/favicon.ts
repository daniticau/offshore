/**
 * Where to look for a site's icon, best first.
 *
 * The icon we captured while the page was open is the most accurate, but
 * bookmarks made before we recorded icons — or saved from a tab that never
 * fired page-favicon-updated — have none. For those we fall back to the site's
 * own well-known paths. Deliberately no third-party icon service: asking
 * google.com or duckduckgo.com for an icon would hand them the bookmark list.
 */
export function faviconCandidates(url?: string, stored?: string): string[] {
  const out: string[] = []
  if (stored) out.push(stored)
  try {
    const u = new URL(url ?? '')
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      out.push(`${u.origin}/favicon.ico`)
      out.push(`${u.origin}/apple-touch-icon.png`)
    }
  } catch {
    /* not a fetchable url — the caller's glyph fallback covers it */
  }
  return out.filter((c, i) => out.indexOf(c) === i)
}
