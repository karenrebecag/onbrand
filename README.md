```
 ██████╗ ███╗   ██╗██████╗ ██████╗  █████╗ ███╗   ██╗██████╗
██╔═══██╗████╗  ██║██╔══██╗██╔══██╗██╔══██╗████╗  ██║██╔══██╗
██║   ██║██╔██╗ ██║██████╔╝██████╔╝███████║██╔██╗ ██║██║  ██║
██║   ██║██║╚██╗██║██╔══██╗██╔══██╗██╔══██║██║╚██╗██║██║  ██║
╚██████╔╝██║ ╚████║██████╔╝██║  ██║██║  ██║██║ ╚████║██████╔╝
 ╚═════╝ ╚═╝  ╚═══╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝
```

# onbrand

An AI landing-page generator that writes on top of **your** design system. You describe the page in a prompt and
an agent writes the React code section by section using your DS components and tokens. It checks types, build and
screenshots before handing off, and every message becomes a git version with a live preview.

Same category as v0, Lovable, Stitch or Figma Make (AI page/app builders). **The difference is the product thesis:**
brand identity is a *validated input*, not a model invention. onbrand injects a brand pack (identity.css + DESIGN.md
+ facts) over the DS contract and edits deterministically on the AST when it can. The other four infer or invent the
style; onbrand imposes and validates it.

---

