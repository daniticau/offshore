import { net } from 'electron'
import type {
  MorningAnswer,
  MorningBrief,
  MorningSite,
  MorningStatus,
  MorningTopic,
  MorningVideo
} from '@shared/types'
import { JsonFile, historyStore, settingsStore, type HistoryEntry } from './stores'

/**
 * The morning brief: once a day, the first new tab greets you with sites worth
 * revisiting, topics you seem to be following, and new videos from channels you
 * watch — all distilled from local history. (Not to be confused with
 * `src/main/brief.ts`, which is the weather widget.)
 *
 * Privacy contract, in full:
 *  - Nothing leaves the machine except (a) optional cookie-less GETs to
 *    www.youtube.com for handle resolution + channel RSS, and (b) one call to a
 *    local Ollama at localhost:11434 (or OLLAMA_HOST) carrying a distilled
 *    digest — host names, visit counts, truncated titles. Never a URL, never a
 *    path, never a query string: the digest type has no URL field, and titles
 *    are scrubbed of anything URL-shaped besides.
 *  - No search-engine calls, no favicon fetches, no telemetry.
 *  - Everything it stores lives in userData/morning.json; `wipe()` resets it,
 *    and runs on Clear History, on keepHistory turning off, and on
 *    morning.enabled turning off (wired in ipc.ts / index.ts).
 */

const DAY_MS = 86_400_000

// ---------------- the day stamp ----------------

interface MorningFile {
  /** which local day the stamp is about */
  day: string
  state: 'unseen' | 'seen' | 'dismissed'
  /** lifetime ✕-count on the enable card */
  dismissCount: number
  /** false after 3 dismissals — never nag again */
  offerHistoryCard: boolean
  /** today's composed brief */
  cache: MorningBrief | null
  /** '@handle' -> UC id ('' = a failed resolve, retried after a week) */
  ytChannels: Record<string, { channelId: string; resolvedAt: number }>
}

const FALLBACK: MorningFile = {
  day: '',
  state: 'unseen',
  dismissCount: 0,
  offerHistoryCard: true,
  cache: null,
  ytChannels: {}
}

let fileHandle: JsonFile<MorningFile> | null = null
function file(): JsonFile<MorningFile> {
  if (!fileHandle) fileHandle = new JsonFile<MorningFile>('morning.json', structuredClone(FALLBACK))
  return fileHandle
}

/** The one tab today's brief (or enable card) belongs to. In-memory only —
 *  persisting it across restarts would be meaningless. */
let claimantId: number | null = null

