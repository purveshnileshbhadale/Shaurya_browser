# Aether

A privacy-first, AI-native, developer-focused browser built on Chromium, with an
Android companion.

Ad and tracker blocking happens in Chromium's network stack. The assistant reads
the tab you are on and asks before it acts. The developer tools you would
otherwise install four extensions for are in the sidebar. Every heavy feature can
be switched off individually.

```bash
npm install
npm start           # launch the browser
npm test            # 120 unit tests
npm run smoke       # boot the real browser, drive it, screenshot it
```

---

## What this is, precisely

The spec this was built from asked for a Chromium fork, and noted that where
compiling Chromium is not feasible, the closest achievable version should be
built instead. This is that: **an Electron application, which is Chromium**
(currently 152) **plus a Node main process**, with the entire browser layer —
tabs, chrome, blocking, profiles, panels, protocol handlers — written here.

What that gets you, honestly:

| | |
|---|---|
| **Real** | Chromium's renderer, network stack, sandbox and DevTools. Multi-process isolation per tab. Real `Session` partitions for profiles. Network-layer request blocking. Chrome Web Store extensions. |
| **Not a fork** | No patches to Chromium's C++. Anything requiring that — a custom network stack, changes to the compositor — is out of reach. |
| **Consequences** | Manifest V3 extensions load through Electron's extension host, which implements most but not all of the API surface. The manifest linter names exactly what is unsupported rather than letting an extension half-work. |

Everything below is implemented and exercised by the test suite unless a
paragraph says otherwise.

---

## Verified behaviour

`npm run smoke` boots the actual application under a virtual display, drives it
through the same IPC the UI uses, and screenshots it. Latest run:

```
28/28 checks passed

  ok   bootstrap wires every declared IPC channel — 192 handlers
  ok   first run opens the onboarding flow — Welcome to Aether
  ok   aether://start renders in a profile partition
  ok   split view positions two live panes — 473px | 473px
  ok   ad blocking is attached and the engine is loaded — 111800 block rules from 5 lists
  ok   the web-request hub multiplexes every participant — adblock, https-only, vpn-killswitch
  ok   a private window gets its own isolated session — two independent private contexts
  ok   the REST client performs a real request — 200 in 18ms
  ok   a static server refuses path traversal — blocked with 404
  ok   the vault encrypts, locks and reopens — 1 entry, file opaque
  ok   disabling a feature cascades to its dependents — cascade both ways
```

Plus 120 unit tests covering filter matching, layout geometry, vault crypto,
sync crypto, WebSocket framing, the Markdown renderer, the manifest linter and
omnibox resolution.

---

## Features

### Interface

Vertical tabs by default, with a one-key switch to a horizontal strip. Tab
groups are colour-coded, nameable and collapsible, and their members are kept
contiguous in the strip automatically. Workspaces hide tabs rather than closing
them, so switching back restores exactly what was there.

Split screen puts two tabs side by side with a draggable divider; the layout
engine clamps the ratio so neither pane can be dragged into uselessness and
falls back to a single pane when the window is too narrow for two.

The command palette (`Ctrl/Cmd+K`) searches open tabs, history, bookmarks,
settings and installed extensions in one ranked list.

Tab hibernation destroys the renderer process of an idle tab — memory returns to
the OS — while keeping its thumbnail, title and navigation history.

Also: screenshot with region/full-page capture and annotation, reader mode,
picture-in-picture, trackpad gestures, per-profile themes and accent colours.

### Privacy

**Blocking is at the network layer.** Filter lists are parsed into a tokenised
index and matched in `onBeforeRequest`, so a blocked request is cancelled before
a socket opens. Nothing is fetched: no bytes, no cookies, no timing signal. The
engine handles the ABP syntax EasyList actually uses — domain anchoring,
separators, wildcards, `$third-party`, `$domain=`, resource types, exceptions and
`$important` precedence — and skips rules it cannot honour rather than
mis-applying them. Measured at ~21µs per uncached request against 111k rules.

Cosmetic filtering is a second layer that removes the empty frames left behind,
never the primary mechanism. Generic selectors are indexed by their leading
class/id token and only materialised when that token exists in the document.

Every profile is a real Chromium `Session`: its own cookie jar, cache, storage
and extension set. Private windows get an in-memory partition each, so two
private windows do not share cookies, and the context is destroyed on close.

Also: HTTPS-only with an interstitial that makes continuing a deliberate choice,
fingerprint resistance, Global Privacy Control, granular per-site permissions,
and a password vault sealed with AES-256-GCM under a scrypt-derived key — the
file reveals neither passwords nor which sites have accounts.

**The VPN is honest about its scope.** With WireGuard tools installed it brings
up a device-wide tunnel with a firewall kill switch. Without them it falls back
to a browser-only tunnel and the UI says "this browser only" rather than
implying device-wide protection. Keys are generated locally with Curve25519 and
the private key is never transmitted.

