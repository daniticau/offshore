import { app, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { SEARCH_ENGINES, type Settings } from '@shared/types'

export const isDev = !app.isPackaged

export function devRendererUrl(): string | undefined {
  return process.env['ELECTRON_RENDERER_URL']
}

export type InternalPage = 'start' | 'settings' | 'welcome'

export const INTERNAL_PAGES: readonly InternalPage[] = ['start', 'settings', 'welcome']

export function isInternalPage(page: string): page is InternalPage {
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

/** Serve offshore:// requests. In dev, proxy to the vite dev server; in prod, serve built files. */
export function handleOffshoreProtocol(request: Request): Promise<Response> | Response {
  const u = new URL(request.url)
  const page = u.hostname
  const dev = devRendererUrl()
  if (!isInternalPage(page)) {
    return new Response('Not found', { status: 404 })
  }
  const path = u.pathname === '/' || u.pathname === '' ? `/${page}.html` : u.pathname
  if (dev) {
    return net.fetch(`${dev}${path}`)
  }
  const rendererDist = join(__dirname, '../renderer')
  return net.fetch(pathToFileURL(join(rendererDist, path.replace(/^\//, ''))).toString())
}

export function prettyHost(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'offshore:') return url.replace(/\/$/, '')
    return u.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Chrome-like UA: drop Electron and app tokens so sites treat us as Chrome. */
export function normalizeUserAgent(ua: string): string {
  return ua
    .replace(/\s?Electron\/[\d.]+/i, '')
    .replace(/\s?offshore\/[\d.]+/i, '')
}
