import type { SearchEngineId } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/types'

/**
 * Type-ahead from the search engine — the "ca → canvas, canva, cancel" list every
 * omnibox has.
 *
 * It is the one feature here that puts a half-typed word on the wire, so it is
 * deliberately narrow: main does the asking (never a renderer), through Node's
 * fetch rather than any Electron session, so no cookie, cache entry or
 * partition of yours is anywhere near it. One request in flight at a time, and
 * a short memory of what came back so backspacing doesn't ask twice.
 */

const TIMEOUT_MS = 2200
const CACHE_TTL = 60_000
const CACHE_MAX = 80

const cache = new Map<string, { at: number; words: string[] }>()
let inFlight: AbortController | null = null

/** Every engine here answers OpenSearch-shaped; Startpage also has an object form. */
function parse(body: unknown): string[] {
  if (Array.isArray(body)) {
    const list = body[1]
    if (Array.isArray(list)) {
      return list
        .map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v ? String((v as { phrase?: string }).phrase ?? '') : ''))
        .filter(Boolean)
    }
    // ac.duckduckgo.com without type=list answers [{phrase: "…"}, …]
    return body
      .map((v) => (typeof v === 'object' && v ? String((v as { phrase?: string }).phrase ?? '') : ''))
      .filter(Boolean)
  }
  if (body && typeof body === 'object') {
    const s = (body as { suggestions?: unknown }).suggestions
    if (Array.isArray(s)) {
      return s
        .map((v) => (typeof v === 'string' ? v : String((v as { text?: string })?.text ?? '')))
        .filter(Boolean)
    }
  }
  return []
}

function remember(key: string, words: string[]): void {
  cache.set(key, { at: Date.now(), words })
  if (cache.size > CACHE_MAX) {
    for (const k of [...cache.keys()].slice(0, cache.size - CACHE_MAX)) cache.delete(k)
  }
}

/**
 * What the engine thinks you are typing. Never throws and never waits long: a
 * slow or unreachable endpoint just means the local suggestions stand alone.
 */
export async function searchSuggestions(query: string, engineId: SearchEngineId): Promise<string[]> {
  const q = query.trim()
  if (q.length < 2 || q.length > 120) return []
  const engine = SEARCH_ENGINES[engineId] ?? SEARCH_ENGINES.duckduckgo
  const key = `${engineId}|${q.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.words

  // a keystroke ago's request is worthless the moment this one exists
  inFlight?.abort()
  const ctrl = new AbortController()
  inFlight = ctrl
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(engine.suggestUrl.replace('%s', encodeURIComponent(q)), {
      signal: ctrl.signal,
      redirect: 'follow',
      // no Referer, no cookies, nothing that says who is asking
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
      headers: { Accept: 'application/json, text/javascript, */*' }
    })
    if (!res.ok) return []
    const text = await res.text()
    let words: string[] = []
    try {
      words = parse(JSON.parse(text))
    } catch {
      return []
    }
    const ql = q.toLowerCase()
    const out: string[] = []
    const seen = new Set<string>([ql])
    for (const w of words) {
      const clean = w.replace(/\s+/g, ' ').trim().slice(0, 120)
      const lower = clean.toLowerCase()
      if (!clean || seen.has(lower)) continue
      seen.add(lower)
      out.push(clean)
      if (out.length === 6) break
    }
    remember(key, out)
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    if (inFlight === ctrl) inFlight = null
  }
}
