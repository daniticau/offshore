import { net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { SEARCH_ENGINES, type Settings } from '@shared/types'

export function devRendererUrl(): string | undefined {
  return process.env['ELECTRON_RENDERER_URL']
}

export type InternalPage = 'start' | 'settings' | 'welcome' | 'error'

const INTERNAL_PAGES: readonly InternalPage[] = ['start', 'settings', 'welcome', 'error']

function isInternalPage(page: string): page is InternalPage {
  return (INTERNAL_PAGES as readonly string[]).includes(page)
}

/** URL to actually load in a webContents for an internal page. */
export function internalPageUrl(page: InternalPage): string {
  const dev = devRendererUrl()
  if (dev) return `${dev}/${page}.html`
  return `offshore://${page}/`
}

/** Map any loadable URL back to its pretty offshore:// form for display, if it is internal. */
export function toDisplayUrl(url: string): string {
  const dev = devRendererUrl()
  if (dev && url.startsWith(dev)) {
    const rest = url.slice(dev.length).replace(/^\//, '')
    const page = rest.replace(/\.html.*$/, '')
    if (isInternalPage(page)) return `offshore://${page}`
  }
  if (url.startsWith('offshore://')) {
    return url.replace(/\/$/, '')
  }
  return url
}

export function isInternalUrl(url: string): boolean {
  if (url.startsWith('offshore://')) return true
  const dev = devRendererUrl()
  if (dev && url.startsWith(dev)) return true
  return false
}

/** Loadable URL for the themed error page. */
export function errorPageUrl(failedUrl: string, code: number, desc: string): string {
  const qs = `?url=${encodeURIComponent(failedUrl)}&code=${code}&desc=${encodeURIComponent(desc)}`
  const dev = devRendererUrl()
  if (dev) return `${dev}/error.html${qs}`
  return `offshore://error/${qs}`
}

/** If url is our error page, return the original URL it stands in for. */
export function errorPageTarget(url: string): string | null {
  if (!isInternalUrl(url)) return null
  try {
    const u = new URL(url)
    const isErrorPage = u.protocol === 'offshore:' ? u.hostname === 'error' : u.pathname.endsWith('/error.html')
    if (!isErrorPage) return null
    return u.searchParams.get('url')
  } catch {
    return null
  }
}

/** If a stored/session url is an offshore:// display url, map to a loadable url. */
export function remapInternal(url: string): string {
  if (url.startsWith('offshore://')) {
    const page = url.replace('offshore://', '').replace(/\/.*$/, '')
    if (isInternalPage(page)) return internalPageUrl(page)
  }
  return url
}

/** Resolve what the user typed in the omnibox into a URL. */
export function resolveOmniboxInput(input: string, settings: Settings): string {
  const t = input.trim()
  if (!t) return internalPageUrl('start')
  const lower = t.toLowerCase()
  if (lower.startsWith('offshore://')) {
    const page = lower.replace('offshore://', '').replace(/\/.*$/, '')
    if (isInternalPage(page)) return internalPageUrl(page)
    return internalPageUrl('start')
  }
  if (/^(https?|file|chrome-extension|chrome|devtools):/i.test(t)) return t
  if (/^about:blank$/i.test(t)) return t
  if (/^localhost(:\d+)?([/?#]|$)/i.test(t)) return `http://${t}`
  // Looks like a bare domain, domain+path, or IP — no whitespace and a plausible host
  if (!/\s/.test(t)) {
    const host = t.split(/[/?#]/)[0]
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)) {
      return `https://${t}`
    }
  }
  const engine = SEARCH_ENGINES[settings.searchEngine] ?? SEARCH_ENGINES.duckduckgo
  return engine.searchUrl.replace('%s', encodeURIComponent(t))
}

/** Extension → MIME. Never inferred: a page served as text/plain renders as its own source. */
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  map: 'application/json; charset=utf-8'
}

/** Serve offshore:// requests. In dev, proxy to the vite dev server; in prod, serve built files. */
export async function handleOffshoreProtocol(request: Request): Promise<Response> {
  const u = new URL(request.url)
  const page = u.hostname
  const dev = devRendererUrl()
  if (!isInternalPage(page)) {
    return new Response('Not found', { status: 404 })
  }
  const path = u.pathname === '/' || u.pathname === '' ? `/${page}.html` : u.pathname
  const type = MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
  try {
    if (dev) {
      return await net.fetch(`${dev}${path}`)
    }
    const rendererDist = join(__dirname, '../renderer')
    const res = await net.fetch(pathToFileURL(join(rendererDist, path.replace(/^\//, ''))).toString())
    // file:// responses take their type from a guess about the extension; state it
    // outright so a bad guess can never turn a page into a wall of its own markup
    const headers = new Headers(res.headers)
    headers.set('content-type', type)
    return new Response(res.body, { status: res.status, headers })
  } catch {
    // a missing or unreadable file must 404, not reject — a rejected handler
    // surfaces as ERR_UNEXPECTED and takes the whole page down with it
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  }
}

export { prettyHost } from '@shared/url'

/** Chrome-like UA: drop Electron and app tokens, and reduce the Chrome version to
 * the frozen `.0.0.0` form real Chrome ships so we present an ordinary Chrome UA. */
export function normalizeUserAgent(ua: string): string {
  return ua
    .replace(/\s?Electron\/[\d.]+/i, '')
    .replace(/\s?offshore\/[\d.]+/i, '')
    .replace(/(Chrome\/\d+)\.\d+\.\d+\.\d+/i, '$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** The three low-entropy UA client hints Chrome sends to every secure origin.
 * Electron drops these when the UA is overridden — their absence next to a Chrome
 * UA is a classic bot tell (Google's "unusual traffic" page). We restore them. */
export function clientHintHeaders(): Record<string, string> {
  const major = (process.versions.chrome || '138').split('.')[0]
  const platform =
    process.platform === 'darwin' ? '"macOS"' : process.platform === 'win32' ? '"Windows"' : '"Linux"'
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Not)A;Brand";v="8", "Google Chrome";v="${major}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': platform
  }
}