/** A morning is a local morning: the day key is local calendar time, not UTC. */
function localDay(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** New local day: reset the stamp and today's cache. The enable-card counters
 *  and the handle→channel map persist across days. */
function rollDay(): void {
  const f = file()
  const today = localDay()
  if (f.data.day !== today) {
    f.data.day = today
    f.data.state = 'unseen'
    f.data.cache = null
    claimantId = null
    composing = null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------- distilling history ----------------

/** Hosts that are plumbing, not places — never a revisit row. */
const STOPLIST_HOSTS = new Set([
  // the four SEARCH_ENGINES search hosts
  'duckduckgo.com',
  'google.com',
  'search.brave.com',
  'startpage.com',
  // auth & consent plumbing
  'accounts.google.com',
  'consent.google.com',
  'consent.youtube.com',
  'login.microsoftonline.com',
  'localhost'
])

/** The video section owns YouTube; these never appear as revisit rows. */
const YT_REVISIT_EXCLUDE = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com'])

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

function isStoplisted(host: string): boolean {
  return STOPLIST_HOSTS.has(host) || isIpLiteral(host)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

interface HostAgg {
  host: string
  visits: number
  last: number
  frecency: number
  bestTitle: string
  bestTitleVisits: number
}

interface Distilled {
  /** every parseable host, aggregated (stoplisted ones included, flagged off later) */
  hosts: Map<string, HostAgg>
  entries: ReadonlyArray<HistoryEntry>
  /** how many non-stoplisted hosts there are — the thin gate reads this */
  placeCount: number
}

function distill(): Distilled | null {
  const entries = historyStore.entries()
  const hosts = new Map<string, HostAgg>()
  const now = Date.now()
  for (const e of entries) {
    const host = hostOf(e.url)
    if (!host) continue
    let agg = hosts.get(host)
    if (!agg) {
      agg = { host, visits: 0, last: 0, frecency: 0, bestTitle: '', bestTitleVisits: -1 }
      hosts.set(host, agg)
    }
    agg.visits += e.visitCount
    agg.last = Math.max(agg.last, e.lastVisit)
    const age = Math.max(0, now - e.lastVisit)
    agg.frecency += e.visitCount * Math.max(0.05, 1 - age / (45 * DAY_MS))
    if (e.title && e.visitCount > agg.bestTitleVisits) {
      agg.bestTitle = e.title
      agg.bestTitleVisits = e.visitCount
    }
  }
  let placeCount = 0
  for (const host of hosts.keys()) if (!isStoplisted(host)) placeCount += 1
  // Thin-history rule: too few places (or too few entries) to say anything
  // worth a card. No brief, no stamp — it may try again when history grows.
  if (placeCount < 4 || entries.length < 8) return null
  return { hosts, entries, placeCount }
}

// ---------------- heuristic tier ----------------

function daysSince(t: number): number {
  return Math.floor(Math.max(0, Date.now() - t) / DAY_MS)
}

/** Frecent but drifting: worth another look. */
function revisitSites(d: Distilled): MorningSite[] {
  const rows: HostAgg[] = []
  for (const agg of d.hosts.values()) {
    if (isStoplisted(agg.host) || YT_REVISIT_EXCLUDE.has(agg.host)) continue
    const away = daysSince(agg.last)
    if (agg.visits >= 3 && away >= 3 && away <= 45) rows.push(agg)
  }
  rows.sort((a, b) => b.frecency - a.frecency)
  return rows.slice(0, 5).map((agg) => ({
    host: agg.host,
    // Always the origin — stored deep URLs can carry tokens, and the brief is
    // a front door, not a history view.
    url: `https://${agg.host}/`,
    title: agg.bestTitle,
    daysAway: daysSince(agg.last)
  }))
}

/** Ships as a const, exactly this list (plus weekday/month names below). */
const STOPWORDS = new Set(
  (
    'the a an and or of to in on for with at by from as how what why when who is are was be ' +
    'your you my our we this that these it its not no best top new guide tutorial review vs ' +
    'versus free online official home page login sign watch video youtube google reddit wiki ' +
    'wikipedia news blog docs documentation intro part episode series day week month year today ' +
    'update com www http https ' +
    'monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun ' +
    'january february march april may june july august september october november december ' +
    'jan feb mar apr jun jul aug sep sept oct nov dec'
  ).split(/\s+/)
)

const TOKEN_SPLIT = /[^\p{L}\p{N}+#]+/u

/** Strip one trailing ` - Suffix` / ` | Suffix` / ` — Suffix` site-name segment. */
function stripTitleSuffix(title: string): string {
  let cut = -1
  for (const sep of [' - ', ' | ', ' — ']) {
    const i = title.lastIndexOf(sep)
    if (i > 0 && title.length - (i + sep.length) <= 30) cut = Math.max(cut, i)
  }
  return cut > 0 ? title.slice(0, cut) : title
}

interface TermStat {
  df: number
  hostCounts: Map<string, number>
  surfaces: Map<string, number>
  bigram: boolean
}

function topicClusters(d: Distilled): MorningTopic[] {
  const now = Date.now()
  // Corpus: entries with a nonempty title, within 14 days, newest 400.
  const corpus = d.entries
    .filter((e) => e.title && now - e.lastVisit <= 14 * DAY_MS)
    .sort((a, b) => b.lastVisit - a.lastVisit)
    .slice(0, 400)
  const firstLabels = new Set([...d.hosts.keys()].map((h) => h.split('.')[0]))

  const stats = new Map<string, TermStat>()
  const bump = (term: string, surface: string, host: string, bigram: boolean): void => {
    let s = stats.get(term)
    if (!s) {
      s = { df: 0, hostCounts: new Map(), surfaces: new Map(), bigram }
      stats.set(term, s)
    }
    s.df += 1
    s.hostCounts.set(host, (s.hostCounts.get(host) ?? 0) + 1)
    s.surfaces.set(surface, (s.surfaces.get(surface) ?? 0) + 1)
  }

  for (const e of corpus) {
    const host = hostOf(e.url) ?? ''
    const stripped = stripTitleSuffix(e.title)
    const rawTokens = stripped.split(TOKEN_SPLIT).filter(Boolean)
    // kept = survived the stopword and pure-number filters, original casing kept
    const kept = rawTokens.filter((t) => {
      const lower = t.toLowerCase()
      return !STOPWORDS.has(lower) && !/^\d+$/.test(lower)
    })
    const seen = new Set<string>() // df counts distinct entries
    for (let i = 0; i < kept.length; i++) {
      const lower = kept[i].toLowerCase()
      if (lower.length >= 4 && !firstLabels.has(lower) && !seen.has(lower)) {
        seen.add(lower)
        bump(lower, kept[i], host, false)
      }
      if (i + 1 < kept.length) {
        const a = kept[i]
        const b = kept[i + 1]
        if (a.length >= 3 && b.length >= 3) {
          const term = `${a.toLowerCase()} ${b.toLowerCase()}`
          if (!seen.has(term)) {
            seen.add(term)
            bump(term, `${a} ${b}`, host, true)
          }
        }
      }
    }
  }

  const scored: { term: string; score: number; s: TermStat }[] = []
  for (const [term, s] of stats) {
    const spread = s.hostCounts.size
    if (s.df >= 3 && spread >= 2) {
      scored.push({ term, score: s.df * (1 + 0.4 * (spread - 1)) * (s.bigram ? 1.6 : 1), s })
    }
  }
  scored.sort((a, b) => b.score - a.score)

  const chosen: { term: string; s: TermStat }[] = []
  for (const c of scored) {
    if (chosen.length === 4) break
    // drop any unigram contained in an already-chosen bigram
    if (!c.s.bigram && chosen.some((p) => p.s.bigram && p.term.split(' ').includes(c.term))) continue
    chosen.push({ term: c.term, s: c.s })
  }

  return chosen.map(({ s }) => {
    const label = [...s.surfaces.entries()].sort((a, b) => b[1] - a[1])[0][0].slice(0, 40)
    const hosts = [...s.hostCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([h]) => h)
    return { label, query: label, hosts, fromModel: false }
  })
}

/** When Ollama contributes nothing: a plain sentence, rotated by the date. */
function fallbackGreeting(): string {
  const rotation = [
    'A few threads worth picking back up.',
    "Here's what drifted while you were away.",
    'Some places you might be missed.',
    'Three small currents from your week.'
  ]
  const d = new Date()
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' })
  return `${weekday}. ${rotation[d.getDate() % 4]}`
}

// ---------------- YouTube channel picks ----------------

/**
 * What is honestly recoverable from history URLs:
 *  - /channel/UC… pages carry the channel id directly.
 *  - /@handle pages carry a handle, which needs one cookie-less resolution
 *    fetch (the RSS endpoint takes only channel_id).
 *  - /watch?v=… pages carry NO channel identity, and we do NOT fetch watch
 *    pages to find it — that would replay the user's exact watch history
 *    against youtube.com at new-tab time. A watch-only history therefore
 *    yields an empty video section, and the section collapses. By design.
 */

/** Read at call time — the test flow sets it after launch. */
function ytOrigin(): string {
  return process.env['OFFSHORE_TEST_YT_ORIGIN'] || 'https://www.youtube.com'
}

async function fetchNoCookies(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // credentials: 'omit' on every fetch this module makes — no cookies, ever
    return await net.fetch(url, { ...init, credentials: 'omit', signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

interface ChannelCandidate {
  /** channel id when known, else '@handle' */
  key: string
  channelId: string | null
  name: string
  weight: number
}

function channelCandidates(d: Distilled): ChannelCandidate[] {
  const now = Date.now()
  const byKey = new Map<string, ChannelCandidate>()
  for (const e of d.entries) {
    const host = hostOf(e.url)
    if (host !== 'youtube.com' && host !== 'm.youtube.com') continue
    let path: string
    try {
      path = new URL(e.url).pathname
    } catch {
      continue
    }
    const chan = /^\/channel\/(UC[0-9A-Za-z_-]{22})/.exec(path)
    const handle = /^\/(@[\w.-]+)/.exec(path)
    if (!chan && !handle) continue
    const key = chan ? chan[1] : handle![1].toLowerCase()
    const name = e.title.replace(/\s+-\s+YouTube$/, '').trim()
    const weight = e.visitCount * Math.max(0.05, 1 - Math.max(0, now - e.lastVisit) / (45 * DAY_MS))
    const cur = byKey.get(key)
    if (cur) {
      cur.weight += weight
      if (!cur.name && name) cur.name = name
    } else {
      byKey.set(key, { key, channelId: chan ? chan[1] : null, name, weight })
    }
  }
  return [...byKey.values()].sort((a, b) => b.weight - a.weight).slice(0, 4)
}

/** '@handle' → channel id via one cookie-less page fetch, cached in morning.json. */
async function resolveHandle(handle: string): Promise<string | null> {
  const f = file()
  try {
    const res = await fetchNoCookies(`${ytOrigin()}/${handle.replace(/^@?/, '@')}`, 4000)
    if (!res.ok) throw new Error(`http ${res.status}`)
    const text = (await res.text()).slice(0, 256 * 1024)
    const m = /"channelId":"(UC[0-9A-Za-z_-]{22})"/.exec(text)
    f.data.ytChannels[handle] = { channelId: m ? m[1] : '', resolvedAt: Date.now() }
    f.saveNow()
    return m ? m[1] : null
  } catch {
    // a failed resolve caches '' so a bad handle is not retried every morning
    f.data.ytChannels[handle] = { channelId: '', resolvedAt: Date.now() }
    f.saveNow()
    return null
  }
}

interface FeedVideo {
  id: string
  title: string
  published: number
  channel: string
}

/** Regex over machine-generated Atom — no DOM parser in main. A shape change
 *  yields zero entries and one warn, never an error surface. */
function parseFeed(xml: string): FeedVideo[] {
  const parts = xml.split(/<entry\b/)
  const channel = decodeEntities(/<name>([^<]*)</.exec(parts[0])?.[1] ?? '').trim()
  const out: FeedVideo[] = []
  for (const block of parts.slice(1)) {
    const id = /<yt:videoId>([\w-]{11})</.exec(block)?.[1]
    const title = /<title>([^<]*)</.exec(block)?.[1]
    const published = /<published>([^<]+)</.exec(block)?.[1]
    if (!id || !title || !published) continue
    const t = Date.parse(published)
    if (Number.isNaN(t)) continue
    out.push({ id, title: decodeEntities(title), published: t, channel })
  }
  return out
}

/** RSS videos resolved for this day — what composeHeuristicsNow may reuse. */
let lastVideos: { day: string; videos: MorningVideo[] } | null = null

async function fetchVideos(d: Distilled): Promise<MorningVideo[]> {
  const f = file()
  const candidates = channelCandidates(d)
  if (!candidates.length) return []

  // Resolve at most 3 unresolved handles per compose; cache hits are free.
  let resolves = 0
  const ids: { id: string; name: string }[] = []
  for (const c of candidates) {
    if (c.channelId) {
      ids.push({ id: c.channelId, name: c.name })
      continue
    }
    const cached = f.data.ytChannels[c.key]
    const age = cached ? Date.now() - cached.resolvedAt : Infinity
    if (cached && cached.channelId && age < 90 * DAY_MS) {
      ids.push({ id: cached.channelId, name: c.name })
      continue
    }
    if (cached && !cached.channelId && age < 7 * DAY_MS) continue
    if (resolves >= 3) continue
    resolves += 1
    const id = await resolveHandle(c.key)
    if (id) ids.push({ id, name: c.name })
  }
  if (!ids.length) return []

  const feeds = await Promise.all(
    ids.slice(0, 4).map(async ({ id, name }) => {
      try {
        const res = await fetchNoCookies(`${ytOrigin()}/feeds/videos.xml?channel_id=${id}`, 4000)
        if (!res.ok) throw new Error(`http ${res.status}`)
        const parsed = parseFeed(await res.text())
        return parsed.map((v) => ({ ...v, channel: v.channel || name }))
      } catch (err) {
        console.warn('[morning] channel feed unavailable:', err)
        return [] as FeedVideo[]
      }
    })
  )

  // Fresh, and not something already watched (by watch?v= substring over history).
  const historyBlob = d.entries.map((e) => e.url).join('\n')
  const now = Date.now()
  const perChannel = feeds
    .map((list) =>
      list
        .filter((v) => now - v.published <= 14 * DAY_MS && !historyBlob.includes(`watch?v=${v.id}`))
        .sort((a, b) => b.published - a.published)
    )
    .filter((list) => list.length > 0)
    .sort((a, b) => b[0].published - a[0].published)

  // Interleave newest-first: at most one per channel until 3 are filled, then seconds.
  const picked: FeedVideo[] = []
  for (let round = 0; picked.length < 3; round++) {
    let took = false
    for (const list of perChannel) {
      if (picked.length === 3) break
      if (round < list.length) {
        picked.push(list[round])
        took = true
      }
    }
    if (!took) break
  }

  return picked.map((v) => ({
    title: v.title,
    // always the real origin, even under the test override
    url: `https://www.youtube.com/watch?v=${v.id}`,
    channel: v.channel,
    publishedAt: v.published
  }))
}

// ---------------- Ollama tier ----------------

/** Read at call time; schemeless values get http://, trailing slashes go. */
function ollamaHost(): string {
  let h = process.env['OLLAMA_HOST']?.trim() || 'http://127.0.0.1:11434'
  if (!/^https?:\/\//.test(h)) h = `http://${h}`
  return h.replace(/\/+$/, '')
}

interface OllamaModelRow {
  name?: string
  details?: { parameter_size?: string }
}

function pickModel(models: OllamaModelRow[]): string | null {
  const ladder = [
    /llama3\.2/i,
    /qwen(2\.5|3)[:\-](0\.5|0\.6|1\.5|1\.7|3|4|7|8)b/i,
    /gemma[23][:\-](1|2|4)b/i,
    /phi[34]/i,
    /mistral[:\-]?7b/i
  ]
  for (const re of ladder) {
    const hit = models.find((m) => m.name && re.test(m.name))
    if (hit?.name) return hit.name
  }
  const small = models.find((m) => {
    const p = /^([\d.]+)\s*([MB])/i.exec(m.details?.parameter_size ?? '')
    if (!p) return false
    const n = parseFloat(p[1]) * (p[2].toUpperCase() === 'M' ? 0.001 : 1)
    return n > 0 && n <= 9
  })
  return small?.name ?? null
}

async function detectOllama(): Promise<{ reachable: boolean; model: string | null }> {
  try {
    const res = await fetchNoCookies(`${ollamaHost()}/api/tags`, 1500)
    if (!res.ok) return { reachable: false, model: null }
    const j = (await res.json()) as { models?: OllamaModelRow[] }
    return { reachable: true, model: pickModel(j.models ?? []) }
  } catch {
    return { reachable: false, model: null }
  }
}

/** status() detects lazily and remembers for a minute — it is a settings line,
 *  not a health monitor. */
let detectCache: { at: number; reachable: boolean; model: string | null } | null = null
async function detectCached(): Promise<{ reachable: boolean; model: string | null }> {
  if (detectCache && Date.now() - detectCache.at < 60_000) return detectCache
  const d = await detectOllama()
  detectCache = { at: Date.now(), ...d }
  return d
}

/**
 * The digest — the only thing that ever reaches the model. Host names, visit
 * counts, truncated titles. No URL field exists on this type, and the test
 * flow asserts the wire matches.
 */
interface MorningDigest {
  topHosts: { host: string; visits: number; daysSinceLast: number }[]
  recentTitles: string[]
  dayOfWeek: string
  partOfDay: 'morning' | 'afternoon' | 'evening'
}

function digestOf(d: Distilled): MorningDigest {
  const hosts = [...d.hosts.values()]
    .filter((a) => !isStoplisted(a.host))
    .sort((a, b) => b.frecency - a.frecency)
    .slice(0, 20)
    .map((a) => ({ host: a.host, visits: a.visits, daysSinceLast: daysSince(a.last) }))
  const titles: string[] = []
  const seen = new Set<string>()
  for (const e of [...d.entries].sort((a, b) => b.lastVisit - a.lastVisit)) {
    if (!e.title) continue
    // belt and braces: a page title that carries a URL does not carry it here
    const t = e.title.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 90)
    if (!t || seen.has(t)) continue
    seen.add(t)
    titles.push(t)
    if (titles.length === 30) break
  }
  const hour = new Date().getHours()
  return {
    topHosts: hosts,
    recentTitles: titles,
    dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    partOfDay: hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  }
}

const SYSTEM_PROMPT =
  'You write one small morning card for a browser start page. You are given a digest of ' +
  'locally kept browsing history: host names, visit counts, and page titles. Reply with ' +
  'JSON only, matching the schema. greeting: one warm plain sentence, no emoji, under 120 ' +
  'characters. topics: subjects this person seems to be learning or following, drawn from ' +
  'the titles; query is what they would type into a search box. Never invent a website, ' +
  'product, or fact that is not supported by the digest.'

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    greeting: { type: 'string' },
    topics: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          query: { type: 'string' },
          why: { type: 'string' }
        },
        required: ['label', 'query']
      }
    },
    siteNotes: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: { host: { type: 'string' }, why: { type: 'string' } },
        required: ['host', 'why']
      }
    }
  },
  required: ['greeting']
}

interface ModelReply {
  greeting?: unknown
  topics?: { label?: unknown; query?: unknown; why?: unknown }[]
  siteNotes?: { host?: unknown; why?: unknown }[]
}

function parseReply(content: string): ModelReply | null {
  const text = content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  try {
    const j = JSON.parse(text) as ModelReply
    if (!j || typeof j !== 'object' || typeof j.greeting !== 'string') return null
    return j
  } catch {
    return null
  }
}

async function ollamaTier(digest: MorningDigest): Promise<ModelReply | null> {
  const deadline = Date.now() + 12_000
  try {
    const det = await detectOllama()
    if (!det.reachable || !det.model) {
      console.warn('[morning] ollama unavailable — composing with heuristics')
      return null
    }
    const ask = async (format: unknown): Promise<ModelReply | null> => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      const res = await fetchNoCookies(`${ollamaHost()}/api/chat`, remaining, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: det.model,
          stream: false,
          options: { temperature: 0.4, num_predict: 500 },
          format,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(digest) }
          ]
        })
      })
      if (!res.ok) throw new Error(`http ${res.status}`)
      const j = (await res.json()) as { message?: { content?: string } }
      return parseReply(j.message?.content ?? '')
    }
    return (await ask(REPLY_SCHEMA)) ?? (await ask('json'))
  } catch (err) {
    console.warn('[morning] ollama unavailable — composing with heuristics:', err)
    return null
  }
}

