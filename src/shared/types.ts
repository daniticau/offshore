export interface TabInfo {
  id: number
  url: string
  displayUrl: string
  title: string
  favicon?: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  muted: boolean
  blockedCount: number
  isBookmarked: boolean
}

export interface TabsState {
  tabs: TabInfo[]
  activeTabId: number
}

export type SearchEngineId = 'duckduckgo' | 'google' | 'brave' | 'startpage'
export type TabOrientation = 'vertical' | 'horizontal'

export interface AdblockSettings {
  enabled: boolean
  /** list id -> enabled */
  lists: Record<string, boolean>
  /** raw filter rules, one per line */
  customRules: string
  /** hostnames where blocking is disabled */
  allowlist: string[]
}

export interface HomeShortcut {
  title: string
  url: string
}

export type AccentId = 'sea' | 'kelp' | 'dusk' | 'sand'
export type WaveStyle = 'classic' | 'dithered'

export interface AppearanceSettings {
  waves: boolean
  waveStyle: WaveStyle
  accent: AccentId
}

export interface AccentSpec {
  name: string
  sea: string
  seaDeep: string
  tintTop: string
  tintBottom: string
  waveA: string
  waveB: string
  waveC: string
  tiles: [string, string][]
}

export const ACCENTS: Record<AccentId, AccentSpec> = {
  sea: {
    name: 'Sea',
    sea: '#1d84ad',
    seaDeep: '#0e6b8c',
    tintTop: 'rgba(213,240,252,0.5)',
    tintBottom: 'rgba(183,224,244,0.35)',
    waveA: 'rgba(125,199,230,0.28)',
    waveB: 'rgba(95,179,215,0.34)',
    waveC: 'rgba(58,152,194,0.4)',
    tiles: [
      ['#8fd6ef', '#4aa9cf'],
      ['#7fcbe8', '#3d95bd'],
      ['#a3e0f2', '#5cb4d6'],
      ['#8ed2e6', '#4d9fc4'],
      ['#b0e4f5', '#68bcd9'],
      ['#86cfe9', '#4299c2']
    ]
  },
  kelp: {
    name: 'Kelp',
    sea: '#1d9c85',
    seaDeep: '#0d7a67',
    tintTop: 'rgba(214,247,238,0.5)',
    tintBottom: 'rgba(180,236,222,0.35)',
    waveA: 'rgba(120,214,192,0.28)',
    waveB: 'rgba(88,196,172,0.34)',
    waveC: 'rgba(52,168,143,0.4)',
    tiles: [
      ['#84dcc4', '#3daf92'],
      ['#96e2cd', '#4bbd9f'],
      ['#7ed5bd', '#35a487'],
      ['#a4e7d4', '#57c4a8'],
      ['#8bdec7', '#41b295'],
      ['#79d2b8', '#2f9c80']
    ]
  },
  dusk: {
    name: 'Dusk',
    sea: '#6d7fd0',
    seaDeep: '#4d5cab',
    tintTop: 'rgba(228,232,252,0.5)',
    tintBottom: 'rgba(206,212,246,0.35)',
    waveA: 'rgba(160,172,232,0.28)',
    waveB: 'rgba(136,150,222,0.34)',
    waveC: 'rgba(108,124,206,0.4)',
    tiles: [
      ['#aab6ee', '#6d7fd0'],
      ['#b8c2f2', '#7c8cd8'],
      ['#9fadea', '#5f70c6'],
      ['#c2cbf5', '#8a99dd'],
      ['#a4b1ec', '#6577cc'],
      ['#94a3e6', '#5566bf']
    ]
  },
  sand: {
    name: 'Sand',
    sea: '#c98a4b',
    seaDeep: '#a86c2f',
    tintTop: 'rgba(252,242,228,0.55)',
    tintBottom: 'rgba(246,226,200,0.4)',
    waveA: 'rgba(232,190,140,0.3)',
    waveB: 'rgba(222,172,116,0.36)',
    waveC: 'rgba(206,150,88,0.42)',
    tiles: [
      ['#eec49a', '#c98a4b'],
      ['#f2cfa8', '#d2954f'],
      ['#e9ba8c', '#bf7f41'],
      ['#f5d7b5', '#d99f5c'],
      ['#ecc094', '#c68746'],
      ['#e5b283', '#b87838']
    ]
  }
}

