// ---------------- Tabs & spaces ----------------

export type SpaceProfile = 'shared' | 'separate'

export interface SpaceInfo {
  id: string
  name: string
  /** Optional per-space accent; undefined = follow global appearance accent */
  accent?: AccentId
  /** 'separate' gives the space its own cookie jar (session partition) */
  profile: SpaceProfile
}

export interface TabInfo {
  id: number
  spaceId: string
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
  blockedPopups: number
  isBookmarked: boolean
  /** The slop detector's verdict on the loaded page; absent until it reports */
  slop?: SlopReport
  /** Harbor's per-document verdict: cookies stripped, consent handled. */
  privacy?: TabPrivacyInfo
  /** Focus is on for this tab's site (per-site memory; see focusStore). */
  focusOn: boolean
  /**
   * A home screen with its search still up. Only ever true for a blank new tab:
   * the search is a panel over the home page, and dismissing it leaves the page.
   */
  homeSearch?: boolean
}

export interface TabsState {
  tabs: TabInfo[]
  activeTabId: number
  spaces: SpaceInfo[]
  activeSpaceId: string
  /** Two tab ids sharing the content area, when split view is on */
  splitPair: [number, number] | null
  /**
   * A page has taken the whole window (a video gone full screen). The chrome
   * gets out of the way entirely while this is true — no strip, no edge to hover.
   */
  contentFullscreen: boolean
  /** Where DevTools are right now, so the toolbar can offer the other place */
  devtools: DevToolsState | null
}

export type SearchEngineId = 'duckduckgo' | 'google' | 'brave' | 'startpage'
export type TabOrientation = 'vertical' | 'horizontal'
export type ToolbarDensity = 'classic' | 'compact' | 'dynamic'

/**
 * Where DevTools open. 'right'/'bottom' dock them into the window beside the
 * page (the sidebar); 'window' gives them a window of their own.
 */
export type DevToolsDock = 'right' | 'bottom' | 'window'

