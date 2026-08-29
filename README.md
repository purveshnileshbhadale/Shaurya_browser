# Shaurya

A Chromium browser that reconfigures itself around what you are doing.

One control in the sidebar switches between **Programmer**, **Gamer**,
**Creator**, **Student** and **Ghost** — changing which features are on, which
panels the sidebar offers, and how the chrome looks. No restart, no lost tabs.
Underneath every mode: ad blocking in the network stack, an assistant that
reads the tab you are on and asks before it acts, and a Feature Store where
every heavy subsystem is one switch.

```bash
npm install
npm start           # launch the browser
npm test            # 242 unit tests
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

## The Mode Switcher

A mode is a **document**, not a code path. It names which features are on,
which panels the sidebar offers, how the chrome looks, and which runtime
behaviours are armed. Nothing in the UI branches on `if (mode === 'gamer')` —
which is what makes the sixth mode a data change rather than a refactor, and
what makes a user-built mode work with no new machinery at all.

| Mode | What changes |
|---|---|
| **Default** | The browser exactly as you configured it. No overlay at all. |
| **Programmer** | DevTools, REST, GraphQL, sockets, containers, a terminal and a read-only database client. Dense, monospace, terminal-inspired. |
| **Gamer** | Turbo, an FPS/hardware overlay, instant-replay clipping, an always-on-top stream player, deals and a ping tester. Animated accent chrome. |
| **Creator** | Open-licensed asset search with attribution, a brand kit, thumbnail A/B against real feed sizes, a teleprompter and a focus canvas. |
| **Student** | One-click citations in APA/MLA/Chicago, LMS deadline import, a Pomodoro timer with a network-layer blocker, AI flashcards. |
| **Ghost** | Tor routing, per-tab fingerprint randomisation, metadata stripping, a shredder, a breach dashboard and a panic key. Minimal, visibly distinct chrome. |

**Switching is an overlay, never a write.** Three layers resolve whether a
feature is on — your override for that mode, the mode's own document, then
your stored preference — and only the first two ever move. A round trip
through Gamer Mode leaves Default byte-identical, and there are tests
asserting exactly that, because the alternative is a switcher that quietly
eats your configuration.

Build your own from the Feature Store: pick a built-in to start from, tick
what you want, and it appears in the switcher beside the others.

---

## Verified behaviour

`npm run smoke` boots the actual application under a virtual display, drives it
through the same IPC the UI uses, and screenshots it. Latest run:

```
38/38 checks passed

  ok   bootstrap wires every declared IPC channel — 332 handlers
  ok   first run opens the onboarding flow — Welcome to Shaurya
  ok   ad blocking is attached and the engine is loaded — 112026 rules from 5 lists
  ok   the web-request hub multiplexes every participant
         — 5:focus-blocker, 10:adblock, 20:https-only, 30:vpn-killswitch
  ok   every built-in mode activates and reconfigures the chrome
         — default:3 programmer:3 gamer:5 creator:5 student:5 ghost:3
  ok   switching modes does not disturb open tabs — 3 tabs survived 4 switches
  ok   a mode overlays features without writing preferences
  ok   Ghost Mode switches off everything that keeps a record
  ok   a custom mode mixes features from two built-ins
  ok   the mode switcher tracks the active mode and its panels
         — Gamer 5 panels / 3 actions, Default 3 panels
  ok   a private window gets its own isolated session
  ok   the vault encrypts, locks and reopens — 1 entry, file opaque
  ok   captures each mode's chrome — programmer, gamer, creator, student, ghost
