# Assumptions, decisions and limits

The spec said: "Where a decision isn't specified, choose the option a top-tier
consumer browser would ship, and state the assumption." This is that statement,
plus an honest account of where this build stops short.

Read the last section first if you want to know what is *not* here.

---

## 1. The foundation

**Assumption: "latest stable Chromium" means the Chromium inside the current
stable Electron, not a source fork.**

The spec anticipated this and allowed the closest achievable version. Electron
44 embeds Chromium 152. Upstream security patches arrive by bumping the Electron
dependency, which is a one-line change and a rebuild.

What a real fork would additionally allow, and this cannot: patching the network
stack, the compositor or the sandbox itself. Nothing in the spec required that —
the blocking, isolation and DevTools requirements are all reachable from
Electron's public API — but it is the honest boundary.

**Assumption: "zero shims" for Manifest V3 means we do not translate the API,
not that every API works.**

Extensions load through Electron's extension host on the same Chromium build.
Most MV3 surface works. Some (`chrome.debugger`, `printing`, enterprise APIs)
is not implemented by that host. Rather than paper over it, the manifest linter
names each unsupported permission explicitly, because an extension that silently
half-works costs a developer more than one that says why.

---

## 2. Interface decisions

| Decision | Choice | Why |
|---|---|---|
| Default tab layout | Vertical | The spec lists vertical first and horizontal as the toggle. Arc's default. |
| Address bar position | Top on desktop, **bottom on Android** | Thumbs. Chrome and Safari both moved mobile address bars down. |
| New tab placement | Immediately right of the active tab | Chrome's behaviour; keeps related tabs adjacent. |
| Closing a tab | Activate the tab to its right | Every mainstream browser. |
| Split view partner | The next tab along | What the user means ~90% of the time; the tab context menu offers an explicit pick. |
| Reduced motion | Honoured from the OS, plus a Feature Store switch | Accessibility is not a preference to bury. |
| Search engine | DuckDuckGo | A privacy-first browser defaulting to Google would contradict its own onboarding. |
| Search suggestions | **Off** by default | They send every keystroke to the engine before you press Enter. |

**Frameless windows with native controls per OS.** macOS gets real traffic
lights via `titleBarStyle: hiddenInset`. Windows gets `titleBarOverlay`, so Snap
Layouts and the system menu keep working. Linux has no overlay API, so the
chrome draws its own controls.

---

## 3. Privacy decisions

**Filter lists.** EasyList, EasyPrivacy, uBlock filters, uBlock privacy and
EasyList Cookie, on by default; Peter Lowe's list available but off. Each
subscription carries mirrors and the updater falls through them, because
filter-list hosts go down, get rate-limited, and are blocked on corporate and
mobile networks often enough that a single-URL fetcher would silently degrade a
user's protection. (This is not hypothetical: the canonical `easylist.to` host
was unreachable from the environment this was built in; the mirrors are why the
smoke test still loads 111k rules.)

**Unsupported filter syntax is dropped, not approximated.** `$redirect=`,
scriptlet injection and `:has()` extended selectors need machinery we do not
have. Dropping a rule degrades blocking slightly; mis-parsing one breaks a site.

**Generic cosmetic filters are lazily applied.** EasyList carries ~13k generic
hiding selectors. Injecting them all as one stylesheet hands the style engine a
selector list larger than most pages' own CSS. They are indexed by leading
class/id token and only materialised when that token is in the document — the
approach uBlock Origin settled on for the same reason.

**Fingerprint resistance is a reduction, not a cloak.** Perfect resistance
requires making every user identical, which breaks too much of the web to ship
on by default. We normalise the signals that carry the most bits and cost the
least: high-entropy Client Hints, canvas/audio noise per origin, and a UA that
does not advertise Electron. This is the tradeoff Brave's farbling makes.

**The VPN's scope is stated, not implied.** This is the decision most likely to
be quietly fudged, so:

- With WireGuard tools installed → a real device-wide tunnel with an iptables
  kill switch. Keys generated locally via Curve25519; the private key never
  leaves the machine.
- Without them → a browser-only tunnel through the provider's proxy, applied per
  Electron session. This is what Opera and Brave ship as a "browser VPN".
- **The UI says which one is active** — "entire device" or "this browser only".

The free tier is capped at 10 GiB/month, enforced client-side and again by the
provider. Aether's own VPN endpoint is a configurable URL: no servers ship with
this repository, and a "Custom WireGuard" provider lets you point the same UI at
Mullvad, IVPN or your own box with no account at all.

**Downloads and history never record incognito activity.** Not filtered at
display time — never written.

---

## 4. AI decisions

