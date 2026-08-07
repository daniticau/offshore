# Offshore Roadmap

Notes from the founder (2026-08-06) — gripes with other browsers and what Offshore should take from each.

## High priority

- [ ] **Widevine DRM → Netflix/Spotify playback.** Helium can't play Netflix (ungoogled-chromium
  strips the DRM module). Stock Electron lacks Widevine too. Fix: swap the `electron` dev
  dependency for `@castlabs/electron-releases` (drop-in Electron with Widevine CDM) and run the
  app through castLabs EVS (their free VMP-signing service — requires creating an EVS account,
  then `python -m castlabs_evs.account signup` + signing in the package step). Without the
  signature Widevine refuses to initialize, so this lands with packaging, not dev builds.
- [x] **Auto mini-player (the Arc thing).** Playing video in a tab and switching to another tab
  pops the video into a floating bottom-right player (Chromium native picture-in-picture) with
  play/pause and "back to tab" controls. Auto-exit when you return to the tab.

## Design & feel (from Helium / Arc)

- Keep Helium's **compactness and snappiness** — chrome stays lightweight, no bloat, animations
  under 200ms, nothing blocks the content view.
- Arc-style **micro-animations and subtle sound effects** — tiny UI sounds (tab close, download
  done) behind a setting, off by default until they feel right.
- Smooth transition animation when toggling sidebar ↔ top bar tab layout.

## Round 2 notes (same day, second dictation)

- [x] **Appearance customizability** — waves removable, wave style (classic / dithered), accent
  color presets. Default stays light-blue surf.
- [x] **Onboarding** — Arc/Coast-style first-launch flow: animated, wave visuals, pick layout +
  search engine, subtle sounds. Short and beautiful, skippable.
- [x] **Visible bookmarks** — quick-access bookmark strip in the sidebar; manager in settings.
- [ ] **Optional Spaces** — Arc-like spaces (named tab sets, animated switch) *as an option*,
  while normal multi-window always works too. Both, never either/or. (v2 — real design work.)
- [ ] **Toolbar density modes** — Helium-style options (dynamic / compact / classic). (v2)
- [ ] **Password manager** — Arc-quality: secure vault + autofill + easy management. Honest
  scoping: Electron does not ship Chrome's password manager, so this is a native build —
  macOS Keychain-backed encryption via `safeStorage`, form detection/autofill, management UI
  in settings. Until then: 1Password/Bitwarden extensions work via the Web Store today.
- Settings philosophy: keep Helium's "cut the bullshit" simplicity as the bar.

## Ideas (non-AI by principle)

- **Morning brief without AI** (Dia's brief, de-AI'd): optional start-page widgets — RSS
  headlines from feeds the user picks, local weather, today's calendar (EventKit). All fetched
  directly, rendered plainly, zero AI summarization. Off by default.
- Color customization: accent color / glass tint picker (Helium-level, not Vivaldi-level).

## Explicitly rejected

- Spaces/workspaces with forced window model (the Arc gripe) — Offshore keeps normal macOS
  multi-window behavior forever.
- Any AI feature, ever. That's the whole point of the name.