```

Plus 242 unit tests covering filter matching, mode resolution, layout geometry,
vault and sync crypto, WebSocket framing, the replay ring buffer, citation
formatting, ICS parsing, EXIF stripping, the SQL read-only guard, feed parsing
and mock pattern matching.

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

**Background play** keeps audio and video running when you switch tabs,
minimise the window or the screen sleeps. That is a carve-out in four places
at once, and the one people miss is background throttling: Chromium throttles
timers in background renderers, and while the audio element survives that, the
site's *own player* — the code advancing the queue and refreshing the stream
token — does not, so playback stops at the end of the track and it reads as
the site breaking. A playing tab is exempted from throttling, protected from
hibernation and from Turbo, and holds a wake lock on the app (never the
display — your screen still turns off). Hardware media keys are bound only
while something is playing, so they are not taken from Spotify while you
browse. A now-playing bar in the sidebar pauses it in one click or jumps to
whichever of forty tabs is making the noise.

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

### Feature Store and custom modes

Every heavy subsystem is one switch, with its runtime cost stated. Turning one
off releases its resources — the VPN disconnects, servers stop, watchers close,
the vault locks — and dependencies cascade in both directions, so the browser
cannot land in a "REST client on, DevTools off" state.

A switch a mode is driving says so, and toggling it inside that mode scopes the
change to that mode rather than rewriting your preferences globally.

The custom-mode builder mixes features from any built-in into a mode of your
own, with its own name and icon. Because a custom mode is the same kind of
document as a built-in, it needs no support code — it simply appears in the
switcher.

---

## Android

`android/` is a Kotlin/Compose companion with the parity the spec requires from
the first mobile release: the same ad blocker (the filter engine is ported, not
reimplemented), the AI assistant, notes, private tabs and encrypted local
storage. Blocking runs in `shouldInterceptRequest`, WebView's equivalent of the
desktop hook.

Background play works here too, and on Android it is the difference between
having the feature and not: a WebView with no foreground service is silenced
within seconds of the screen going off. A `MediaSessionCompat` drives the
lock-screen controls, the notification transport and Bluetooth headset
buttons from one place, and the service starts only while something is
playing — a browser holding a foreground service the whole time it is open
would be killed for it on Android 12+.

The interface is Material 3 proper: dynamic colour on Android 12+, and below
that a full tonal palette grown from the stored accent rather than a single
role swapped on a default scheme. The tab switcher is a grid of live page
thumbnails — captured when a tab stops being visible, since a backgrounded
`WebView` photographs blank, and never captured at all for a private tab.
Now playing sits above the bottom bar, edge-to-edge is honoured in both
directions, back is predictive, and every animation collapses to nothing when
the device asks for no motion.

**The APK is built by CI and compiles clean** — build, unit tests and lint all
green on the first run. The Android SDK ships only from `dl.google.com`, which
is not reachable from every environment, so CI is the reliable path:

```
Push, or run the "Android APK" workflow manually
  → download the `shaurya-debug-apk` artifact  (~17 MB, debug-signed)
```

The same build is also force-pushed to the **`claude/apk-dist`** branch, at
`apk/shaurya-debug.apk`. Actions artifacts are served from a short-lived,
authenticated blob host that a fair number of corporate and sandboxed networks
deny outright, and when that happens the artifact is simply un-downloadable —
the run page lists it and the click fails. The branch is the fallback, reachable
by anything that can clone:

```bash
git fetch origin claude/apk-dist
git show origin/claude/apk-dist:apk/shaurya-debug.apk > shaurya-debug.apk
```

It is rebuilt from an empty history every run, so it never holds more than the
one APK it is currently publishing.

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
  services/
    modes.js       the Mode API — a mode is a document, not a code path
    feature-store.js  76 features, their costs and dependencies
    adblock/  ai/  passwords/  sync/  vpn/     baseline subsystems
    devtools/      REST, sockets, terminal, database, GraphQL, Docker, mocks
    gaming/        performance, recorder, streams, feeds, deals, ping, overlay
    creator/  student/  ghost/                 the three newer modes
  ipc/             the main↔renderer contract, in one file
src/preload/       the three security boundaries (chrome, content, overlay)
src/ui/
  components/      mode-switcher.js, mode-panels.js — the two registries
src/pages/         shaurya:// internal pages, including the HUD and prompter
android/           Kotlin/Compose companion
test/              242 unit tests
scripts/           smoke test, tooling
```

`docs/ARCHITECTURE.md` explains why the pieces are shaped the way they are.
`docs/ASSUMPTIONS.md` records every decision the spec left open, and every place
this build stops short of the spec — read that one before judging what is here.
`docs/BUILD-PLAN.md` is the phased plan, with an honest status column marking
what exists here and what needs a team, money or hardware.

---

## Keyboard

Every feature is reachable without a mouse, and every chord is remappable in
Settings → Shortcuts. Conflicts are refused rather than silently shadowing
another command.

| | |
|---|---|
| `Ctrl/Cmd+M` | **Mode Switcher** (then `1`–`9` to pick one) |
| `Ctrl/Cmd+Alt+M` | Next mode |
| `Ctrl/Cmd+K` | Command palette |
| `Ctrl/Cmd+B` | Toggle sidebar |
| `Ctrl/Cmd+Alt+S` | Split screen |
| `Ctrl/Cmd+Shift+A` | AI assistant |
| `Ctrl/Cmd+Shift+G` | Generate notes from this page |
| `Ctrl/Cmd+Shift+E` | REST client |
| `Ctrl/Cmd+Alt+T` | Toggle Turbo |
| `Ctrl/Cmd+Alt+C` | Save the last N seconds |
| `Ctrl/Cmd+Alt+K` | Cite this page |
| `Ctrl/Cmd+Alt+Shift+Backspace` | Panic — close and wipe |

---

## Monetisation

The browser, ad blocking, and a fair-use tier of VPN, AI and notes are free
forever. Pro removes usage caps.

Browsing data is never sold or shared with advertisers, at any tier. There is no
analytics or telemetry of any kind in this codebase. That is stated in the
onboarding flow's second screen, not only here.

## Licence

MIT.
