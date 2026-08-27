# Architecture

Why the pieces are shaped the way they are. For *what* the browser does, see the
README; for decisions the spec left open, see `ASSUMPTIONS.md`.

---

## Processes

```
┌─ main (Node) ─────────────────────────────────────────────────────┐
│  services/   adblock · privacy · vpn · vault · ai · devtools …    │
│  window/     tabs · layout · window orchestration                 │
│  ipc/        the whole main↔renderer contract                     │
└──────────┬───────────────────────┬────────────────────────────────┘
           │ aether:invoke         │ aether:content
           │ (privileged)          │ (page-scoped)
┌──────────▼───────────┐   ┌───────▼──────────────────────────────┐
│ chrome renderer      │   │ page renderers (one process per tab) │
│ preload/chrome.js    │   │ preload/content.js  · sandboxed      │
│ sandbox: false       │   │ contextIsolation · nodeIntegration ✗ │
└──────────────────────┘   └──────────────────────────────────────┘
```

The chrome renderer is privileged and loads only local files. Page renderers are
sandboxed, isolated, and get a *different, unprivileged* IPC channel. That split
is the security boundary: a compromised web renderer can reach `aether:content`
(which offers "what cosmetic rules apply to me" and little else) and cannot
reach `aether:invoke` at all.

---

## The view tree

Aether uses `BaseWindow` rather than `BrowserWindow`, so the chrome and every
page are siblings in one view tree with explicit z-order:

```
index 0    shellView     browser chrome, full window
index 1+   page views    live tabs, positioned in the content rect
top        overlayView   transparent; attached only while open
```

The chrome sits *underneath* the pages and paints only where it draws — the
content rectangle stays transparent. Two consequences worth knowing:

- A tab title change repaints the sidebar, not the page.
- Anything that must appear *over* page content (command palette, capture
  selector, colour picker) has to live in the overlay view. It is detached when
  idle, because an always-present full-window view on top would swallow every
  click meant for the page.

**Layout is pure.** `window/layout.js` maps a plain state object to rectangles
and touches no Electron API, which is why split ratios, panel widths and
responsive letterboxing are unit-testable rather than drag-and-see. The main
process is authoritative — it positions real `WebContentsView`s — and the chrome
CSS grid mirrors whatever it applied. If those two disagreed by a pixel, a strip
of page would show beside the toolbar.

---

## The Mode API

The spec's constraint is explicit: modes must be "swappable panels/extensions
registered against a common Mode API — never hardcoded UI branches". That is
not decoration. Six modes with a `switch` in each component would be
thirty-plus branches to keep consistent, and a user-built mode would have no
branch at all to fall into.

So a mode is a **document** (`services/modes.js`):

```js
{
  id, name, tagline, icon, accent,
  features:  { adblock: true, turbo: false, … },   // overlay on the Feature Store
  appearance:{ theme, density, monoUi, backgroundFx },
  panels:    ['stream', 'games', 'deals', 'perf', 'ai'],
  quickActions: ['turbo', 'record', 'overlay'],
  behaviors: { aggressiveHibernate: true },
}
```

Three registries consume it, and none of them knows which modes exist:

| Registry | Lives in | Keyed by |
|---|---|---|
| Panels | `ui/components/mode-panels.js` | panel id |
| Quick actions | `ui/components/mode-switcher.js` | action id |
| Chrome styling | `ui/styles/chrome.css` | `[data-mode]`, `[data-mono]`, `[data-fx]` |

Adding a mode is a document plus, if it needs one, a panel. Adding a panel
touches only the panel file. A mode naming a panel or action this build does
not have skips it rather than throwing — which is what lets a custom mode
written against a newer version load safely on an older one.

### Why the overlay is the load-bearing part

Three layers decide whether a feature is on, nearest wins:

```
1. user override for the active mode    settings.modes.overrides[modeId]
2. the mode document's own overlay      mode.features
3. the user's stored preference         settings.features     ← never written by a switch
```

If a mode *wrote* preferences, switching to Gamer and back would leave the
user's own choices replaced by Gamer's, silently and permanently. The
FeatureStore therefore takes an injected resolver and an override sink rather
than importing the mode service — which also means the two can be constructed
in either order, and the Feature Store remains testable with no modes at all.

The same reasoning applies to appearance: a mode's theme is merged over the
user's at read time and never stored, so leaving the mode restores their look
exactly. Reduced motion is the one setting a mode cannot override, because
that is an accessibility need rather than a style.

### Why switching cannot lose a tab