export interface DevToolsState {
  /** The tab being inspected. */
  tabId: number
  /** false = floating in its own window. */
  docked: boolean
  /** Which side it is docked to; meaningless while undocked. */
  side: 'right' | 'bottom'
  /**
   * The whole panel in window coordinates, header strip included — null while
   * the panel isn't on screen. The chrome draws under the views, so the only
   * place it can put a close button is a strip the DevTools view leaves bare;
   * main reserves that strip and hands over the rectangle to paint it in.
   */
  rect: { x: number; y: number; width: number; height: number } | null
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Docked DevTools take a third of the content card, within these limits. */
export const DEVTOOLS_MIN = 260
export const DEVTOOLS_MAX = 720
/** Breathing room between the page and the panel beside it. */
export const DEVTOOLS_GAP = 6
/**
 * The strip along the top of a docked panel, which is not the panel: the chrome
 * draws its name and its ✕ there, the way Chromium puts a close button on its
 * own DevTools. The front-end never sees those pixels — the view starts below
 * them — so the button is ours to place and ours to style.
 */
export const DEVTOOLS_HEAD = 26

/**
 * Where docked DevTools go inside a content card, header included. Main lays the
 * view out from this and the chrome draws the header from it, so the two can
 * never disagree about where the panel is.
 */
export function devtoolsPanelRect(area: Rect, side: 'right' | 'bottom'): Rect | null {
  if (side === 'bottom') {
    const wanted = Math.min(DEVTOOLS_MAX, Math.max(DEVTOOLS_MIN, Math.round(area.height / 3)))
    const height = Math.min(wanted, area.height - DEVTOOLS_MIN)
    if (height <= DEVTOOLS_HEAD) return null
    return { x: area.x, y: area.y + area.height - height, width: area.width, height }
  }
  const wanted = Math.min(DEVTOOLS_MAX, Math.max(DEVTOOLS_MIN, Math.round(area.width / 3)))
  const width = Math.min(wanted, area.width - DEVTOOLS_MIN)
  if (width <= 0) return null
  return { x: area.x + area.width - width, y: area.y, width, height: area.height }
}

export interface AdblockSettings {
  enabled: boolean
  /** list id -> enabled */
  lists: Record<string, boolean>
  /** raw filter rules, one per line */
  customRules: string
  /** hostnames where blocking is disabled */
  allowlist: string[]
}

export interface PopupSettings {
  /** Block popups that aren't backed by a recent user gesture */
  block: boolean
  /** hostnames allowed to open popups freely */
  allowlist: string[]
}

// ---------------- Slop detector ----------------

/** The chip appears in the address bar from this score up. */
export const SLOP_FLAG_MIN = 25
/** From this score up the chip goes red and the verdict reads "heavy". */
export const SLOP_HEAVY_MIN = 55

/** One tell the detector counted — a stock phrase, a structural habit. */
export interface SlopSignal {
  label: string
  count: number
}

/**
 * What the page preload's prose scan reported for the loaded page. Pure local
 * heuristics — the score is deterministic and the signals are the receipts.
 */
export interface SlopReport {
  /** 0–100; see SLOP_FLAG_MIN / SLOP_HEAVY_MIN for what the chrome does with it */
  score: number
  /** words of prose the scan judged from */
  words: number
  /** the tells found, heaviest first, at most a handful */
  signals: SlopSignal[]
  /** the block census behind the edge bars */
  blocks: { total: number; marked: number; heavy: number }
}

export interface SlopSettings {
  /** Scan pages for the tells of machine-generated filler */
  detector: boolean
  /** Bar the flagged prose — a slim colored edge on each block that carries the tells */
  highlight: boolean
  /** hostnames where the detector stays quiet — no chip, no bars; SiteInfo still reports */
  quiet: string[]
}

/** The edge-bar tiers: a prose block wears the deepest tier it clears. */
export const SLOP_BLOCK_TIERS = [
  { tier: 'red', min: 65 },
  { tier: 'orange', min: 45 },
  { tier: 'yellow', min: 25 }
] as const

// ---------------- Focus ----------------

/** The Focus built-in: one switch that strips a page's distractions and
 *  compacts the layout around what's left. Per-site state lives in
 *  src/main/focus.ts; this is only the master switch. */
export interface FocusSettings {
  enabled: boolean
}

export interface PasswordSettings {
  /** Master switch for saving prompts + autofill */
  enabled: boolean
}

export interface BriefSettings {
  enabled: boolean
  locationName: string
  lat: number | null
  lon: number | null
  unit: 'auto' | 'c' | 'f'
}

// ---------------- Morning brief ----------------
// (`brief` above is the WEATHER widget; everything here is named `morning`.)

export interface MorningSettings {
  /** The once-a-day brief on the first new tab. Needs keepHistory to do anything. */
  enabled: boolean
}

/** A site worth going back to — always the host's front door, never a deep URL. */
export interface MorningSite {
  /** bare host, www. stripped */
  host: string
  /** always `https://${host}/` */
  url: string
  /** best title on file for the host, '' allowed */
  title: string
  /** whole days since last visit */
  daysAway: number
  /** one model-composed line, replaces the daysAway sub-line */
  note?: string
}

export interface MorningTopic {
  /** display form, <= 40 chars, original casing */
  label: string
  /** what a click searches for (goes through the omnibox resolver) */
  query: string
  /** up to 2 hosts it was seen on — the receipts line */
  hosts: string[]
  /** model's one-line why, <= 90 chars */
  note?: string
  fromModel: boolean
}

export interface MorningVideo {
  title: string
  /** https://www.youtube.com/watch?v=<id> — always the real origin */
  url: string
  channel: string
  /** ms epoch */
  publishedAt: number
}

export interface MorningBrief {
  /** 'YYYY-MM-DD', local calendar date */
  day: string
  /** one plain sentence */
  greeting: string
  sites: MorningSite[] // 0..5
  topics: MorningTopic[] // 0..4
  videos: MorningVideo[] // 0..3
  source: 'heuristics' | 'ollama'
  composedAt: number
}

/** What the start page hears when it asks whether today's brief is its to show. */
export type MorningAnswer =
  | { kind: 'brief'; brief: MorningBrief }
  | { kind: 'enable-history' }
  | { kind: 'none' }

export interface MorningStatus {
  ollama: { reachable: boolean; host: string; model: string | null }
  historyEntries: number
  todayState: 'unseen' | 'seen' | 'dismissed'
}

export type AccentId = 'sea' | 'kelp' | 'dusk' | 'sand'
export type WaveStyle = 'classic' | 'dithered'
export type ThemePref = 'system' | 'light' | 'dark'

export interface NewTabWidgets {
  clock: boolean
  date: boolean
  greeting: boolean
  weather: boolean
  /** hourly strip under the weather line */
  forecast: boolean
  /** sunrise & sunset times (needs a location, from Open-Meteo) */
  sun: boolean
  /** current moon phase — pure local math, no network */
  moon: boolean
}

/**
 * Where a widget sits on the home grid, how many cells it takes, and which of
 * its looks it wears. Positions are grid cells, never pixels — the grid is a
 * fixed 12 × 10 (see HomeCanvas), so a layout survives any window size. A
 * widget with no position yet is placed for you the first time it is drawn.
 */
export interface WidgetLayout {
  /** Left edge, in cells from the left of the grid. */
  col?: number
  /** Top edge, in cells from the top of the grid. */
  row?: number
  /** Width in cells — always even, so the box can sit dead centre. */
  w?: number
  /** Height in cells — always even. */
  h?: number
  style?: string
}

export interface AppearanceSettings {
  theme: ThemePref
  waves: boolean
  waveStyle: WaveStyle
  accent: AccentId
  /** A custom accent hex (e.g. "#7a4de0"); when set it overrides the preset. */
  accentCustom?: string | null
}

// ---------------- Accents (light + dark) ----------------

export interface AccentModeColors {
  accent: string
  accentStrong: string
  tintTop: string
  tintBottom: string
  waveA: string
  waveB: string
  waveC: string
  tiles: [string, string][]
}

export interface AccentSpec {
  name: string
  light: AccentModeColors
  dark: AccentModeColors
}

export const ACCENTS: Record<AccentId, AccentSpec> = {
  sea: {
    name: 'Sea',
    light: {
      accent: '#1d84ad',
      accentStrong: '#0e6b8c',
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
    dark: {
      accent: '#4db2d8',
      accentStrong: '#8fd4ec',
      tintTop: 'rgba(14,36,50,0.55)',
      tintBottom: 'rgba(8,22,32,0.42)',
      waveA: 'rgba(46,118,158,0.34)',
      waveB: 'rgba(34,96,134,0.42)',
      waveC: 'rgba(24,76,110,0.5)',
      tiles: [
        ['#2f7ea6', '#175a7c'],
        ['#2a739a', '#134f6e'],
        ['#3689b2', '#1d6486'],
        ['#28688c', '#114863'],
        ['#3d95bd', '#20688a'],
        ['#245f80', '#0e3f58']
      ]
    }
  },
  kelp: {
    name: 'Kelp',
    light: {
      accent: '#1d9c85',
      accentStrong: '#0d7a67',
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
    dark: {
      accent: '#3fbfa2',
      accentStrong: '#8fe0cc',
      tintTop: 'rgba(10,34,28,0.55)',
      tintBottom: 'rgba(6,22,18,0.42)',
      waveA: 'rgba(36,124,104,0.34)',
      waveB: 'rgba(26,102,86,0.42)',
      waveC: 'rgba(18,80,68,0.5)',
      tiles: [
        ['#26866e', '#145847'],
        ['#1f7a64', '#0f4d3e'],
        ['#2d9179', '#1a614f'],
        ['#1a6f5a', '#0b4436'],
        ['#339c83', '#206a57'],
        ['#166351', '#073a2e']
      ]
    }
  },
  dusk: {
    name: 'Dusk',
    light: {
      accent: '#6d7fd0',
      accentStrong: '#4d5cab',
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
    dark: {
      accent: '#8b9ae0',
      accentStrong: '#b8c2f2',
      tintTop: 'rgba(20,24,46,0.55)',
      tintBottom: 'rgba(12,15,32,0.42)',
      waveA: 'rgba(84,96,168,0.34)',
      waveB: 'rgba(68,80,148,0.42)',
      waveC: 'rgba(52,62,124,0.5)',
      tiles: [
        ['#515fae', '#323c78'],
        ['#4a58a5', '#2c3670'],
        ['#5a68b8', '#3a4484'],
        ['#424f9a', '#252e64'],
        ['#6472c2', '#434e90'],
        ['#3a4790', '#1f2858']
      ]
    }
  },
  sand: {
    name: 'Sand',
    light: {
      accent: '#c98a4b',
      accentStrong: '#a86c2f',
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
    },
    dark: {
      accent: '#d9a05e',
      accentStrong: '#eec49a',
      tintTop: 'rgba(40,28,14,0.52)',
      tintBottom: 'rgba(26,18,8,0.4)',
      waveA: 'rgba(150,104,52,0.34)',
      waveB: 'rgba(126,86,40,0.42)',
      waveC: 'rgba(100,66,28,0.5)',
      tiles: [
        ['#96682f', '#63421c'],
        ['#8a5f2e', '#5c3d1a'],
        ['#a37436', '#6f4b21'],
        ['#7e5527', '#523414'],
        ['#b07f3e', '#7a5527'],
        ['#714b20', '#452b0f']
      ]
    }
  }
}

export function accentColors(id: AccentId, dark: boolean): AccentModeColors {
  const spec = ACCENTS[id] ?? ACCENTS.sea
  return dark ? spec.dark : spec.light
}

// ---------------- Custom accent (derive a full palette from one hex) ----------------

function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s, l]
}

function hsl(h: number, s: number, l: number, a?: number): string {
  const clampedS = Math.max(0, Math.min(1, s))
  const clampedL = Math.max(0, Math.min(1, l))
  const base = `${Math.round(h)} ${Math.round(clampedS * 100)}% ${Math.round(clampedL * 100)}%`
  return a == null ? `hsl(${base})` : `hsl(${base} / ${a})`
}

/** Build the full accent palette (tints, waves, tiles) from a single hex color. */
export function customAccentColors(hex: string, dark: boolean): AccentModeColors {
  const parsed = hexToHsl(hex)
  if (!parsed) return accentColors('sea', dark)
  const [h, s] = parsed
  // Normalize lightness so wildly light/dark picks still read as an accent
  const sat = Math.max(0.25, Math.min(0.85, s))
  if (!dark) {
    return {
      accent: hsl(h, sat, 0.42),
      accentStrong: hsl(h, sat, 0.3),
      tintTop: hsl(h, sat, 0.9, 0.5),
      tintBottom: hsl(h, sat, 0.82, 0.35),
      waveA: hsl(h, sat, 0.68, 0.28),
      waveB: hsl(h, sat, 0.6, 0.34),
      waveC: hsl(h, sat, 0.5, 0.4),
      tiles: [0, 1, 2, 3, 4, 5].map((i) => [
        hsl(h + i * 4 - 10, sat, 0.72),
        hsl(h + i * 4 - 10, sat, 0.5)
      ]) as [string, string][]
    }
  }
  return {
    accent: hsl(h, sat, 0.58),
    accentStrong: hsl(h, sat, 0.74),
    tintTop: hsl(h, sat, 0.14, 0.55),
    tintBottom: hsl(h, sat, 0.08, 0.42),
    waveA: hsl(h, sat, 0.36, 0.34),
    waveB: hsl(h, sat, 0.28, 0.42),
    waveC: hsl(h, sat, 0.22, 0.5),
    tiles: [0, 1, 2, 3, 4, 5].map((i) => [
      hsl(h + i * 4 - 10, sat, 0.36),
      hsl(h + i * 4 - 10, sat, 0.22)
    ]) as [string, string][]
  }
}

/** The palette the whole app should use: custom hex wins over the preset. */
export function resolveAccentColors(appearance: AppearanceSettings, dark: boolean): AccentModeColors {
  if (appearance.accentCustom) return customAccentColors(appearance.accentCustom, dark)
  return accentColors(appearance.accent, dark)
}

// ---------------- Settings ----------------

export interface Settings {
  tabOrientation: TabOrientation
  searchEngine: SearchEngineId
  adblock: AdblockSettings
  popups: PopupSettings
  /** Harbor: consent auto-answer, tracker-cookie stripping, the tide. */
  privacy: PrivacySettings
  passwords: PasswordSettings
  brief: BriefSettings
  /** The once-a-day morning brief on the first new tab (not the weather widget). */
  morning: MorningSettings
  restoreSession: boolean
  /** Remember visited pages so they can come back as omnibox suggestions. Off by default. */
  keepHistory: boolean
  /**
   * Ask the search engine what you might be typing. It is the one thing in
   * Offshore that sends a half-typed word anywhere, so it says so out loud in
   * Settings — and it goes through main with no cookies attached.
   */
  searchSuggestions: boolean
  /** ⌘S: the chrome is tucked away until you ask for it at the edge. */
  chromeHidden: boolean
  /** Show bookmarks in the chrome: sidebar tree (vertical) / bar under the toolbar (horizontal). */
  bookmarksBar: boolean
  /** What the new-tab page shows. Time and date by default; the rest is opt-in. */
  newTabWidgets: NewTabWidgets
  /** Which widget gets first claim on a cell when the grid places them for you. */
  newTabWidgetOrder: (keyof NewTabWidgets)[]
  /** Per-widget cell, size + style, set by dragging in the page's edit mode. */
  newTabWidgetLayout: Partial<Record<keyof NewTabWidgets, WidgetLayout>>
  /** Local heuristic prose analysis that flags AI-generated-looking pages. No AI involved. */
  slop: SlopSettings
  /** The Focus built-in: strip distractions and close the gaps, per site */
  focus: FocusSettings
  /** Pop playing video into a floating mini-player when its tab is backgrounded */
  autoPip: boolean
  /** Tiny interface sounds (tab close, download done, …) */
  uiSounds: boolean
  toolbarDensity: ToolbarDensity
  /** Where ⌥⌘I puts DevTools. Docked beside the page by default, like Chromium. */
  devtoolsDock: DevToolsDock
  appearance: AppearanceSettings
  /** First-launch onboarding completed */
  onboarded: boolean
}

// ---------------- Bookmarks (v2: tree) ----------------

export interface BookmarkNode {
  id: string
  parentId: string | null
  /** position among siblings */
  index: number
  type: 'folder' | 'bookmark'
  title: string
  url?: string
  favicon?: string
  createdAt: number
}

// ---------------- Session persistence (v2) ----------------

export interface SessionSpaceV2 {
  id: string
  name: string
  accent?: AccentId
  profile?: SpaceProfile
  tabs: { url: string }[]
  activeTabIndex: number
}

export interface SessionWindowV2 {
  bounds?: { x: number; y: number; width: number; height: number }
  spaces: SessionSpaceV2[]
  activeSpaceId: string
}

export interface SessionV2 {
  version: 2
  windows: SessionWindowV2[]
}

// ---------------- Omnibox / palette ----------------

export type ActionId =
  | 'new-tab'
  | 'new-window'
  | 'close-tab'
  | 'reopen-tab'
  | 'new-space'
  | 'toggle-layout'
  | 'toggle-sidebar'
  | 'focus-page'
  | 'open-settings'
  | 'open-downloads'
  | 'show-welcome'
  | 'cycle-theme'

export interface ActionDef {
  id: ActionId
  label: string
  /** extra match words beyond the label */
  keywords: string
}

export const ACTION_DEFS: ActionDef[] = [
  { id: 'new-tab', label: 'New Tab', keywords: 'create open' },
  { id: 'new-window', label: 'New Window', keywords: 'create open' },
  { id: 'close-tab', label: 'Close Tab', keywords: 'remove' },
  { id: 'reopen-tab', label: 'Reopen Closed Tab', keywords: 'restore undo' },
  { id: 'new-space', label: 'New Space', keywords: 'workspace create' },
  { id: 'toggle-layout', label: 'Switch Tab Layout', keywords: 'sidebar top bar horizontal vertical' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', keywords: 'hide show collapse' },
  { id: 'focus-page', label: 'Focus This Page', keywords: 'declutter strip clean ads sidebar rails comments distraction reader' },
  { id: 'open-settings', label: 'Open Settings', keywords: 'preferences options' },
  { id: 'open-downloads', label: 'Open Downloads Folder', keywords: 'finder files' },
  { id: 'show-welcome', label: 'Show Welcome', keywords: 'onboarding intro tour' },
  { id: 'cycle-theme', label: 'Cycle Theme', keywords: 'dark light system appearance mode' }
]

export interface Suggestion {
  kind: 'url' | 'search' | 'history' | 'bookmark' | 'internal' | 'tab' | 'action'
  /** text shown prominently */
  text: string
  /** what gets navigated to (url or search query url) */
  url: string
  title?: string
  /** site icon we already have on file; the row falls back to the site's own */
  favicon?: string
  /** kind 'tab': the tab to switch to */
  tabId?: number
  /** kind 'action': what to run */
  action?: ActionId
}

// ---------------- Adblock ----------------

export interface AdblockListMeta {
  id: string
  name: string
  description: string
  defaultOn: boolean
}

/** Lifetime Shield ledger — requests blocked across all tabs, since `since`. */
export interface ShieldStats {
  blockedTotal: number
  /** epoch ms when the counter started (first run of this build) */
  since: number
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

/** Space the chrome reserves around the page card, measured from its own DOM. */
export interface Insets {
  top: number
  left: number
  right: number
  bottom: number
}

/**
 * A still of one page view. The chrome renders *under* the page views, so a
 * panel that overhangs the content can only be seen once the view is hidden —
 * which used to blank the page out. Instead main hands over a picture of what
 * was there, the chrome paints it in the same place, and only then does the
 * live view step aside. See OffshoreWindow.setOverlay.
 */
export interface PageFreezeFrame {
  tabId: number
  /**
   * A photograph of the page — or null when the chrome is to draw that page
   * itself, live, because it already knows how to (the home screen).
   */
  dataUrl: string | null
  bounds: { x: number; y: number; width: number; height: number }
}

/** What rides the downloads:event channel while a download runs. */
export interface DownloadItemInfo {
  id: string
  filename: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
}

// ---------------- Passwords ----------------

export interface PasswordMeta {
  id: string
  origin: string
  host: string
  username: string
  createdAt: number
  lastUsedAt: number
}

export interface PasswordOffer {
  offerId: string
  tabId: number
  host: string
  username: string
  kind: 'new' | 'update'
}

export interface PasswordsStatus {
  available: boolean
  canTouchId: boolean
}

// ---------------- Popups ----------------

export interface BlockedPopup {
  url: string
  ts: number
}

// ---------------- Harbor (privacy manager) ----------------

export interface PrivacySettings {
  /** Answer cookie prompts automatically with the most private choice. */
  consentAuto: boolean
  /** Strip cookies from requests already classified as tracking. */
  cookieGuard: boolean
  /** Auto-expire cookies+storage of sites not visited top-level in tideDays. */
  tide: boolean
  /** 14 | 30 | 60 | 90 (validated on write; anything else coerces to 30). */
  tideDays: number
  /** Registrable domains where Harbor does nothing at all (as the visited site). */
  disabledSites: string[]
  /** Registrable domains whose cookies are never stripped and never expire. */
  keepSites: string[]
  /** Registrable domains the user declared trackers: stripped as third-party, expired every sweep. */
  blockSites: string[]
}

/** What Harbor knows about the loaded page, riding TabInfo. */
export interface TabPrivacyInfo {
  /** Tracker cookies kept out of requests made by this page (this document). */
  cookiesStripped: number
  /** Consent auto-answer state for this document. */
  consent: 'none' | 'found' | 'handled' | 'failed'
  /** CMP name when one was detected (e.g. "Cybotcookiebot"). */
  cmp?: string
}

/** The site panel's deep report (privacy:site-report). */
export interface SiteReport {
  host: string
  /** Registrable domain the per-site switches key on. */
  domain: string
  cookieCount: number
  /** navigator.storage.estimate() usage for the page origin; null when unknown. */
  storageBytes: number | null
  trackersBlocked: number
  cookiesStripped: number
  consent: TabPrivacyInfo['consent']
  cmp?: string
  /** Last top-level visit (UTC day start ms) from the engagement map; null = never seen. */
  lastVisit: number | null
  keep: boolean
  blocked: boolean
  off: boolean
}

export interface ExpiredSite {
  domain: string
  expiredAt: number
  cookieCount: number
}

/**
 * Hosts Harbor never touches, ever — SSO, payment, bot-check and DRM/CDN
 * domains where a stripped or expired cookie means a broken login, a failed
 * checkout, or dead playback. Matching is suffix-based:
 * host === entry || host.endsWith('.' + entry).
 */
export const PRIVACY_NEVER_TOUCH: readonly string[] = [
  // sign-in providers
  'accounts.google.com', 'accounts.youtube.com', 'gstatic.com',
  'appleid.apple.com', 'idmsa.apple.com',
  'login.microsoftonline.com', 'login.live.com', 'login.windows.net',
  'okta.com', 'auth0.com', 'onelogin.com', 'duosecurity.com', 'pingidentity.com',
  // payment
  'paypal.com', 'stripe.com', 'stripe.network', 'braintreegateway.com',
  'braintree-api.com', 'adyen.com', 'klarna.com', 'checkout.com',
  // bot checks (a stripped cookie = an endless challenge loop)
  'recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com',
  // DRM / streaming (Netflix must keep working — locked requirement)
  'netflix.com', 'nflxvideo.net', 'nflxso.net', 'nflximg.net', 'nflxext.com',
  'spotify.com', 'scdn.co'
] as const

// ---------------- Weather brief ----------------

export type WeatherIcon =
  | 'sun'
  | 'cloud-sun'
  | 'cloud'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'storm'

export interface BriefWeather {
  location: string
  unit: 'c' | 'f'
  now: { temp: number; code: number; isDay: boolean }
  hi: number
  lo: number
  hours: { hour: string; temp: number; code: number; isDay: boolean }[]
  /** local times, e.g. "6:12 AM" — present when the API provided them */
  sunrise?: string
  sunset?: string
  fetchedAt: number
}

// ---------------- Downloads ----------------

export interface DownloadEntry {
  id: string
  filename: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
}

export interface GeocodeResult {
  name: string
  admin1?: string
  country?: string
  lat: number
  lon: number
}

/** WMO weather code -> label + icon (sun/cloud-sun swap to moon variants at night in the UI) */
export function weatherCondition(code: number): { label: string; icon: WeatherIcon } {
  if (code === 0) return { label: 'clear', icon: 'sun' }
  if (code === 1 || code === 2) return { label: 'partly cloudy', icon: 'cloud-sun' }
  if (code === 3) return { label: 'overcast', icon: 'cloud' }
  if (code === 45 || code === 48) return { label: 'foggy', icon: 'fog' }
  if (code >= 51 && code <= 57) return { label: 'drizzling', icon: 'drizzle' }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: 'raining', icon: 'rain' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: 'snowing', icon: 'snow' }
  if (code >= 95) return { label: 'stormy', icon: 'storm' }
  return { label: 'cloudy', icon: 'cloud' }
}

// ---------------- Constants ----------------

/**
 * `suggestUrl` is the engine's own type-ahead endpoint. Each one answers with the
 * OpenSearch shape — ["what you typed", ["first guess", "second guess", …]] —
 * which is why one parser covers all four.
 */
export const SEARCH_ENGINES: Record<
  SearchEngineId,
  { name: string; searchUrl: string; suggestUrl: string }
> = {
  duckduckgo: {
    name: 'DuckDuckGo',
    searchUrl: 'https://duckduckgo.com/?q=%s',
    suggestUrl: 'https://ac.duckduckgo.com/ac/?type=list&q=%s'
  },
  google: {
    name: 'Google',
    searchUrl: 'https://www.google.com/search?q=%s',
    suggestUrl: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s'
  },
  brave: {
    name: 'Brave Search',
    searchUrl: 'https://search.brave.com/search?q=%s',
    suggestUrl: 'https://search.brave.com/api/suggest?q=%s'
  },
  startpage: {
    name: 'Startpage',
    searchUrl: 'https://www.startpage.com/sp/search?query=%s',
    suggestUrl: 'https://www.startpage.com/suggestions?format=opensearch&query=%s'
  }
}

export const ADBLOCK_LISTS: AdblockListMeta[] = [
  { id: 'easylist', name: 'EasyList', description: 'The classic ad-blocking list', defaultOn: true },
  { id: 'easyprivacy', name: 'EasyPrivacy', description: 'Blocks trackers and analytics', defaultOn: true },
  { id: 'ublock-ads', name: 'uBlock filters — Ads', description: 'uBlock Origin ad filters', defaultOn: true },
  { id: 'ublock-privacy', name: 'uBlock filters — Privacy', description: 'uBlock Origin privacy filters', defaultOn: true },
  { id: 'ublock-unbreak', name: 'uBlock filters — Unbreak', description: 'Fixes sites broken by blocking', defaultOn: true },
  { id: 'peter-lowe', name: "Peter Lowe's list", description: 'Ad and tracking server hosts', defaultOn: true },
  { id: 'ublock-badware', name: 'uBlock filters — Badware', description: 'Sites hosting scams and malware', defaultOn: true },
  { id: 'ublock-quick-fixes', name: 'uBlock filters — Quick fixes', description: 'Fast-moving fixes shipped between uBlock releases', defaultOn: true },
  { id: 'urlhaus', name: 'Malicious URL Blocklist', description: 'URLhaus malware-distribution sites', defaultOn: true },
  { id: 'annoyances', name: 'Fanboy Annoyances', description: 'Cookie banners, popups, widgets', defaultOn: false },
  { id: 'easylist-cookie', name: 'EasyList Cookie', description: 'Hides cookie banners the auto-answer misses', defaultOn: true }
]

export const ADBLOCK_LIST_URLS: Record<string, string[]> = {
  easylist: ['https://easylist.to/easylist/easylist.txt'],
  easyprivacy: ['https://easylist.to/easylist/easyprivacy.txt'],
  // the .min aggregates live on uBO's CDN, not in the repo's raw files
  'ublock-ads': ['https://ublockorigin.github.io/uAssets/filters/filters.min.txt'],
  'ublock-privacy': ['https://ublockorigin.github.io/uAssets/filters/privacy.min.txt'],
  'ublock-unbreak': ['https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt'],
  'peter-lowe': ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext'],
  'ublock-badware': ['https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt'],
  'ublock-quick-fixes': ['https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt'],
  urlhaus: ['https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt'],
  annoyances: ['https://secure.fanboy.co.nz/fanboy-annoyance.txt'],
  'easylist-cookie': ['https://secure.fanboy.co.nz/fanboy-cookiemonster.txt']
}

/**
 * Is the widget board on the home screen?
 *
 * Parked on 2026-08-11 at the user's request: the home screen is the time at the
 * top and the search that springs up in front of it, and nothing else. Every
 * widget — the board, the drag-to-place edit mode, the + tray, the size and
 * style strips, the Settings gallery, the Edit Widgets menu items — is still here
 * and still works; it is only switched off. Set this to `true` to bring the whole
 * thing back exactly as it was, and the saved `newTabWidgets` layouts with it.
 *
 * Typed as boolean on purpose, so the parked branches stay type-checked rather
 * than being narrowed away as dead code.
 */
export const HOME_WIDGETS: boolean = false

export const DEFAULT_SETTINGS: Settings = {
  tabOrientation: 'vertical',
  searchEngine: 'google',
  adblock: {
    enabled: true,
    lists: Object.fromEntries(ADBLOCK_LISTS.map((l) => [l.id, l.defaultOn])),
    customRules: '',
    allowlist: []
  },
  popups: { block: true, allowlist: [] },
  privacy: {
    consentAuto: true,
    cookieGuard: true,
    tide: true,
    tideDays: 30,
    disabledSites: [],
    keepSites: [],
    blockSites: []
  },
  passwords: { enabled: true },
  brief: { enabled: true, locationName: '', lat: null, lon: null, unit: 'auto' },
  // on by default; it self-suppresses while keepHistory is off (the enable card
  // is the only surface)
  morning: { enabled: true },
  restoreSession: true,
  keepHistory: false,
  searchSuggestions: true,
  chromeHidden: false,
  bookmarksBar: true,
  // Out of the box the home screen is the time, the search pill, and nothing
  // else. Every other widget is one press-and-hold away.
  newTabWidgets: { clock: true, date: false, greeting: false, weather: false, forecast: false, sun: false, moon: false },
  newTabWidgetOrder: ['clock', 'date', 'greeting', 'weather', 'forecast', 'sun', 'moon'],
  newTabWidgetLayout: {},
  slop: { detector: true, highlight: true, quiet: [] },
  focus: { enabled: true },
  autoPip: true,
  uiSounds: true,
  toolbarDensity: 'compact',
  devtoolsDock: 'right',
  appearance: { theme: 'system', waves: true, waveStyle: 'dithered', accent: 'sea' },
  onboarded: false
}
