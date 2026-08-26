# Build plan

The spec (§10) asks for a phased plan "with milestones a team could actually
track against". This is that plan, plus an honest column this repository can
fill in: **what already exists here, and what a real team would still have to
do.**

The distinction matters. This repository is one engineer-equivalent working
in a sandbox with no Chromium build farm, no signing certificates, no VPN
infrastructure and no platform API credentials. It has built a working
browser on Electron that demonstrates every mode end to end. It has *not*
built the things that need money, hardware, legal agreements or a team — and
the plan below says which is which rather than blurring them.

---

## How to read the status column

| Marker | Meaning |
|---|---|
| **Done** | Implemented here, exercised by tests, and demonstrably working. |
| **Done (Electron)** | Implemented on Electron rather than a Chromium fork. Behaviour is real; the substrate is not a fork. See `ASSUMPTIONS.md` §1. |
| **Partial** | The client is complete; the thing it talks to does not exist yet. |
| **Not started** | Needs resources this environment does not have. |

---

## Phase 0 — Groundwork (weeks 1–4)

> *Fork Chromium, set up CI/build for three desktop OSes, establish the Mode
> API architecture and the Feature Store data model before any mode-specific
> UI is built.*

This phase's real content is the last clause, and it is the one that pays for
itself. Building the Mode API and the Feature Store data model **first** is
what makes Phases 3 and 4 additive rather than a rewrite.

| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| 0.1 | Chromium fork builds on Linux, macOS, Windows | `autoninja -C out/Release chrome` green on all three; artefacts uploaded | **Not started** — needs a build farm; a full Chromium build is ~4h on 32 cores and ~100 GB of disk |
| 0.2 | Upstream-merge process | Documented weekly rebase onto stable; one merge performed | **Not started** |
| 0.3 | CI pipeline | Every push builds, unit-tests and produces installers | **Partial** — Android APK and desktop CI exist and are green; no three-OS installer job |
| 0.4 | **Mode API** | A mode is a document; adding one touches no existing mode | **Done** — `services/modes.js`; six built-ins, custom modes are the same shape |
| 0.5 | **Feature Store data model** | Features declare cost, dependencies and defaults; toggling cascades both ways | **Done** — `services/feature-store.js`, 76 features |
| 0.6 | **Overlay semantics** | A mode never mutates stored preferences | **Done** — three-layer resolution, asserted by test and by the smoke run |
| 0.7 | Crash reporting and symbol upload | Symbolicated stacks from a release build | **Not started** — deliberately: there is no telemetry in this codebase (`ASSUMPTIONS.md` §8) |

**Gate to Phase 1:** 0.4–0.6 complete. A team that starts mode UI before the
Mode API is settled will build the branching mess the spec explicitly forbids.

---

## Phase 1 — MVP (weeks 5–14)

> *Shared baseline complete, plus Programmer and Gamer at their v1 feature
> set. Ship a usable daily-driver browser first.*

| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| 1.1 | Tabs, groups, workspaces, split view | Group members stay contiguous; split clamps and falls back when narrow | **Done** |
| 1.2 | Command palette | Ranked search over tabs, history, bookmarks, settings, extensions | **Done** |
| 1.3 | Network-layer ad blocking | Cancelled before a socket opens; auto-updating lists; per-site toggle | **Done** — 112k rules, ~21µs/request |
| 1.4 | Incognito | Multiple simultaneous isolated contexts, destroyed on close | **Done** |
| 1.5 | Password manager | AES-256-GCM vault, autofill, breach checking | **Done** |
| 1.6 | VPN | WireGuard tunnel, kill switch, honest scope labelling | **Partial** — client complete; **no VPN servers exist**. BYO WireGuard works today |
| 1.7 | E2EE sync | Blinded record ids, collection bound as AAD | **Partial** — client complete; no sync server ships |
| 1.8 | Programmer v1 | DevTools, REST client, sockets, localhost, JSON viewer | **Done** |
| 1.9 | Gamer v1 | Turbo, FPS/hardware overlay, stream mini-player | **Done** |
| 1.10 | **Mode Switcher** | No restart, no lost tabs, animated transition | **Done** — smoke test asserts the tab set is identical across four switches |
| 1.11 | Daily-driver quality | 2 weeks of internal dogfooding with no P0s | **Not started** — needs users |
| 1.12 | Signed installers | Notarised .dmg, signed .exe, .deb/.rpm | **Not started** — needs certificates (~$400/yr) and an Apple developer account |