`activate()` writes one setting, re-points the overlay, and emits. It does not
touch tabs, sessions, windows or profiles. Page views are siblings of the
chrome in the `BaseWindow` view tree (see above), and the transition is a CSS
crossfade on the chrome layer alone — so there is no code path in a mode
switch that could close, reload or reparent a page. "No restart, no lost tabs"
is a structural property here, not a thing to be careful about.

---

## Native window chrome

`src/main/window/platform-chrome.js` owns everything the *operating system*
paints around the window. It is separate from the renderer's theming because
the renderer's CSS never touches these pixels — the system does.

On Windows the window is frameless but keeps the real system buttons via
`titleBarOverlay`, which is what keeps Snap Layouts (hover maximise), the
Alt-Space menu and double-click-to-maximise working. Drawing our own three
buttons would lose all of that.

The trap is that **`titleBarOverlay` is a construction option**. Set once at
window creation, it never moves again: a window created in a light theme keeps
light system buttons forever, so switching to Gamer Mode leaves three pale
buttons in a pale rectangle at the corner of a dark window. `refreshChrome()`
re-applies it, and `bootstrap.js` calls it from all three things that can move
the theme — a mode change, an `appearance.*` setting, and `nativeTheme`
updating when the OS itself changes at dusk.

The renderer gets the same numbers, on `window:chrome` **and** in the
`shell.bootstrap` payload. Both, deliberately: a renderer that only listened
for the event would paint its first frame with the toolbar's trailing controls
underneath the system buttons — which are real OS chrome painted above the
page, so those controls are not merely misplaced, they are unclickable.

Two consequences worth keeping in mind when editing the chrome CSS:

- A drag region swallows clicks. `#toolbar` is `-webkit-app-region: drag` so a
  frameless window can be moved at all, and everything interactive inside it
  opts back out by *element type* rather than an opt-in class — a button that
  forgets an opt-in class is dead, not slightly wrong, and the failure is
  invisible on macOS and Linux where the whole rule set is inert.
- Mica needs the window's background to be transparent **and** our own
  surfaces to be translucent. An opaque toolbar over a Mica window shows no
  material at all, so the effect looks broken rather than subtle.

## Three problems worth explaining

### `webRequest` allows one listener per event

Electron keeps exactly **one** listener per `webRequest` event per session:
calling `onBeforeRequest` twice silently replaces the first. Five subsystems need
a say in the request path — ad blocking, HTTPS-only, the CORS toggle, the JSON
viewer, the VPN kill switch — so registering directly meant whichever booted
last was the only one that worked, with no error anywhere.

`services/web-request-hub.js` owns the single real listener per event and fans
out to ordered participants:

```
10  adblock       cancel wins outright, short-circuits
20  https-only    redirect short-circuits (Chromium restarts the request)
30  vpn           kill switch
40  cors          dev profiles only
50  json-viewer
60  header hygiene   headers compose; each sees the previous one's result
```

A throwing participant is skipped rather than failing the request: a filter bug
must never make the browser unusable.

### Custom protocols are per-session

`protocol.handle()` is an alias for `session.defaultSession.protocol`. Every tab
here loads in a profile *partition*, so a handler registered globally is
invisible to all of them — every `aether://` page fails with `ERR_FAILED` and no
explanation. The profile service installs the handler on each session it
creates.

### IPC trust follows the document, not the WebContents

Internal `aether://` pages need the privileged surface; web pages must never
have it. Trust is granted and revoked on every main-frame commit, because a tab
navigating from `aether://settings` to a website keeps the same WebContents id —
trust granted once and never revoked would hand a web page the vault.

---

## Subsystems

### Ad blocking

Two files, one idea. `filter-parser.js` turns ABP syntax into rule objects;
`matcher.js` indexes them.

The index is tokenised: pick one representative token per rule, bucket by it,
and at match time only test buckets whose token appears in the URL. That turns
"check 111k rules" into "check a handful".

The subtlety is which tokens are safe to index under. A URL tokenises into
maximal `[a-z0-9%]+` runs, so `/banner123.gif` yields `banner123`, not `banner`
— indexing the rule `/banner*.gif` under `banner` makes it invisible to that
URL. A pattern token is only safe when neither edge can absorb extra
alphanumerics: `*` on either side disqualifies it, and so does an unanchored
pattern edge. Rules with no safe token fall to a catch-all list, which is
correct if slower.

Measured: 32k lines parsed in 57ms, 0.05% skipped, ~21µs per uncached match,
32 MiB resident.

### Vault

scrypt (N=2¹⁷, ~128 MiB, ~250ms) for the KDF, AES-256-GCM for the sealed blob.
The *entire* document is sealed, not just the passwords — a vault that leaks
"this user has accounts at these 300 sites" is a privacy failure even if no
password escapes. GCM means a tampered file fails to open rather than
decrypting to garbage.