## Table of contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Control flows](#control-flows)
- [What it does well](#what-it-does-well)
- [Running locally](#running-locally)
- [Configuration](#configuration)
- [Tests](#tests)
- [Contributing and releases](#contributing-and-releases)
- [Repo layout](#repo-layout)
- [Architecture decisions](#architecture-decisions)
- [Status and known limits](#status-and-known-limits)

---

## How it works

```
 prompt
   │
   ▼
┌──────────────┐   claim ws    ┌─────────────────────┐   writes src/    ┌──────────────┐
│  transport   │──────────────▶│  agent (claude -p)  │─────────────────▶│  workspace   │
│  HTTP + log  │               │  tools + DS skill   │  section .tsx    │  = git repo  │
│  NDJSON      │◀──────────────│  checks + shots     │◀─────────────────│  1 commit/ver│
└──────┬───────┘   events      └─────────────────────┘                  └──────┬───────┘
       │                                                                        │
       │ stream by cursor                                       install + vite build
       ▼                                                                        ▼
┌──────────────┐                                                        ┌──────────────┐
│   builder    │   canvas · versions · variants · approvals             │   preview    │
│  (Vite/React)│◀───────────────────────────────────────────────────── │  Vite per ws │
└──────────────┘                                                        └──────────────┘
```

1. The **builder** sends the prompt to `POST /runs`. The **transport** starts the run *decoupled from the
   connection* and writes its NDJSON log with a `seq` cursor: any tab can resume the stream.
2. The **agent** is a single `claude -p` with tools. It mounts the DS as a skill, the brand as an immutable pin, and
   writes the page section by section. Before finishing it requires green types, a build and screenshots at 1440 and
   375 px.
3. The **workspace** is a git repo: each message is a commit (version), variants are forks, and restore/undo are new
   commits.
4. The **preview** is a Vite dev server per workspace, reused across messages and served from a stable URL.

---

## Architecture

The system is **109 modules across 15 layers**, wired from four real entrypoints (`scripts/serve.ts`,
`apps/builder/src/main.tsx`, `templates/base-scaffold/src/main.tsx`, and the build scripts). Each layer's scope comes
from the import graph, not the folder tree.

| Layer | Modules | Responsibility | Key pieces |
|---|---|---|---|
| **client** | 24 | The builder: chat, canvas with artboards, versions, variants, approvals, direct editing. All turn state derives from the event log. | `apps/builder/src/lib/use-builder.ts`, `run-client.ts`, `artboard-canvas.tsx` |
| **edge** | 1 | Vercel serves the SPA with generic security headers. A same-origin deploy adds the `/api/*` proxy to the transport (with the origin secret) at deploy time; it is not committed. | `apps/builder/vercel.json`, `docs/notas/deploy-builder.md` |
| **api** | 11 | The transport HTTP router: `POST /runs` (turn, continue, restore, patch, direct edit, repair, variants), event stream, versions, uploads, canvas, connectors. | `src/runtime/server.ts` |
| **agent** | 21 | The `claude -p` agent: composer, loop, system prompt, stream translator, workspace MCP (typecheck, browser, image, vision), repairs, page plan, provenance. | `src/runtime/agent-composer.ts`, `agent-loop.ts`, `agent-prompt.ts` |
| **brand** | 4 | The thesis: brand pack over the DS contract, ephemeral identity + DESIGN.md, brand-aware skill, real facts. | `src/brand.ts`, `identity-ephemeral.ts`, `brand-skill.ts` |
| **runtime** | 7 | Workspace as a git repo, materialize/install/build, DS+skill+brand mount, child-process registry, direct edit over the AST. | `src/runtime/git-workspace.ts`, runtime in `server.ts`, `text-edit.ts` |
| **preview** | 10 | Vite dev-server pool (MAX_LIVE 4, heartbeat eviction), stable-URL listener per ws, preview-check with sensors, scaffold bridges. | `src/runtime/preview.ts`, `preview-serve.ts`, `templates/base-scaffold/src/wt-*` |
| **storage** | 3 | `dist/<commit>` snapshots per version, transport state root, DS registry in Vercel Blob (pinned). | `server.ts`, `registry-source.ts` |
| **auth** | 6 | Tool approvals, persistent "always", origin trust, per-run token, secret scrubbing toward children. | `src/runtime/approvals.ts`, auth in `server.ts` |
| **billing** | 3 | Spend caps (images per run, concurrency, model allowlist), per-turn time and usage. | `scripts/serve.ts`, `gateway-models.ts` |
| **observability** | 4 | Per-message event log (M-CONTRACT), raw logs, OTel traces (local Spotlight + remote OTLP), crash guard. | `src/runtime/events.ts`, `telemetry.ts` |
| **third-party** | 6 | Claude Code CLI (engine), Vercel AI Gateway, image providers, Pipedream Connect, Vercel Blob, facts source. | `src/runtime/infer.ts`, `connectors.ts` |
| **deploy** | 9 | DS skill build, registry publish, transport in Sandbox, CI, workspace persistence. | `scripts/build-ds-skill.ts`, `build-registry.ts` |
| **scaffold** | — | Each workspace's starter (Vite + React + TS over the base DS) and its bridges to the builder (selection, size, errors, reveal, `file:line:col` origin). | `templates/base-scaffold/` |
| **tooling** | — | Component catalog and contract, offline finding engine, bench/gates/measurement scripts. | `src/catalog/`, `scripts/` |

### Design principles the RE confirmed

- **Determinism over the AST instead of DOM patching.** Direct editing (text, image, delete, section ops, patch)
  locates the node in the TSX with the TypeScript AST and rewrites it without a model, running `tsc` on what it
  touched and committing. Type-safe and atomic.
- **Brand as an immutable pin.** Identity enters over the slots the DS publishes, validating contrast and DESIGN.md
  ↔ tokens coherence. It is not a mutable attach.
- **A multi-file Vite/React project instead of a self-contained HTML.** More powerful (components, types) at the cost
  of export and publish being by `dist/<commit>`, not by clipboard.
- **NDJSON with event sourcing instead of SSE + diffing.** Same semantic power, a simpler transport that resumes by
  cursor.

---

## Control flows

Eight control flows, verified live against the real transport:

| Flow | What it covers |
|---|---|
| **Plan → approve → build** | `POST /runs {mode: 'plan'}` → the agent writes only `.wt/plans/<id>.md` and ends with `exit_plan_mode` → a `plan` approval → approve or edit resumes the same session in build and creates the version; reject (with or without a note) creates none. See [`docs/spec/plan-mode.md`](docs/spec/plan-mode.md). |
| **Message → agent → build → version** | `POST /runs` → start → launch → the agent composes with `claude -p` → stream → materialize (install, vite build, commit, saveDist) → preview. |
| **Direct edit → AST → commit** | `POST /runs {textEdit\|deleteElement\|replaceImage\|sectionOp\|patch}` → `runDirectEdit` → AST → `tsc` on what changed → commit, no vite build. |
| **Follow-up with context** | Thread history, prior tools and the parent preview's defects enter as files in `.wt/context/`; past 4 turns the older ones fold into `summary.md`, and text the person dictated in quotes stays pinned. The agent starts a new CLI session. |
| **Repair on broken build** | Build errors → one resume with the error → the agent fixes it → build. Runtime and render repair run as their own runs. |
| **Variants** | `POST /runs {variants}` → fork the repo per variant → queue pumped by capacity → parallel under `maxRunning`. |
| **Tool / spend approval** | The CLI's `permission-prompt-tool` → `POST /approval-requests` (per-run token) → card in the builder → pass/deny/wait decision. |
| **Preview runtime context** | Console logs, network requests and the iframe's runtime errors travel to the agent on every turn with a model. |

---

## What it does well

Capabilities where onbrand is at parity with or ahead of the four references:

- **DS consumption by the agent** — immutable pin + allowlist + skill preloading. More robust than Lovable's attach.
- **Deterministic model-free editing** — text, delete and image replacement over the AST, with atomic commits.
  Beats Stitch, which patches the rendered HTML.
- **DESIGN.md ↔ tokens validation** — onbrand validates identity coherence; Stitch validates nothing.
- **Versions and savepoints** — one commit per version, restore and rewind over git.
- **Variants** — fork per variant, isolated per repo.
- **Deferred and spend approvals** — revocable, with persistent "always".
- **Plan before build** — the agent proposes `plan.md`, the person edits or approves it, and the lines the person wrote
  survive the build literally.
- **Resumable stream** — NDJSON with event sourcing and cursor resume; any tab catches up.
- **Broken-build repair** — automatic resume with the build error.

---

## Running locally

A clean clone runs with **bun** 1.4.4 and the **`claude` CLI** signed in, and nothing else: no accounts, API keys or
third-party services. Nothing in the repo pins the bun version (no `engines` or `packageManager` in `package.json`), so
match it yourself. That is the core, with no profile loaded (the default). The agent writes the page through
your Claude Code session, the design system is read from `registry/` inside the repo, and publishing exports to a local
folder.

### 1. Install

Install the `claude` CLI and sign in first: `curl -fsSL https://claude.ai/install.sh | bash` (or `npm install -g
@anthropic-ai/claude-code`), then run `claude` and follow the browser prompt
([setup docs](https://docs.anthropic.com/en/docs/claude-code/setup)).

Then three installs. `fixtures/relume-themed/` is only needed by the porter's tests and is not needed to run.

```bash
git clone https://github.com/karenrebecag/onbrand.git && cd onbrand
bun install
(cd templates/base-scaffold && bun install)
(cd apps/builder && bun install)
```

### 2. Start the transport (terminal 1)

```bash
bun scripts/serve.ts --agent
```

It serves the API on `127.0.0.1:5300` and the live previews on `localhost:5301`. It is ready when it prints
`transport en http://127.0.0.1:5300`. In core the builder origin defaults to `http://localhost:5173`, so no
`--builder-origin` is needed. `--agent` is already the default; it is written out so the command says what it runs.

### 3. Start the builder (terminal 2)

```bash
cd apps/builder
VITE_RUN_API=/api bun run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the transport (`WT_TRANSPORT_URL`, default
`http://127.0.0.1:5300`). Without `VITE_RUN_API` the builder replays a sample run and never calls the agent.

### Checking a clean clone

`bun scripts/e2e-core-clone.ts` clones the repo into an empty folder, runs the three installs, starts the core with a
minimal environment and checks that the DS mounts from `registry/` and that no distro host is reached. It calls no model.
`--turn` adds one real turn through `claude -p`, which spends tokens.

### Your brand

With no brand requested the page gets the neutral base in `brands/brand-pack/`. To use your own, copy
`brands/brand-pack-ejemplo/` and follow [`brands/README.md`](brands/README.md); `WT_BRAND_PACK=<folder>` makes it the
default for every run.

---

## Configuration

Every variable is listed, with its default, in [`.env.example`](.env.example). The config seam lives in
[`src/config.ts`](src/config.ts): the core sets the defaults, a distro's profile module can change them
(`WT_PROFILE_MODULE`), and an explicit variable always wins over both. An invalid value stops the server at startup
instead of failing mid-run.

| Variable | Core default |
|---|---|
| `WT_COMPOSE_PROVIDER` | `cli` |
| `WT_ENHANCER_PROVIDER` | `cli` |
| `WT_IMAGE_PROVIDER` | `none` |
| `WT_BRANDS_ROOT` | `brands/` |
| `WT_BUILDER_ORIGIN` | `http://localhost:5173` |
| `WT_PUBLISH_PROVIDER` | `local` (to `generated/v0-publish`) |

A distro (a separate repo that depends on onbrand) adds its own defaults and adapters (identity, sandbox, storage,
Gateway, facts, registry) through a profile module; the contract is in [`docs/profile-module.md`](docs/profile-module.md).

Main flags for `scripts/serve.ts`:

| Flag | What it does |
|---|---|
| `--agent` | Use the agent. It is the default unless `--fixture` or `--composer` is given. |
| `--port` | API port, 5300 by default (`WT_TRANSPORT_PORT`). |
| `--preview-port` | Live-preview port, API port + 1 by default (`WT_PREVIEW_PORT`). |
| `--root` | Where runs are stored, `generated/v0-transport` by default. |
| `--builder-origin` | Builder origin allowed to write. Overrides `WT_BUILDER_ORIGIN` and the profile default. |
| `--publish-dir` | Local publish folder in core (`WT_PUBLISH_DIR`). |
| `--brand` | Brand pack mounted in every workspace. |
| `--images` | Enable the image step. Does nothing in core, whose image provider is `none`. |
| `--product-image-only` | With `--images`, a single image per page. |
| `--fixture dir1,dir2` | Copies snapshot directories (one per turn, in order) into the agent workspace; no LLM or credits. |
| `--no-build`, `--no-preview-check` | Skip the build or the live-preview check. |
| `--registry`, `--facts <url>` | Need a distro profile (`WT_PROFILE_MODULE`); core exits with an error. |

Secrets (`PIPEDREAM_*`, `BLOB_*`, `VERCEL_*`, `AI_GATEWAY_*`, `WT_ORIGIN_SECRET`) are **not** inherited by child
processes (the agent CLI or vite).

---

## Tests

```bash
bun test
```

CI runs the same in `.github/workflows/ci.yml` on a self-hosted macOS runner (`[self-hosted, onbrand]`), with `bun install` in root, `templates/base-scaffold` and `apps/builder`. The
builder and the starter are typechecked with their `bun run build`. Flaky tests that depend on wall-clock timing are
kept in quarantine (`test.skip` with a `HACK:` marker and its re-enable trigger), not deleted.

---

## Contributing and releases

The workflow (git, branches, worktrees, how the CHANGELOG is updated, how a version is cut and published) lives in
[`docs/governance.md`](docs/governance.md). Capability changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).
Releases are published with a `vX.Y.Z` tag via
[`.github/workflows/release.yml`](.github/workflows/release.yml).

---

## Repo layout

```
apps/builder         builder UI (Vite/React SPA)
src/runtime          runtime: HTTP router, run cycle, agent, preview, image, direct edit, session
src/orchestrator     deploy orchestrator (ADR 0016): chat index, Gateway proxy, signed identity; not wired yet
src/                 engine: brand, catalog, DS skill, copy, sensors
scripts/             CLIs: serve, build-ds-skill, build-registry, catalog, bench
templates/           each workspace's starter + scaffold bridges
fixtures/            demo pages and briefs used by tests and --fixture
catalog/             component catalog, schemas and gates
tools/porter         ports library components to the DS
docs/                ADRs, specs and work programs
tests/               bun tests
```

### Map of src/runtime

`server.ts` (593 lines) keeps the **state** of the run cycle (`index`, `running`, `live`, `cancels`, `finished`,
`late`, `lateChecks`, `stopReasons`), its persistence (`save`, `updateEntry`) and the wiring; the cycle itself is a
collaborator like the rest. Collaborators get explicit deps and never import `server.ts`
([ADR 0014](docs/adr/0014-transport-colaboradores.md), Enmienda 1, has the rules and the owners).

```
server.ts         state of the cycle (index, running, live, cancels…), updateEntry/save, wiring, reads, handle/listen
run-cycle.ts         start, run, launch, release, settle (run token), cancel, steer, plan build resume, agent workspace
run-close.ts         how a turn becomes a version, a question, a plan or nothing: materialize, keepStopped, keepPlan, end, recover
run-checks.ts        leaf: preview and render checks, install with hash mark, baseOf/untouched, context usage
run-input.ts         leaf: the pure parsers of POST /runs
shared.ts  shared types (MessageEntry, RunInput…), workspace file names, stepAsync
thread-fold.ts       the follow-up thread past 4 turns: older ones fold into a summary
pinned.ts            text dictated in quotes that a follow-up must keep, and the pinned.lost sensor
agent-mcp.ts         workspace MCP (/mcp/:id), approvals, connector proxy, plan pending/decision
edit-runs.ts         model-free and repair runs: patch, direct edit, patch-ai, restore, continue, repairs
variants.ts          variant groups: queue, launch, cancel
brand-runs.ts        brand of the run, updateDs/applyBrand/applyTheme, remembered directions
run-reads.ts         GET reads: thread, versions, snapshot, stream, files, diff, export, publish
preview-dist.ts      stable preview url, preview proxy, heartbeat, dist snapshots
api-handlers.ts      enhancer, connectors, uploads, transcribe, canvas
brand-store.ts       brand ids, summaries, per-brand instructions
http.ts              HttpError, body parsing, origin checks
leaves               direct-edit, plan-edit, plan-exit, memory-edit, memory-tool, agent-loop, agent-prompt, …
```

---

## Architecture decisions

Decisions live in [`docs/adr`](docs/adr/README.md). The ones that define the current model:

- **[ADR 0011](docs/adr/0011-agente-escribe-como-v0.md)** — an agent writes the code over the DS, and the library
  blocks are *reference*, not a catalog to pick from. The current model.
- **[ADR 0012](docs/adr/0012-plan-de-pagina-como-artefacto.md)** — the agent writes a `page-plan.md` before the
  sections; shared by the composer, the sensors and the Plan panel.
- **[ADR 0013](docs/adr/0013-modelo-de-ejecucion.md)** — the execution model: workspace claim/release, single
  settled, `ok/stopped/failed/asked` outcome, recovery on startup.
- **[ADR 0014](docs/adr/0014-transport-colaboradores.md)** — `server.ts` splits into collaborators with explicit
  deps. Enmienda 1 (option A, decided by Karen) moved the run cycle out too: `run-checks.ts`, `run-close.ts`,
  `run-cycle.ts` and the run token (#612, #620, #627).
- **[ADR 0003](docs/adr/0003-brand-profile-determinista.md)** — the brand profile biases composition
  deterministically, not by model rewriting.

---

## Status and known limits

The core (agent + AST + versions + DS by pin) is at or above the references. What's missing is product maturity,
tracked as engineering gaps:

- **Publishing the generated app:** the core delivers an export package built from the version's commit (zip,
  site, page, local publish). Publishing to an external host belongs to the distribution, not the core (#656).
- **User identity:** the core has an owner per chat, scopes per route and scoped preview tokens (phases 0-4,
  `docs/spec/identidad-sesion.md`). The identity provider of a distro profile (phase 5) is not chosen yet, so the
  deploy still has no login.
- **Deploy with a Sandbox per chat (ADR 0016):** the index, the signed identity and the Gateway proxy are already in
  `src/orchestrator` as tested modules. They are not wired to routes or to the VM yet, and that waits for
  `@vercel/sandbox` and the decisions in `docs/spec/deploy-sandbox.md` §5.
- **Builder CSP:** enforced, with a test that ties `frame-src` to the preview origins (H4, #604, #651).

The full map of modules, flows and gaps (against v0, Lovable, Stitch and Figma Make) is team working material and
does not live in the repo.
