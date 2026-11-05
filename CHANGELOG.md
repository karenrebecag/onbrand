# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning
([SemVer](https://semver.org/)). This changelog records **product decisions and capability changes**, not every
commit. Fine detail lives in the PRs and in `docs/adr/`. Update and version-cut rules are in
[`docs/governance.md`](docs/governance.md).

## [Unreleased]

## [0.1.0-alpha.1] — white-label core — 2026-11-05

First alpha of the `onbrand` core (ADR 0017): the repo ships only the white-label core, and the Atom distribution
consumes it by tag. The Arc scaffold, the porter, the Arc registry and the Blob adapter left the tree in #911 and live
in the distro from commit 6738b6c3 (`docs/notas/distro-handoff.md`). Package: name `onbrand`, exports
`session-provider`, `serve`, `orchestrator`, `build-registry`; bins `onbrand-serve`, `onbrand-orchestrator`,
`onbrand-build-registry`; MIT license; `files` whitelist (#921). Block candidates are filtered by the active
scaffold (#918) and the core starts without `catalog/` (#921). Known pending: the mixed core/distro catalog
(`docs/spec/catalogo-core-distro.md`) and the 74 core modules the distro still imports by path
(`docs/notas/distro-imports-inventario.md`).

Everything below was unreleased until this cut.

### Added
- **User identity with scope (H3, phases 0-4; `docs/spec/identidad-sesion.md`):** a `SessionVerifier` port with a single
  gate in the router (#660); an owner per chat, where someone else's chat answers 404 before any scope check
  (#676, guard #662); scopes per route, with `chat:read` for the heartbeat and `spend` for paid routes and for an
  "always" approval on a paid tool (#687, #693); "always" approvals stored per (owner, tool) (#647, #664); brand
  instructions and memory per (owner, brand), with existing data kept as the local owner's without a migration (#706).
  The builder shows a rejected session with its own copy and does not retry (#663). The identity provider of the
  `atom` profile (phase 5) is still open and is Karen's decision.
- **Scoped preview token (identity §9):** an HMAC token per ws, delivered by the heartbeat, exchanged for a host-only
  cookie and required by HMR too (#667, #671, #680, #692). Under the orchestrator the token is Ed25519: the
  orchestrator signs and the VM only verifies (#728).
- **Export package (H9, P1/P3):** the site and the page are built from the version's commit without the preview
  bridges (#651, #657, #688, #698). The `source` zip leaves out `request.json` and `instructions.json` (#658). There is
  a single Export menu with download status (#661, #673) and "Copy for MCP" (#630). `publishable` and local publish
  run on the same export dist (#694). Publishing to external services belongs to the distribution, not the core
  (#656).
- **Canvas (builder module, units 1, 2 and 5):** rectangle selection and a pane context menu (#674, #691); Shift+Cmd+F
  arranges and Cmd+V pastes images (#697); the screen name above the frame, as in Stitch (#678, #700); the theme panel
  shows the DS pin and "Update DS" when the registry publishes a newer one (C3, #633, #637).
- **Deploy pieces of ADR 0016, as pure modules not yet wired** (`docs/spec/deploy-sandbox.md`):
  - a global chat index and a spend counter in Blob, with conditional writes (`ifMatch`, uncached reads; #717, #720);
  - a signed Ed25519 identity header and `WT_SESSION_PROVIDER=signed`, which replaces the loopback verifier inside the
    VM (#724, #725);
  - the orchestrator's Gateway proxy, with a per-run token, a spend reservation, a cap in USD and a mandatory
    `waitUntil` (#727, #730, #734);
  - with the proxy, the runtime and the CLI never hold the Gateway key, and startup fails if one is left in the
    environment (#708);
  - the per-run spend token reaches the CLI as an argument (#732).
- **Executable standards guards:** A1, A2, A4, A9, B5, 404 before 403 (#654, #662). There is a HACK ledger with a
  trigger on every mark (#716, #719).

- **Plan mode (H6):** a turn sent with `mode: 'plan'` writes only `.wt/plans/<messageId>.md` (ADR 0012 format) and ends
  with the deferred tool `exit_plan_mode`, which goes through Approvals as a `plan` request carrying the plan text; no
  version is created. Approve or edit resumes the same session in build on the same message and creates the version;
  reject cancels, and a reject with a note opens a new plan turn carrying the note and resumes the plan's session
  (#601, builder #599, spec #600); a new message while a plan is pending cancels it (`user-message`) and resumes the session. The draft
  can be edited before approving (`PUT /chats/:chat/plans/:messageId`); edited lines are marked `usuario:` and the
  build keeps them literally. Same shape as Lovable (`plan.md` + `plan--show`) and Figma Make (`/plans/<slug>.md` +
  deferred `ExitPlanMode`), captured live on 2026-11-04. Spec: `docs/spec/plan-mode.md`.
- **Agent context in the builder (M2):** the last turn's footer shows "Contexto NN %" with a warning from 0.6; a
  "Datos de ejemplo (N)" chip with "Reemplazar" preloads the composer; "Recordó: …" notes and a Memory tab next to
  Instructions (`GET/PUT /brands/:id/memory`, 404 = empty). Old turns opened from the log fold to request, summary
  and chips. The fold tolerates a server that does not emit the events yet.
- **The agent sees the page at the person's width (M2 Q6):** `preview-check` takes the request viewport, the runtime
  check measures that width besides the standard ones, and the `browser` tool without a viewport uses the person's.
  Before, the agent checked 1440/375 while the person looked at 1280.
- **Brand memory rules (M2, H8):** `memory-edit.ts` owns the `memory.md` format (`- fact · messageId · YYYY-MM-DD`),
  the caps (40 lines, 4 KiB, 200 chars per fact) and the personal-data filter (email, phone, token), shared by the
  person's `PUT` and the agent's `remember` tool (`memory-tool.ts`), wired to disk and to `memory.write` events
  (#549); atomic write, no orphan `.tmp`, a disk failure comes back as a tool error (#572, #578).
- **ADR 0014 and the M2 contract:** why `transport.ts` splits into collaborators with explicit deps, and the agent
  context contract (brand memory, `context.usage`, `facts.invented`, viewport) in `docs/spec/contexto-agente.md`.

- **Timezone per request (#598):** `POST /runs` (and the steer to a live turn) takes an optional IANA `timezone`, as
  Lovable sends `user_timezone` on every chat turn; 400 if it is not an IANA zone. It wins over `WT_TZ` for the date
  of the brand-memory facts of that run; without either, UTC. The builder sends the browser's zone (#599).
- **Thread fold with a cap (H18, #602):** a follow-up with more than 4 earlier turns gets the older ones as
  `conversation_history/summary.md` (cheap infer, with a no-model fallback) and only the last 4 in full
  (`thread-fold.ts`); `GET /chats/:id` returns `context {ratio, lastTokens, floorTokens, window}` per message for the
  builder meter. Make's compression is inferred, not observed (`docs/spec/contexto-agente.md` §2).
- **Pinned text (Q1, #615):** what the person dictated in quotes in earlier requests, and the `usuario:` lines of a
  plan, stay literal in the follow-up (`pinned.ts`); a sensor reports `pinned.lost` with file and text when a turn
  overwrites one.
- **The person's viewport reaches the plan's build phase and its verification (Q6, #616).**
- **Sample data per run (C4, #622):** `facts.disclosed` per run and a "Usar mis datos reales" chip in the builder.
- **Favorites per variant and the Frame tool (H14, #609):** the builder filters variants by favorite and turns a
  region into elements of the next request; the variant frame remounts once on close and a Frame over an old bridge
  warns instead of failing (#621).
- **Docs and specs:** H1 `checkPublishable` local (`docs/spec/publish-check-local.md`, #603); zip export and the read
  MCP (H9, `docs/spec/export-zip-mcp.md`, #619).

- **Not recorded before 0.5.0 was cut (#492-#529):**
  - **Theme:**
    - `presets.json` is generated from `foundation.css`, and `deriveTheme` is a pure function (#504).
    - Seed-color derivation with Material's `DynamicScheme`, with AA correction applied only to the derived tokens
      (#519, #524, #525).
    - Theme parameters are applied in a child run (#518).
    - A Theme panel with Apply, a live preview and the seed color (#522, #527).
  - **brand.json v2:**
    - A permanent dual reader (#507).
    - The repo's packs migrated with verified equivalence (#509, #510).
    - `applyBrand` refuses a pack with insufficient contrast (#506).
    - The brand skill describes the pack's shape and default mode in words (#508).
    - Arc state roles and tone palette taken as they are (#513).
    - The brands README describes v2 and the mapping from v1 (#511).
    - Atom's real Base and composition are read from the network fixtures in tests (#514).
    - A pinned token counts in the AA pairs that read it through `var()` (#516).
    - Sending the same accent again no longer clears the brand's dark accent (#520).
    - Applying a theme to a page without a pack keeps the agent's identity (#528).
  - **Catalog:**
    - 14 free Arc components for the agent (#523), with their contract schemas (#529).
    - Breadcrumb ported to the scaffold with `arc-provider` (#515).
    - A cleaning parser from Arc to the vault (#517).
    - The production registry index is published at `index@8db597abc916f2cf`, with the catalog of #515-#529.
  - **Model and export:**
    - Auto mode, where the server picks the model (#499).
    - The LLM provider is out of the config seam (#497).
    - `/transcribe` is served while the core stays agnostic (#492).
    - The page can be copied as a single self-contained HTML file (#494).
  - **Layout:** `app/`, `app-atom/` and `briefs/` move to `fixtures/` (#526).

### Changed
- **CI quarantine on Linux (B10, #763):** 4 tests red in CI since 932c6eb6 run with `test.skipIf(linux)` and a `HACK:`
  marker carrying the cause, the runs and the trigger: `v0-browser-section.browser`, `child-run` timedOut and
  `plan-mode-autorepair` ×2. #765 lifted it for the 2 `plan-mode-autorepair`. The other 2 stay until Bun is bumped in CI
  (#766, Karen's decision): Bun 1.3.14 on Linux breaks the next spawn with extra pipes (playwright) with
  `connect ENOENT`.
- **`src/v0` → `src/runtime`, `Transport` → `Runtime` (ADR 0015, #642).** The run cycle left the Runtime:
  - `run-cycle.ts` drops from 741 to 700 lines (#721);
  - `brand.ts` is split into five modules, which removes the value cycle `brand ↔ identity-ephemeral` (#695, #702);
  - `v0-transport.test.ts` is split by route family (#670).
- **Preview bridges** come from a vite plugin, not from the workspace (#641).
- **Section copy (#723):** copying a section takes the next free `<slug>-N` and no longer renumbers the others.
- **transport.ts split, Enmienda 1 of ADR 0014 (option A, decided by Karen; #595):** the run cycle left Transport.
  `run-checks.ts` (154 lines) and `run-close.ts` (336) in #612, `run-cycle.ts` (707) in #620; `transport.ts` went
  1147 → 593 and keeps the state of the cycle (`index`, `running`, `live`, `cancels`, `finished`, `late`,
  `lateChecks`, `stopReasons`), its persistence and the wiring. Every index write goes through `updateEntry`
  (rule 3). Mechanical moves with the closing-table test net (#583, #588, #592); import rules after the amendment in
  #626.
- **Run token (ADR 0014 condition 5, #627):** `launch` stamps a global monotonic token per run and `settle` ignores a
  late close from an older run of the same message, so it no longer depends on `cancels`, which only lives during
  the compose. The `cancels.has` guard and its `HACK` are gone.
- **Agent images (#614):** the `data-alt` image filler is out; section images come only from the `generate_image`
  tool.
- **Composer language (#617):** the builder composer speaks Spanish (`lang=es`).
- **Agent shell tools (B3):** `cat` and `head` left `CLI_TOOLS` and the prompt; `Read` covers them and the env scrub
  already exists.
- **transport.ts split (steps 1-4/6):** `http.ts`, `api-handlers.ts` (enhancer, connectors, uploads, transcribe,
  canvas), `direct-edit.ts` (model-free edits and the dry tsc of the patch route) and `brand-store.ts` (brand ids,
  summaries and per-brand instructions). No importer changes; 3484 → 3031 lines.
- **transport.ts split (steps 5-11):** shared types and helpers in `transport-shared.ts`; preview and dist in
  `preview-dist.ts`; run reads in `run-reads.ts`; variants in `variants.ts`; brand runs in `brand-runs.ts`; model-free
  and repair runs in `edit-runs.ts`; the workspace MCP, approvals and the plan cycle in `agent-mcp.ts`; the HTTP route
  table in `http-router.ts` and the pure request parsers in `run-input.ts`. Collaborators never import `transport.ts`
  (ADR 0014). Mechanical moves; 3227 → 1346 lines.

- **Auto-repair (runtime/render):** a version whose preview check found runtime errors, or whose render gate left a
  pending fix, now launches the fix by itself as a child message marked `autoRepair`, figma-make style (Karen
  2026-11-03, revoking the manual-only decision of 2026-11-02). One per version, never on a repair; the manual
  button and chip stay as fallback. `autoRepair: false` turns it off.
- **Builder autofix:** runtime and render errors no longer wait for a click. The builder follows the repair the
  server launches (`transport:autofix`), launches its own for errors only the live preview saw, and shows a
  "fixing" status instead of the button. "Arreglar" stays as the fallback when the automatic repair is spent or left
  errors.

### Removed
- **Visual comparison between versions (`preserve.visual`, #761):** `pixelDiff`, `visualDefect`, `baselineWithShots`,
  `sharedChanges`, `unchangedRoles` and the per-section PNG captures are gone. No reference measures it: Lovable, v0,
  Make and Stitch have no extract of it. It found 0 real defects in every log, its positive control did not fire, and
  calibrating it cost 9-12 false positives per version (the old `visual-sensor.ts:16-19`). Team consensus, 6/6, on
  2026-11-04. Kept: the per-version store (`shot-store.ts`: `shotStore`, `roleOf`, `pruneVersions`), `texts.json` for
  `preserve.text` and the DOM snapshot. `preserve.files`, `preserve.text` and `preserve.pinned` stay. They report, and
  they do not trigger the auto-repair, which counts only runtime defects (#594).

### Fixed
- **Orphan child after a failed spawn (#765):** on Linux, Bun 1.3.14 sometimes emits `error` EBADF on spawn with the
  child already launched. `runCommand` rejected without killing it, and it stayed alive. `track()` in `children.ts`
  now kills the group and the pid when `error` carries a pid, and takes the child out of the registry once it has died
  or is a zombie. Three tests that faked `PATH` now restore it in `afterEach`, because in bun a test that hits its
  timeout does not run its `finally`. Regression test: `tests/children-spawn-error.test.ts`.
- **No transport secret reaches the agent:** `WT_PREVIEW_SECRET` is filtered from the CLI and `sh` (#711).
- **Publish menu:** opening it no longer triggers a build; not-at-commit has its own copy (#704, #705).
- **Builder:** a live→live version change no longer remounts the iframes (#731).
- **Preview HMR:** an update for a module that was deleted, or created with no importers, no longer reloads the page
  (#733).
- **Runtime:** `step.start` is emitted before the step runs (#722). A client `messageId` with a real session needs at
  least 128 bits (#682).
- **Tests:** the full-suite flakes are fixed (#703, #718), and `--fixture` gives a servable version again (#686, #690).
- **Malformed `%` in a route (#596, #608):** every route with an id decodes through `seg()`, so a bad `%` is a 400
  and not a 500; `GET/PUT /chats/:chat/plans` validate `:chat`, `remember` takes no absolute path, and a decision
  with no plan or card is a 404.
- **Install (#585, #590, #597):** the install mark holds the hash of `package.json` + lockfile, is removed before a
  reinstall and written only after exit 0; the closing install skips `--frozen-lockfile` when the agent moved deps;
  the start-up install retries without frozen if the lock does not match, and with the agent a failed install no
  longer aborts the run: the error goes to the prompt.
- **Discards and "no writes" are measured against the parent version, not HEAD (#586, #593, #611):** a follow-up on
  a version that is not HEAD no longer commits a copy of its parent, and a discard returns to the parent's tree.
- **Repair counts only runtime defects (#594):** `RUNTIME_KINDS` is the single list shared by the server and the
  builder.
- **Security (H4):** the builder CSP is in enforce and the preview sends `frame-ancestors` (#604); publish rejects
  symlinks in the dist instead of following them out of the workspace (#605).
- **Publish and direct edit:** the `.base` marker of the dist no longer blocks publish, which answered 409 on every
  servable POST (#607); an edit rejected by `tsc` does not reappear in the preview (#606).
- **Builder:** variant photos reload with cache-bust on close and a missing route shows the neutral rectangle (A8,
  #613); the chip of an element painted by a DS block shows its section's file (#625).
- **A late step cut by shutdown says the transport shut down**, not that another run started (#628).
- **A Stop before the compose (install, DS mount, connectors) closes `stopped`**, not `failed` with an `error` event
  (#627).
- **Plan card:** reads the draft with `GET /chats/:chat/plans/:messageId` (once per card, not on every render) and
  says "Con tus cambios guardados" when edited; Approve, Edit and Reject wait for `message.end`.
- **Builder typecheck (collateral of #499):** the server model list mapped `mark` as a plain string, so
  `tsc -b` failed on `ComposerModel`; it is now the literal `'claude'`.

## [0.5.0] — Patch route, brand cycle and preview runtime — 2026-11-03

### Added
- **Agent patch route (H5):** a pre-turn classifier + `patch-ai` with a cheap infer and the AST appliers, for
  scoped changes without running a full turn. The client sends elements with their `file:line:col` origin.
- **Brand cycle (H7):** `applyBrand` as an operation; `GET /brands` with the data the Theme panel paints and each
  version's brand in the thread; per-brand instructions via `GET/PUT /brands/:id/instructions`, injected into the
  prompt above the person's own.
- **Preview runtime context (H10):** console logs, network requests and the iframe's runtime errors travel to the
  agent on every turn with a model.

### Fixed
- **Mixed brand:** a follow-up naming a different brand now returns 409 and points to `applyBrand`, instead of
  leaving the page with the previous identity.
- **DESIGN.md coherence:** validation also runs on the editable-pack branch, and `applyBrand` no longer leaves the
  previous brand's DESIGN.md.
- **Test pollution:** a test leaked global `window` into the bun process and broke the SSR render of the shader
  blocks. The descriptor is now restored in `afterEach`.

### Changed
- CI no longer runs the suite on docs-only PRs (`paths-ignore` for `**/*.md`, `docs/**`, `LICENSE`).
- Two flaky wall-clock tests quarantined (`test.skip` with a `HACK:` marker and its re-enable trigger):
  infer-CLI-abort and the preview pool's ws-eviction.

### Docs
- Professional README: architecture (109 modules across 15 layers), control flows, the thesis and the limits.
- Rescued ADR 0003 and its spec (they were unversioned; repaired a broken link in the ADR index).
- `docs/governance.md`: git, branch, worktree, changelog and release rulesets.

## [0.4.0] — Robustness and observability

### Added
- Per-turn traces with OpenTelemetry: OTLP for remote, local Spotlight via a custom exporter.
- Robust execution (claim/release, single settled, recovery on startup) and ADR 0013.
- Generative avatars, mobile carousel and an AA WhatsApp skin.

### Changed
- The agent preloads the skill and the blocks' prop/data types on startup.
- Contrast AutoFix after the preview-check.
- Move a section and edit a text attribute without running the workspace `tsc`.

### Fixed
- A single React instance in the preview.
- Errors before an HMR update stop counting.
- On follow-up, the agent adds without removing and asks on a clash.

## [0.3.0] — Session and builder canvas

### Added
- Per-chat canvas, reload that returns to the same thread, one root per process keeping the stopped version.
- Next steps as the agent's own step.
- The rail image as a free canvas node.

## [0.2.0] — Brand and porter

### Added
- Brand profile, identity token map, reserved brand slot (ADR 0004), component porter to the DS.

[Unreleased]: https://github.com/karenrebecag/onbrand/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/karenrebecag/onbrand/compare/v0.5.0...v0.1.0-alpha.1
[0.5.0]: https://github.com/karenrebecag/onbrand/compare/v0.4.0...v0.5.0