Autofill re-checks the origin at fill time, not just at offer time: the page may
have navigated between the offer and the click.

### Sync

```
root key   scrypt(passphrase, salt)          never transmitted
data key   HKDF(root, "…-data-v1")           encrypts records
id key     HKDF(root, "…-id-v1")             blinds record ids
auth key   HKDF(root, "…-auth-v1")           proves ownership
```

Record ids are HMACs, so the server cannot invert them or confirm a guess. The
collection name is AEAD associated data, so a server that moves a record between
collections gets a decryption failure rather than a plausible-looking result.

### AI

`context.js` decides what the model may see (active tab always; other tabs only
under an explicit per-window grant; private windows never). `actions.js` holds
the tool catalogue and the confirmation gate. `index.js` runs the tool loop.

The gate is the interesting part: tools declare `read` or `write`, and write
tools are parked pending explicit approval rather than executed. Because that is
enforced at the broker rather than requested in the prompt, a prompt-injected
page can at most cause a confirmation card to appear.

---

## Conventions

**Services own state; the renderer projects it.** Tab order, group membership
and layout all live in the main process. Drag-to-reorder sends an index and gets
the authoritative order back, which avoids the class of bug where an optimistic
UI and the real tab list disagree after a fast drag.

**One IPC vocabulary.** `ipc/channels.js` is the single source of truth; both
the preload and the router import it, and a channel not listed there cannot be
invoked at all. `router.missing()` reports declared-but-unimplemented channels at
boot — a wiring bug is much cheaper to see there than as a silent failure.

That check earns its keep: while the mode services were being added, two
commits declared the gaming channels before their handlers existed, and the
smoke test failed on exactly that — 30 channels declared, none implemented.
Unit tests passed on both, because nothing imports the channel list except
the router. **Run `npm run smoke`, not just `npm test`, before pushing
anything that touches `channels.js`.**

**Fail open on filters, fail closed on permissions.** A blocker bug should
degrade blocking, not break the web. An unknown permission should be denied.

**Dependency injection, no globals.** Services receive collaborators as
constructor arguments, which is what lets the Feature Store tear a subsystem
down without leaving dangling references.

**Renders are batched into one animation frame.** A burst of tab events costs
one layout pass, not twenty.

---

## Android

The same architecture where it transfers, different where the platform differs.

`FilterEngine.kt` is a port of the desktop matcher — same tokenised index, same
ABP semantics, same catch-all fallback. It matters more here: WebView's
`shouldInterceptRequest` runs on an IO thread and *blocks* the request until it
returns, so a linear scan would stall page loads outright.

Differences forced by the platform:

- Resource type is inferred from the `Accept` header and file extension, since
  WebView does not report it.
- Only site-specific cosmetic filters are injected; the DOM-token scan the
  desktop does costs more on a phone than the ads did.
- Secrets go in `EncryptedSharedPreferences` (hardware keystore), never the JSON.
- One `WebView` per tab, retained across switches so history and scroll position
  survive, keyed in Compose so switching tabs does not reuse the previous slot.

### Colour

`ui/Palette.kt` grows a full Material scheme from one seed colour, for the
devices and settings where Material You is not doing it for us — Android 11 and
below, and any user who has picked their own accent.

The thing to know before touching it: **a Material tone number is CIE L\***,
perceived lightness, not HSL's `L`. Setting `lightness = tone / 100` is the
obvious implementation and it is wrong. HSL calls a saturated yellow at L=0.4
"mid" while the eye reads it as nearly white, so tone 40 lands at a different
brightness for every hue and Material's guaranteed pairings stop being
readable: white on a yellow tone-40 measures 2.2:1, against the 4.5:1 that text
needs. `Palette.tone` therefore binary-searches HSL lightness until the result's
*measured* L\* matches the tone asked for. Every Material pairing then clears
6:1 at every hue, which `PaletteTest` asserts directly.

It is still not full HCT — hue and chroma are HSL's, so two seeds at equal
nominal chroma are not equally colourful. That affects how vivid the palette
looks. Contrast, the part that decides whether the app is usable, is exact.

### Tab thumbnails

`WebView.draw` renders what is *currently composited*, so a backgrounded tab
photographs as a blank rectangle. Captures therefore happen at the moment a tab
stops being visible — opening the switcher, and `onPause` — never when the
switcher asks for them.

Private tabs are never captured at all. A thumbnail is a record of what was on
screen, and that is the one thing a private tab promises not to keep.

The cache is capped at twelve because these bitmaps are the only large objects
the app holds; without a cap a browser left open with forty tabs spends more
memory remembering what they looked like than rendering them.