export interface Settings {
  tabOrientation: TabOrientation
  searchEngine: SearchEngineId
  adblock: AdblockSettings
  homeShortcuts: HomeShortcut[]
  restoreSession: boolean
  /** Pop playing video into a floating mini-player when its tab is backgrounded */
  autoPip: boolean
  appearance: AppearanceSettings
  /** First-launch onboarding completed */
  onboarded: boolean
}

export interface Bookmark {
  id: string
  title: string
  url: string
  createdAt: number
}

export interface Suggestion {
  kind: 'url' | 'search' | 'history' | 'bookmark' | 'internal'
  /** text shown prominently */
  text: string
  /** what gets navigated to (url or search query url) */
  url: string
  title?: string
}

export interface AdblockListMeta {
  id: string
  name: string
  description: string
  defaultOn: boolean
}

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  icon?: string
}

export interface FindResult {
  activeMatch: number
  matches: number
}

export interface DownloadItemInfo {
  id: string
  filename: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  savePath: string
}

export const SEARCH_ENGINES: Record<SearchEngineId, { name: string; searchUrl: string }> = {
  duckduckgo: { name: 'DuckDuckGo', searchUrl: 'https://duckduckgo.com/?q=%s' },
  google: { name: 'Google', searchUrl: 'https://www.google.com/search?q=%s' },
  brave: { name: 'Brave Search', searchUrl: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', searchUrl: 'https://www.startpage.com/sp/search?query=%s' }
}

export const ADBLOCK_LISTS: AdblockListMeta[] = [
  { id: 'easylist', name: 'EasyList', description: 'The classic ad-blocking list', defaultOn: true },
  { id: 'easyprivacy', name: 'EasyPrivacy', description: 'Blocks trackers and analytics', defaultOn: true },
  { id: 'ublock-ads', name: 'uBlock filters — Ads', description: 'uBlock Origin ad filters', defaultOn: true },
  { id: 'ublock-privacy', name: 'uBlock filters — Privacy', description: 'uBlock Origin privacy filters', defaultOn: true },
  { id: 'ublock-unbreak', name: 'uBlock filters — Unbreak', description: 'Fixes sites broken by blocking', defaultOn: true },
  { id: 'peter-lowe', name: "Peter Lowe's list", description: 'Ad and tracking server hosts', defaultOn: true },
  { id: 'annoyances', name: 'Fanboy Annoyances', description: 'Cookie banners, popups, widgets', defaultOn: false }
]

export const ADBLOCK_LIST_URLS: Record<string, string[]> = {
  easylist: ['https://easylist.to/easylist/easylist.txt'],
  easyprivacy: ['https://easylist.to/easylist/easyprivacy.txt'],
  'ublock-ads': ['https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.min.txt'],
  'ublock-privacy': ['https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.min.txt'],
  'ublock-unbreak': ['https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt'],
  'peter-lowe': ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext'],
  annoyances: ['https://secure.fanboy.co.nz/fanboy-annoyance.txt']
}

export const DEFAULT_SETTINGS: Settings = {
  tabOrientation: 'vertical',
  searchEngine: 'google',
  adblock: {
    enabled: true,
    lists: Object.fromEntries(ADBLOCK_LISTS.map((l) => [l.id, l.defaultOn])),
    customRules: '',
    allowlist: []
  },
  homeShortcuts: [
    { title: 'YouTube', url: 'https://www.youtube.com' },
    { title: 'GitHub', url: 'https://github.com' },
    { title: 'Reddit', url: 'https://www.reddit.com' },
    { title: 'Wikipedia', url: 'https://www.wikipedia.org' }
  ],
  restoreSession: true,
  autoPip: true,
  appearance: { waves: true, waveStyle: 'classic', accent: 'sea' },
  onboarded: false
}