### AI

The assistant is grounded in the active tab. Other tabs require an explicit
per-window grant. Private windows never contribute page content at all.

Inference is hybrid: an on-device model (Ollama) for quick, private work, or a
hosted model for real reasoning. The user picks; page text is never sent to a
hosted model as a silent performance optimisation.

**Actions with real-world effect always ask first, and this is structural.**
Every tool declares `read` or `write`. Write tools never execute from the
model's decision alone — the call is parked, the user is shown exactly what will
happen, and only explicit approval releases it. A prompt-injected page can at
most cause a confirmation card to appear, which the user declines.

One click turns an article, a video transcript or a PDF into structured notes,
exportable to Markdown, PDF, Notion or Obsidian.

### Developer

A REST client that can send with the current profile's cookies (which is the
point of building it in rather than opening Postman), with per-phase timing —
DNS, connect, TLS, TTFB, download.

A WebSocket inspector that both mirrors the sockets a page opens (via the
DevTools protocol, so a page cannot hide traffic from it) and opens its own,
with a from-scratch RFC 6455 implementation.

A localhost manager that serves a folder in one click and scans for listening
dev ports. A JSON viewer that auto-activates on raw JSON responses. Live
Markdown preview for local files. Regex, Base64/URL, JWT and hash utilities in
the palette. A screen colour picker with a WCAG contrast checker that suggests
an accessible variant of the same hue.

Responsive design mode drives Chromium's own device and network emulation, not
just a resized pane — user agent, DPR, touch and `maxTouchPoints` included.

Extension developer mode hot-reloads unpacked extensions and lints manifests,
naming V2 leftovers that silently do nothing under V3.

The CORS toggle exists, and is **only** offered on a profile of kind `dev`,
never persists across a restart, and shows an undismissable banner while it is
on.

### Sync

End-to-end encrypted. The server stores ciphertext and blinded record ids: it
learns how many records exist and when they changed, and nothing else. Record
ids are HMACs, so it cannot confirm a guess about what you have bookmarked. The
collection name is bound in as AEAD associated data, so a server that moves a
record between collections produces a decryption failure rather than a
confusing result.

### Feature Store

Every heavy subsystem is one switch, with its runtime cost stated. Turning one
off releases its resources — the VPN disconnects, servers stop, watchers close,
the vault locks — and dependencies cascade in both directions, so the browser
cannot land in a "REST client on, DevTools off" state.

---

## Android

`android/` is a Kotlin/Compose companion with the parity the spec requires from
the first mobile release: the same ad blocker (the filter engine is ported, not
reimplemented), the AI assistant, notes, private tabs and encrypted local
storage. Blocking runs in `shouldInterceptRequest`, WebView's equivalent of the
desktop hook.

**The APK is built by CI and compiles clean** — build, unit tests and lint all
green on the first run. The Android SDK ships only from `dl.google.com`, which
is not reachable from every environment, so CI is the reliable path:

```
Push, or run the "Android APK" workflow manually
  → download the `aether-debug-apk` artifact  (~17 MB, debug-signed)
```

Locally, with the SDK installed:

```bash
cd android && ./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

The Gradle wrapper is committed, so no Gradle install is needed.

---

## Layout

```
src/main/          Electron main process
  window/          tabs, layout geometry, window orchestration
  services/        one directory per subsystem
  ipc/             the main↔renderer contract, in one file
src/preload/       the two security boundaries
src/ui/            browser chrome renderer
src/pages/         aether:// internal pages
android/           Kotlin/Compose companion
test/              120 unit tests
scripts/           smoke test, tooling
```

`docs/ARCHITECTURE.md` explains why the pieces are shaped the way they are.
`docs/ASSUMPTIONS.md` records every decision the spec left open, and every place
this build stops short of the spec — read that one before judging what is here.

---

## Keyboard

Every feature is reachable without a mouse, and every chord is remappable in
Settings → Shortcuts. Conflicts are refused rather than silently shadowing
another command.

| | |
|---|---|
| `Ctrl/Cmd+K` | Command palette |
| `Ctrl/Cmd+B` | Toggle sidebar |
| `Ctrl/Cmd+Alt+S` | Split screen |
| `Ctrl/Cmd+Shift+A` | AI assistant |
| `Ctrl/Cmd+Shift+G` | Generate notes from this page |
| `Ctrl/Cmd+Shift+E` | REST client |
| `Ctrl/Cmd+Shift+S` | Capture a region |

---

## Monetisation

The browser, ad blocking, and a fair-use tier of VPN, AI and notes are free
forever. Pro removes usage caps.

Browsing data is never sold or shared with advertisers, at any tier. There is no
analytics or telemetry of any kind in this codebase. That is stated in the
onboarding flow's second screen, not only here.

## Licence

MIT.