// ---------------- merge — the model can never mint a destination ----------------

function cleanLine(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  return s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** True when the text would resolve to a navigation instead of a search. */
function looksLikeDestination(q: string): boolean {
  if (/:\/\//.test(q) || /^[a-z][a-z0-9+.-]*:/i.test(q)) return true
  return !/\s/.test(q) && /^[\w-]+(\.[\w-]+)+/.test(q)
}

function digestTokens(digest: MorningDigest): Set<string> {
  const out = new Set<string>()
  const add = (text: string): void => {
    for (const t of text.toLowerCase().split(TOKEN_SPLIT)) {
      if (t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t)) out.add(t)
    }
  }
  for (const t of digest.recentTitles) add(t)
  for (const h of digest.topHosts) add(h.host.replace(/\./g, ' '))
  return out
}

function applyModel(brief: MorningBrief, reply: ModelReply, digest: MorningDigest): void {
  const grounded = digestTokens(digest)
  const overlaps = (text: string): boolean =>
    text
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .some((t) => t.length >= 3 && !STOPWORDS.has(t) && grounded.has(t))

  const greeting = cleanLine(reply.greeting, 160)
  if (greeting.length >= 8 && greeting.length <= 140) brief.greeting = greeting

  const modelTopics: MorningTopic[] = []
  for (const t of reply.topics ?? []) {
    const label = cleanLine(t.label, 40)
    let query = cleanLine(t.query, 80) || label
    if (!label) continue
    if (looksLikeDestination(query)) query = label
    if (looksLikeDestination(label)) continue
    // a model topic must share ground with the digest, or it does not exist
    if (!overlaps(label) && !overlaps(query)) continue
    const why = cleanLine(t.why, 90)
    modelTopics.push({ label, query, hosts: [], note: why || undefined, fromModel: true })
    if (modelTopics.length === 4) break
  }
  if (modelTopics.length) {
    const taken = new Set(modelTopics.map((t) => t.label.toLowerCase()))
    const merged = [...modelTopics]
    for (const t of brief.topics) {
      if (merged.length === 4) break
      if (taken.has(t.label.toLowerCase()) || taken.has(t.query.toLowerCase())) continue
      merged.push(t)
    }
    brief.topics = merged
  }

  for (const n of reply.siteNotes ?? []) {
    const host = cleanLine(n.host, 100).toLowerCase().replace(/^www\./, '')
    const why = cleanLine(n.why, 90)
    if (!host || !why) continue
    // matched against the heuristic revisit list only; unmatched hosts drop
    const row = brief.sites.find((s) => s.host === host)
    if (row) row.note = why
  }

  brief.source = 'ollama'
}

// ---------------- compose orchestration ----------------

/** Test-visible count of real compositions (cache hits don't move it). */
let composeCount = 0

/** Memoized single-flight compose, keyed by day. */
let composing: { day: string; p: Promise<MorningBrief | null> } | null = null

function composeToday(): Promise<MorningBrief | null> {
  // Stamp the day before composing: a compose against a stale (or wiped) day
  // field would otherwise be destroyed by the next caller's rollDay().
  rollDay()
  const today = localDay()
  const f = file()
  if (f.data.cache?.day === today) return Promise.resolve(f.data.cache)
  if (composing?.day === today) return composing.p
  const p = compose(today)
    .catch((err) => {
      console.warn('[morning] compose failed:', err)
      return null
    })
    .then((brief) => {
      // a null (thin history) must not be memoized for the day — history may
      // grow, and tomorrow is not burned either way
      if (!brief && composing?.p === p) composing = null
      return brief
    })
  composing = { day: today, p }
  return p
}

async function compose(today: string): Promise<MorningBrief | null> {
  composeCount += 1
  const d = distill()
  if (!d) return null

  const sites = revisitSites(d)
  const topics = topicClusters(d)
  const digest = digestOf(d)

  const [videos, reply] = await Promise.all([
    Promise.race([
      fetchVideos(d).then((v) => {
        lastVideos = { day: today, videos: v }
        return v
      }),
      sleep(5000).then(() => [] as MorningVideo[])
    ]),
    ollamaTier(digest)
  ])

  if (!sites.length && !topics.length && !videos.length) return null

  const brief: MorningBrief = {
    day: today,
    greeting: fallbackGreeting(),
    sites,
    topics,
    videos,
    source: 'heuristics',
    composedAt: Date.now()
  }
  if (reply) applyModel(brief, reply, digest)

  // The slow path in get() may have cached a heuristic partial already; that
  // cache stands for the day (no mid-view content swaps) and this one yields.
  const f = file()
  if (f.data.cache?.day !== today) {
    f.data.cache = brief
    f.saveNow()
  }
  return brief
}

/** Synchronous, history-only fallback for the 1200ms race in get(). RSS videos
 *  ride along only when a warm compose already resolved them today. */
function composeHeuristicsNow(): MorningBrief | null {
  const d = distill()
  if (!d) return null
  const today = localDay()
  const sites = revisitSites(d)
  const topics = topicClusters(d)
  const videos = lastVideos?.day === today ? lastVideos.videos : []
  if (!sites.length && !topics.length && !videos.length) return null
  return {
    day: today,
    greeting: fallbackGreeting(),
    sites,
    topics,
    videos,
    source: 'heuristics',
    composedAt: Date.now()
  }
}

// ---------------- the singleton ----------------

export const morningBrief = {
  /**
   * The day-gate state machine. Runs on main's single thread; the only await
   * is the compose race, and the post-await re-check keeps two simultaneous
   * tabs from both winning.
   */
  async get(senderWcId: number): Promise<MorningAnswer> {
    rollDay()
    const f = file()
    const s = settingsStore.get()
    if (!s.morning.enabled) return { kind: 'none' }

    if (!s.keepHistory) {
      // the enable-card path
      if (!f.data.offerHistoryCard) return { kind: 'none' } // three strikes, never again
      if (f.data.state === 'unseen') {
        f.data.state = 'seen'
        claimantId = senderWcId
        f.saveNow()
        return { kind: 'enable-history' }
      }
      // a reload or refocus of the same document keeps its card
      if (f.data.state === 'seen' && claimantId === senderWcId) return { kind: 'enable-history' }
      return { kind: 'none' }
    }

    if (f.data.state === 'dismissed') return { kind: 'none' }
    if (f.data.state === 'seen') {
      return f.data.cache && claimantId === senderWcId
        ? { kind: 'brief', brief: f.data.cache }
        : { kind: 'none' }
    }

    // unseen: compose (usually answered from the warm cache), claim, stamp
    const today = f.data.day
    const raced = await Promise.race([composeToday(), sleep(1200).then(() => 'slow' as const)])
    // The partial becomes today's cache so reloads are stable; the in-flight
    // full compose is abandoned for today (compose() yields to an existing
    // same-day cache).
    const brief = raced === 'slow' ? composeHeuristicsNow() : raced
    // re-check: another tab may have claimed (or the day rolled) during the await
    if (f.data.state !== 'unseen' || f.data.day !== today) return { kind: 'none' }
    if (!brief) return { kind: 'none' } // thin history: quiet, and the day is not stamped
    f.data.state = 'seen'
    claimantId = senderWcId
    f.data.cache = brief
    f.saveNow()
    return { kind: 'brief', brief }
  },

  /** Put today away — it will not come back until tomorrow. */
  dismiss(_senderWcId: number): void {
    rollDay()
    const f = file()
    if (f.data.state === 'dismissed') return
    const wasEnableCard = !settingsStore.get().keepHistory
    f.data.state = 'dismissed'
    f.data.cache = null
    claimantId = null
    if (wasEnableCard) {
      f.data.dismissCount += 1
      if (f.data.dismissCount >= 3) f.data.offerHistoryCard = false
    }
    f.saveNow()
  },

  /** For the settings page's status line. */
  async status(): Promise<MorningStatus> {
    rollDay()
    const det = await detectCached()
    return {
      ollama: { reachable: det.reachable, host: ollamaHost(), model: det.model },
      historyEntries: historyStore.entries().length,
      todayState: file().data.state
    }
  },

  /**
   * Startup warm-compose: absorbs Ollama's cold model load so the first ⌘T
   * answers from cache instantly. The 1200ms race in get() is the backstop.
   */
  async warm(): Promise<void> {
    rollDay()
    const s = settingsStore.get()
    if (!s.morning.enabled || !s.keepHistory) return
    const f = file()
    if (f.data.state !== 'unseen' || f.data.cache) return
    await composeToday()
  },

  /** Reset morning.json to its fallback — cache, stamp, dismiss counters, the
   *  handle map, everything. Runs on Clear History, keepHistory off, and
   *  morning.enabled off. */
  wipe(): void {
    const f = file()
    f.data = structuredClone(FALLBACK)
    claimantId = null
    composing = null
    lastVideos = null
    detectCache = null
    f.saveNow()
  },

  // ---- test hooks (devshot only) ----

  /** Write yesterday into the stamp so the next get() rolls a fresh day. */
  resetDayForTest(): void {
    const f = file()
    f.data.day = localDay(new Date(Date.now() - DAY_MS))
    claimantId = null
    composing = null
    detectCache = null
    f.saveNow()
  },

  composeForTest(): Promise<MorningBrief | null> {
    return composeToday()
  },

  composeCountForTest(): number {
    return composeCount
  },

  cacheForTest(): MorningBrief | null {
    return file().data.cache
  }
}