**Default model: Claude Opus 5, hosted.** The assistant is asked to reason over
whole pages and compare claims across tabs, which is exactly the work a small
model does badly. On-device (Ollama) is a first-class alternative, and it is the
*user's* choice: page text is never sent to a hosted model as a silent
performance optimisation.

**Multi-tab context is off by default and granted per window.** "Let the
assistant read my other tabs" should not be something enabled once in 2026 and
forgotten. The grant dies with the window.

**Private windows contribute no page content, ever.** Not a setting.

**The action gate is structural.** Tools declare `read` or `write`; write tools
cannot execute from the model's decision alone. Additionally, a *read* tool
whose arguments describe a real-world action ("confirm purchase") is gated too.
Filling a form and submitting it are separate tools requiring separate
approvals. Prompt injection can at most surface a confirmation card.

**The system prompt states that page content is data, not instructions.** The
assistant reads attacker-controlled text on every request; the tool gate stops
actions, not bad answers.

---

## 5. Developer decisions

**The CORS toggle is constrained by construction, not by warning text.** The
spec asked for a dev-profile-only toggle with a persistent banner. Enforced as:
a profile whose kind is not `dev` cannot enable it at all (the call throws), the
state is in memory only so it never survives a restart, and the banner cannot be
dismissed while it is on.

**Local servers bind to 127.0.0.1 only.** A dev server reachable from the LAN is
a way to leak a work-in-progress build, and nobody asked for that.

**The JWT decoder never says "valid".** Verifying a signature needs the key; a
decoder that implies validity is how `alg: none` bugs ship. It reports what it
can check, warns on `alg: none` and missing `exp`, and will verify HMAC
signatures if you supply the secret — with a constant-time compare, so the tool
cannot be used as an oracle.

**Git cards use unauthenticated GitHub/GitLab API by default,** with an optional
token for rate limits and private repos. Responses are cached for 90s: PR state
does not change per hover.

---

## 6. Sync decisions

**Zero-knowledge means the server holds no key material and cannot invert a
record id.** Record ids are HMACs under a key derived from the passphrase, so
the server cannot confirm a guess about what you have bookmarked. The collection
name is bound in as AEAD associated data, so a record cannot be moved between
collections without failing to decrypt.

**Conflict policy is last-write-wins per record, with two exceptions** where LWW
loses data users notice: history visit counts are merged rather than
overwritten, and deletions are tombstoned so a device offline for a week does
not resurrect everything it still remembers.

**The vault key can double as the sync key,** so a user has one secret rather
than two. A separate HKDF-derived subkey is used for sync, so a sync-side
compromise cannot be replayed against the local vault file.

**No sync server ships with this repository.** The transport speaks a
deliberately small REST protocol (four endpoints) so self-hosting is realistic;
the server is a key-value store with a change cursor and needs no crypto of its
own.

---

## 7. What is not here

Stated plainly, because a feature list that quietly omits its gaps is worse than
one that admits them.

**No compiled Chromium fork.** Covered in §1.

**The Android APK is not built in this repository's CI-less form.** The Android
SDK ships only from `dl.google.com`, which was unreachable from the environment
this was built in, so the APK could not be compiled or run here. What is
committed: the complete Kotlin/Compose source, a working Gradle setup with the
wrapper, and a GitHub Actions workflow that produces a downloadable APK. The
desktop build was compiled, launched and screenshotted; **the Android build was
not**, and may need compile fixes on first run — that is the honest status.

**No hosted services.** The VPN, sync and AI all point at configurable
endpoints. The code that talks to them is real and complete; the servers are
not in scope for a browser repository. The BYO WireGuard and Ollama paths work
today with no account anywhere.

**Extension MV3 coverage is Electron's, not Chrome's.** Covered in §1.

**Some features are wired end-to-end but exercised only by unit tests**, because
verifying them needs hardware or credentials this environment lacks: WireGuard
tunnel establishment (needs elevation and a server), Notion export (needs a
token), breach checking (network to HIBP), on-device inference (needs Ollama
running). Their logic is tested; their integration is not.

**PWA OS registration is Linux-only in a dev checkout.** A `.desktop` entry is
written directly. macOS and Windows need a bundle or shortcut created by the
packaged installer, which is a packaging step outside a source tree.

---

## 8. Things deliberately not done

**No telemetry, analytics or crash reporting.** Not a single call. A browser
that claims your data is never sold, then phones home with usage data, has
already lost the argument.

**No "anonymised" usage statistics.** Same reason.

**The AI action gate has no off switch.** It is listed in settings as
`confirmRealWorldActions` for transparency, and the UI does not offer a way to
turn it off. A user who genuinely wants an unattended agent wants a different
product.

**Chromium's ad-privacy stack is disabled**, not adopted: Topics, Attribution
Reporting and Privacy Sandbox are switched off at the command line. Topics is
itself a tracking surface, and we do the blocking at the network layer anyway.
