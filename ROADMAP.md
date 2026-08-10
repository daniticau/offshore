# Offshore Roadmap

Notes from the founder (2026-08-06) — gripes with other browsers and what Offshore should take from each.

## High priority

- [ ] **Widevine DRM → Netflix/Spotify playback.** Helium can't play Netflix (ungoogled-chromium
  strips the DRM module). Stock Electron lacks Widevine too. Fix: swap the `electron` dev
  dependency for `@castlabs/electron-releases` (drop-in Electron with Widevine CDM) and run the
  app through castLabs EVS (their free VMP-signing service — requires creating an EVS account,
  then `python -m castlabs_evs.account signup` + signing in the package step). Without the
  signature Widevine refuses to initialize, so this lands with packaging, not dev builds.
- [x] **Auto mini-player (the Arc thing).** Probe-based (catches muted players), skips Shorts
  and looping hero videos, races fixed.

## Design & feel (from Helium / Arc) — landed 2026-08-06

- [x] **Full redesign on a token system** — light + dark themes, Newsreader/Inter bundled
  locally, dithered waves everywhere, refined padding, animations ≤200ms.
- [x] **Toolbar density modes** — classic / compact / dynamic (auto-hiding chrome, ⌘S).
- [x] **Arc-style micro-sounds** — synthesized, behind a setting (default on, very quiet).
- [x] **Onboarding** — 4 steps: hero, layout, search engine, theme (live retint). Skippable,
  re-runnable from Settings.
- [x] **Bookmark folders** — sidebar tree with real site favicons (stored icon → the site's own
  `/favicon.ico` → letter glyph), drag to organize, ⌘D popover with folder picker, omnibox
  search, manager in Settings.
- [x] **Widevine DRM** — castLabs Electron for Content Security; Netflix/Spotify playback, CDM
  auto-installed on first launch, `drm` test flow proves the key system answers.
- [x] **Inline omnibox** — the palette became a real toolbar input: type-ahead completion,
  dropdown suggestions, focus lands there on every new tab; the start page keeps zero inputs.
- [x] **AI slop detector** — deterministic prose heuristics in the page preload, 0–100 score,
  tiny toolbar badge. The core tenet, shipped without a model.
- [x] **Chrome-style downloads panel**, bookmarks-bar quick toggle, last-tab keeps the window,
  live cursor-reactive waves, widget context menu, sliding clock digits.
- [x] **Helium toolbar** — site-info popover (connection, Shield, popups, per-site data clear),
  split view, bookmarks bar, downloads/devtools buttons, three-dots menu with everything.
- [x] **Widget new tab** — time+date default, greeting/weather/forecast opt-in via onboarding
  step or Settings; location prompt lives only in Settings. Realistic layered classic waves +
  textured dithered waves.
- [x] **Chromium-style settings** — left category nav, centered cards, plain-language Shield
  (two switches + custom rules), accent circles + any-color picker, bookmarks bar toggle.
- [x] **History off by default** — `keepHistory` setting, default false. Nothing recorded, no
  history suggestions in the omnibox; switching it off clears whatever was already kept.
- [x] **Spaces** — per-window named tab sets, animated switch (⌘⌥←/→, ⌘⌥N), per-space accent,
  optional **separate logins** (own session partition per space — the school/home Gmail thing).
  Normal multi-window untouched, forever.
- [x] **Password manager** — safeStorage vault (Keychain-backed), capture + autofill with
  per-profile account memory, Touch ID reveal, management UI in Settings.
- [x] **Popup blocker** — gesture-tracking, per-site allowlist, blocked chip in the chrome.
- [x] **Morning brief without AI** — shipped as the weather brief (Open-Meteo, no key, manual
  location, quiet failure). RSS/calendar variants deliberately skipped for now.
- [x] **Session restore v2** — all windows, spaces, profiles, bounds; v1 files migrate.
- [x] **Security pass** — `file://` no longer trusted for privileged IPC, internal bridge only
  exposed on Offshore's own pages, popups hardened, themed error pages.

## Ideas (non-AI by principle)

- RSS headlines / calendar widgets on the start page (the rest of the de-AI'd Dia brief) —
  only if they can stay as quiet as the weather line.
- Color customization: custom accent/glass tint picker (Helium-level, not Vivaldi-level).
- Per-space extensions (extensions currently apply to shared-login spaces only).
- Favicon caching for bookmarks (stored URLs can go stale).

## Explicitly rejected

- Spaces/workspaces with a forced window model (the Arc gripe) — Offshore keeps normal macOS
  multi-window behavior forever.
- Any AI feature, ever. That's the whole point of the name.