**Gate to Phase 2:** 1.11. Shipping AI on top of a browser people do not yet
trust for daily use inverts the order of the problem.

---

## Phase 2 — AI layer (weeks 12–18, overlapping Phase 1)

| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| 2.1 | Assistant panel grounded in the active tab | Answers cite the page; private windows contribute nothing | **Done** |
| 2.2 | Multi-tab context | Explicit per-window grant, expiring with the window | **Done** |
| 2.3 | **Action confirmation gate** | Write tools cannot execute from the model's decision alone | **Done** — enforced at the broker, so prompt injection can at most raise a confirmation card |
| 2.4 | Hybrid inference | On-device (Ollama) and hosted, user-selected | **Done** — hosted path needs an API key |
| 2.5 | AI notes and flashcards | Article/transcript/PDF → structured notes, exportable | **Done** — Notion export needs a token |
| 2.6 | Latency budget | p50 < 400ms to first token on hosted | **Not started** — needs production measurement |

---

## Phase 3 — Mode expansion (weeks 15–26)

> *Deepen Programmer/Gamer; ship Creator, Student and Privacy modes.*

This is the phase the Mode API was built for. Every item below was added
**without modifying another mode**, which is the architectural claim the spec
makes and the one worth checking in review.

| # | Milestone | Status |
|---|---|---|
| 3.1 | Programmer: GraphQL explorer with introspection | **Done** |
| 3.2 | Programmer: Docker/container status | **Done** — read-only by design; that socket is root-equivalent |
| 3.3 | Programmer: terminal panel | **Done** — dev profiles only; pipe-backed, so curses programs will not render |
| 3.4 | Programmer: database client | **Done** — read-only, twice over. SQLite needs no driver; Postgres/MySQL need theirs |
| 3.5 | Programmer: snippet manager, API mocking, dependency/CVE watcher | **Done** — CVEs from OSV.dev; only names and versions leave the machine |
| 3.6 | Programmer: profiler waterfall and page audits | **Partial** — service scaffolded on CDP; the audit rule set is thin |
| 3.7 | Gamer: ping/latency graph and region tester | **Done** — TCP handshake, labelled as such (ICMP needs root) |
| 3.8 | Gamer: instant-replay clipper | **Done** — ring buffer with header retention, unit-tested |
| 3.9 | Gamer: controller remapping and gamepad navigation | **Done** |
| 3.10 | Gamer: screenshot gallery auto-organised by game | **Done** — grouped by window title, the only signal available without a platform hook |
| 3.11 | Gamer: LFG sidebar | **Partial** — Steam friends-in-game is real; other platforms have no public API |
| 3.12 | Gamer: cloud-save conflict widget | **Partial** — **no storefront exposes per-title save state publicly**; the widget says so rather than inventing one |
| 3.13 | Creator: asset library | **Done** — Openverse and Wikimedia, keyless, with attribution |
| 3.14 | Creator: brand kit, thumbnail A/B, teleprompter, focus canvas | **Done** |
| 3.15 | Creator: upload scheduler and channel analytics | **Partial** — queue is real; publishing needs OAuth per platform |
| 3.16 | Student: citations (APA/MLA/Chicago) | **Done** — CSL-JSON export, 18 tests |
| 3.17 | Student: LMS deadline import | **Done** — ICS, the one integration every LMS shares |
| 3.18 | Student: focus timer and blocker | **Done** — cancelled at the network layer, not hidden with an overlay |
| 3.19 | Student: PDF annotation and OCR search | **Partial** — annotations and search are done; no OCR engine bundled (~15 MB WASM), so scanned-only pages need one configured |
| 3.20 | Student: group study room | **Partial** — pins an existing room; Aether does not host calls (no signalling or TURN infrastructure) |
| 3.21 | Ghost: Tor routing | **Done** — real SOCKS5 to a local daemon; **refuses rather than falling back** when none is running |
| 3.22 | Ghost: metadata stripping | **Done** — JPEG/PNG container walk, image data byte-identical, 10 tests |
| 3.23 | Ghost: shredder, DoH picker, panic button | **Done** — shredder documents what overwriting cannot promise on an SSD |
| 3.24 | Ghost: breach monitor dashboard | **Done** — k-anonymity; a failed lookup is never counted as clean |

