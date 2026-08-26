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
