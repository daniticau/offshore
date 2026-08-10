# Offshore 🌊

A calm, human browser. **No AI — just you and the water.**

Offshore is a macOS browser built on the Chromium engine (via Electron) with a fully custom,
liquid-glass, surf-themed shell. It follows the [Helium](https://helium.computer) ethos —
private by default, zero telemetry, no bloat — with the design ambition Helium deliberately
skips.

![Offshore](build/icon-1024.png)

## Features

- **Real Chromium engine** — same Blink/V8 as Chrome; sites can't tell the difference
- **AI slop detector** — a tiny badge appears when a page reads like machine-generated filler.
  Pure local heuristics (stock phrases, formulaic structure) — no AI involved, nothing leaves
  your Mac. The web as it was meant to be surfed.
- **Protected content plays** — Widevine DRM via castLabs Electron for Content Security, so
  Netflix, Spotify Web, and friends actually work (dev builds are VMP-signed out of the box)
- **Spaces** — per-window named tab sets with animated switching (⌘⌥←/→), per-space accent
  colors, and optional **separate logins**: give a space its own cookie jar and keep school
  and home accounts signed in side by side. Normal Mac multi-window always works too.
- **Password vault** — offers to save on first login, autofills on return. Encrypted at rest
  (username *and* password) with a macOS-Keychain-backed key via `safeStorage`; exact-origin
  matching, per-profile account memory, Touch ID-gated reveal. Local only, forever.
- **Shield** — built-in uBlock-compatible ad/tracker blocker (EasyList, EasyPrivacy, uBlock
  filters, Peter Lowe's, Fanboy Annoyances), per-site toggle, custom rules, live counter —
  active in every space profile. Allowlist changes apply instantly, no refetch.
- **Popup blocker** — real transient-activation model: popups need a recent click or an
  allowlisted site; blocked ones collect in a chip beside the shield.
- **Bookmarks with folders** — real site favicons in the sidebar tree (the icon captured when
  you saved it, else the site's own `/favicon.ico`, else a letter — never a third-party icon
  service), drag to organize, inline rename, ⌘D popover with folder picker, omnibox search,
  and an optional Chrome-style bookmarks bar in top-bar layout.
- **Light & dark** — full dual theme (System/Light/Dark) across chrome, pages, and onboarding
- **Editorial type** — Newsreader for display moments, Inter for the chrome, bundled locally
- **Dithered waves** — Bayer-dithered pixel surf on the start page, onboarding, and error page
- **Toolbar density** — Classic, Compact, or Dynamic (auto-hiding chrome, ⌘S to toggle)
- **Weather brief** — a serif good-morning line with live conditions from Open-Meteo. No API
  key, no account, location only if you type one. Zero AI summarization, by principle.
- **One search bar, ever** — a real inline omnibox in the toolbar with type-ahead completion,
  open-tab switching, bookmark results, and quick actions. ⌘T lands your cursor there with the
  quiet new-tab page behind it; suggestions are local-only (keystrokes never leave the machine)
- **Site info at a glance** — the tune button in the omnibox opens connection security, Shield
  state with live block count, popup permissions, and a one-click "clear data for this site"
- **Split view** — two tabs side by side in the content area; the toolbar button (or the
  three-dots menu) splits the active tab with its neighbour, and closing either half exits
- **Widget new tab** — time and date by default; greeting, weather, hourly forecast, sunrise &
  sunset, and moon phase are opt-in from onboarding, Settings, or a right-click on the page.
  No search box and no location nag on the page itself; digits roll softly as the clock turns
- **Living waves** — both wave styles drift continuously in one direction at layered speeds,
  and the water parts away from your cursor. Closing the last tab lands you here instead of
  closing the window — quitting is an explicit act
- **Toolbar, Helium-style** — site info on the left of the omnibox; extensions, downloads,
  bookmarks, dev console, and a three-dots everything-menu on the right
- **Auto mini-player** — playing video pops into a floating PiP window when you switch tabs
- **Vertical sidebar or horizontal top-bar tabs** — toggle with `⌘⇧B`
- **Chrome extensions** — installs straight from the Chrome Web Store (Dark Reader, uBlock
  Origin, etc. — most extensions work)
- **Tiny interface sounds** — synthesized, coastal, very quiet; one toggle away from silence
- **Session restore** — every window, space, tab, and window position comes back
- **Privacy defaults** — history is **off** by default: nothing is written down and the address
  bar never suggests somewhere you've been (turning it on is one toggle in Settings; turning it
  back off forgets what was kept). Geolocation/notification prompts auto-denied, camera/mic asks
  you first, drive-by `file://` pages get zero privileged access, no telemetry, no AI anywhere

## Develop

```bash
npm install
npm run dev        # hot-reloading dev build
npm run typecheck
```

Dev-only test flows (scripted end-to-end checks):

```bash
OFFSHORE_TEST_FLOW=passwords npm run dev   # save banner → encrypted vault → autofill
OFFSHORE_TEST_FLOW=popups npm run dev      # drive-by blocked, gestured allowed
OFFSHORE_TEST_FLOW=spaces npm run dev      # cookie isolation, serialization, cross-jar moves
OFFSHORE_TEST_FLOW=headers npm run dev     # client hints on the wire, Google serves real results
OFFSHORE_TEST_FLOW=privacy npm run dev     # history stays off by default, bookmark favicons
OFFSHORE_TEST_FLOW=drm npm run dev         # Widevine CDM present and answering
OFFSHORE_TEST_FLOW=split npm run dev       # split view: geometry, activation, dissolution
OFFSHORE_TEST_FLOW=lasttab npm run dev     # closing the last tab keeps the window
OFFSHORE_TEST_FLOW=slop npm run dev        # slop detector flags filler, spares honest prose
```

Each flow writes its `[flowtest]` transcript to `OFFSHORE_TEST_LOG=<file>` as well as stdout —
read the file, since main-process stdout does not survive every launch path. Set
`OFFSHORE_CLEAN_PROFILE=<dir>` to run against a throwaway profile, and
`OFFSHORE_BOOT_LOG=<file>` for a startup trace (plus uncaught-exception capture) when the app
appears to hang before it opens a window.

The `passwords` and `popups` flows need the renderer dev server, so run those through
`npm run dev`. The rest also work against a production build via
`./node_modules/.bin/electron .`.

## Package

```bash
npm run dist       # builds dist/mac-arm64/Offshore.app + .dmg
```

The app is unsigned; on first launch right-click → Open.

Widevine note: the development binaries are VMP-signed by castLabs, so DRM playback works in
`npm run dev` and direct `electron .` runs. A packaged app needs a one-time EVS signup
(`pip install castlabs-evs && python3 -m castlabs_evs.account signup`), then
`python3 -m castlabs_evs.vmp sign-pkg dist/mac-arm64/Offshore.app` after `npm run dist`.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what's shipped and what's next.
