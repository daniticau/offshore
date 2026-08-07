# Offshore 🌊

A calm, human browser. **No AI — just you and the water.**

Offshore is a macOS browser built on the Chromium engine (via Electron) with a fully custom,
liquid-glass, surf-themed shell. It follows the [Helium](https://helium.computer) ethos —
private by default, zero telemetry, no bloat — with the design ambition Helium deliberately
skips.

![Offshore](build/icon-1024.png)

## Features

- **Real Chromium engine** — same Blink/V8 as Chrome; sites can't tell the difference
- **Vertical sidebar or horizontal top-bar tabs** — toggle with `⌘⇧B`
- **Liquid glass UI** — native macOS vibrancy, light-blue surf theme, Arc-style inset content card
- **Shield** — built-in uBlock-compatible ad/tracker blocker (EasyList, EasyPrivacy, uBlock
  filters, Peter Lowe's, Fanboy Annoyances), per-site toggle, custom rules, live blocked counter
- **Chrome extensions** — installs straight from the Chrome Web Store (Dark Reader, uBlock
  Origin, etc. — most extensions work)
- **⌘L command palette** — Arc-style overlay omnibox with local-only history suggestions
  (keystrokes never leave the machine)
- **Auto mini-player** — playing video pops into a floating PiP window when you switch tabs
- **Bookmarks** (`⌘D`), session restore, find-in-page (`⌘F`), downloads, multi-window that
  behaves like a normal Mac app
- **Surf-themed start page** — clock, animated waves, editable quick links
- **Privacy defaults** — geolocation/notification prompts auto-denied, camera/mic asks you
  first, no telemetry of any kind, no AI anywhere. Google search by default, switchable in
  settings; suggestions are always local

## Develop

```bash
npm install
npm run dev        # hot-reloading dev build
npm run typecheck
```

## Package

```bash
npm run dist       # builds dist/mac-arm64/Offshore.app + .dmg
```

The app is unsigned; on first launch right-click → Open.

## Roadmap

See [ROADMAP.md](ROADMAP.md) — headlined by Widevine DRM (Netflix) via castLabs Electron.