---

## Phase 4 — Feature Store and custom modes (weeks 24–30)

| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| 4.1 | Every feature individually toggleable | Toggling releases resources, not just UI | **Done** |
| 4.2 | Dependency cascade | No reachable inconsistent state | **Done** |
| 4.3 | Custom-mode builder | Mix features from any built-in; appears in the switcher beside them | **Done** |
| 4.4 | Per-mode overrides with reset | A changed preset says so and offers the way back | **Done** |
| 4.5 | Mode import/export and sharing | Share a mode as a file or link | **Not started** — the document shape supports it; no UI |

---

## Phase 5 — Mobile (weeks 28–40)

| # | Milestone | Status |
|---|---|---|
| 5.1 | Android baseline: ad block, tabs, private mode, encrypted storage | **Done** — `android/`, builds clean in CI |
| 5.2 | Android: AI assistant and note sync | **Done** |
| 5.3 | **Android: mode parity** | **Not started** — the Mode API is desktop-only today; the Android app has no switcher |
| 5.4 | Android on a device | **Not started** — the APK compiles and lints but has never been run |
| 5.5 | Play Store listing | **Not started** |
| 5.6 | iOS | **Not started** — scoped separately, correctly: WebKit policy means an iOS build cannot use this engine or this blocker at all |

---

## Phase 6 — Scale and monetisation (from week 30)

| # | Milestone | Status |
|---|---|---|
| 6.1 | Pro billing | **Not started** — needs a payment processor and an entity to receive money |
| 6.2 | VPN infrastructure | **Not started** — the expensive one: WireGuard endpoints across regions, plus a no-log policy that survives audit |
| 6.3 | Sync server at scale | **Not started** — the protocol is four endpoints and a change cursor, so this is cheap by design |
| 6.4 | Reliability telemetry | **Will not do as specified.** §10 asks for "analytics-free usage telemetry for reliability only". This codebase has none, and adding it would undercut the onboarding promise. Crash reporting could be added as strictly opt-in |

---

## Team shape

The spec proposes 2 Chromium/C++ · 2 frontend · 1 backend · 1 ML · 1 design ·
1 PM, and advises smaller teams to do Phase 0–1 only. That advice is right,
and this repository is a data point for it: **Phases 0, 1, 3 and 4 are
substantially done without any Chromium engineers**, because building on
Electron removes the C++ work entirely.

What that trade actually costs, so it can be decided rather than discovered:

| | Fork | Electron (this build) |
|---|---|---|
| Chromium engineers needed | 2 | 0 |
| Time to first usable build | ~4 weeks | days |
| Patch the network stack, compositor, sandbox | Yes | No |
| Ship a smaller binary than ~150 MB | Yes | No |
| Everything in §2–§8 of the spec | Yes | Yes — all of it is reachable from Electron's public API |

Nothing the spec asks for needed the fork. If a later requirement does — a
custom network stack, a modified sandbox, sub-100 MB installers — that is the
moment to hire for it, and the Mode API and Feature Store carry across
unchanged because neither touches Chromium internals.

A revised shape for a team building *this* version:

- **2 frontend/product engineers** — modes, panels, chrome
- **1 systems engineer** — blocking, profiles, performance, the OS-level work
- **1 backend engineer** — sync, VPN, billing (the whole of Phase 6)
- **1 ML engineer** — from Phase 2, part-time before it
- **1 designer, 1 PM** — from Phase 1

The two Chromium engineers become necessary only if the fork does.

---

## Critical path

```
0.4 Mode API ──┬─→ 1.10 Switcher ──→ 3.x every mode ──→ 4.3 Custom modes
               │
0.5 Features ──┘

1.3 Ad blocking ──→ 1.11 Dogfooding ──→ 1.12 Installers ──→ 6.1 Billing
                                    ↘
1.6 VPN client ──→ 6.2 VPN infra ─────→ Pro tier is sellable
```

Two things gate everything downstream and are worth over-investing in early:
the **Mode API** (0.4), because every mode after it is additive or is not; and
**VPN infrastructure** (6.2), because it is the long pole on the revenue path
and the only item on this plan with a serious recurring cost.
