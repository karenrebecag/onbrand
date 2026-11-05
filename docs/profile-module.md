# Profile modules (`WT_PROFILE_MODULE`)

The core runs on a clean clone with bun and the `claude` CLI, with no accounts. A **distro** (a separate repo that depends
on onbrand) adds a profile: its own defaults and the adapters for the ports it wants to replace. The core knows no profile
by name; it loads one from `WT_PROFILE_MODULE` (a file path or a package name) before it reads its configuration
([`src/profile.ts`](../src/profile.ts), [ADR 0017](adr/0017-cableado-core-perfil.md)). Without the variable the core runs
as is, and `WT_PROFILE` only accepts `core`.

## Contract

The module exports `defaults` and/or `adapters` (and optionally `name`, never `core`):

```ts
export const name = 'my-distro';
export const defaults = { composeProvider: 'gateway', brandsRoot: '/path/to/packs' };   // partial over the core config
export function adapters(env) { return { authenticate, sandbox, blob, gateway, facts, registry }; }  // every port optional
```

- `defaults` takes the keys of [`src/config.ts`](../src/config.ts) except `profile`. An explicit environment variable
  always wins over the profile, and a value outside its enum stops the start.
- `adapters(env, role)` builds the ports; `role` is `'runtime'` (the VM of a chat, `scripts/serve.ts`) or `'orchestrator'`. Build only the ports of that role; any other port is dropped. An unknown port or one that does not meet its contract stops the start (exit 2):


| Port | What it is | Used by |
|---|---|---|
| `authenticate` | who the person behind a request is (`(Request) => Session \| Rejection`); default: any IdP through `WT_JWT_*` (`src/adapters/jwt`) | orchestrator |
| `sandbox` | the VM of a chat (`ensure`, `keepAlive`, `snapshot`, `stop`; [`sandbox.ts`](../src/orchestrator/sandbox.ts)); default: `localSandboxProvider`, loopback only | orchestrator |
| `catalog` | `{ models, imageModels, capabilities? }`: what `/models` and `/image-models` answer; served by the orchestrator without a VM, 404 without it | orchestrator |
| `connectors` | `{ apps(q, after), accounts(owner), connect(owner, app), disconnect(owner, id) }`: app accounts per owner; the orchestrator validates input and projects output; 501 without it | orchestrator |
| `blob` | the global index storage (`BlobClient`); on disk when the profile gives none | orchestrator |
| `gateway` | price, credential, upstream and `waitUntil` of the Gateway proxy; **required**, the core has no provider | orchestrator |
| `facts` | the brand facts source (`serve --facts <url>`); without it the flag is rejected | `scripts/serve.ts` |
| `registry` | `(pin?) => Promise<RegistrySource>`, the DS registry that replaces `registry/` (`serve --registry`); the resolved value is checked (`pin`, `loadIndex`, `getItem`, `makeSchemaStore`); without it the flag is rejected | `scripts/serve.ts` |
| `publish` | a `PublishProvider`; used when `publishProvider` is `profile` | `scripts/serve.ts` |
| `image` | `{ gen, edit?, models }`, the image generator and the models the builder offers; used when `imageProvider` is `profile` | `scripts/serve.ts` |
| `session` | a `SessionVerifier` for the VM; used when `sessionProvider` is `profile` | `scripts/serve.ts` |

`publishProvider`, `imageProvider` and `sessionProvider` take `profile` as a value: it selects the port above, and the start
fails (exit 2) if the profile does not provide it. The old `WT_IMAGE_PROVIDER=cli` / distro image MCP and
`publishProvider: 'vercel'` no longer exist.

## Running the orchestrator

`bun scripts/orchestrator.ts` needs a profile with `gateway`. Without `authenticate` it verifies sessions with `WT_JWT_ISSUER` plus
`WT_JWT_PUBLIC_KEY` or `WT_JWT_JWKS_URL` (any IdP); without `sandbox` it runs each chat as a local process, which does not isolate,
so it is refused outside loopback. It also needs:

| Variable | Meaning |
|---|---|
| `WT_ORCH_PRIVATE_KEY` | Ed25519 PEM of the orchestrator; the VM only receives the public key |
| `WT_OWNER_CAP_USD` | daily cap per owner in USD (default 5) |
| `WT_SANDBOX_DIR` | where the local VMs keep their state when the profile has no `sandbox` (default `generated/orchestrator-vms`) |
| `WT_BLOB_PREFIX` | prefix of everything it writes (default `wt/`) |
| `WT_BLOB_DIR` | directory of the on-disk store when the profile has no `blob` |
| `PORT` | default 5400 |
| `WT_ORCH_STREAM_MAX_MS` | streams (`events`, `prompt-enhancements`) are closed after this many ms so they end before the Function limit; the builder reconnects (default 270000) |
| `WT_ORCH_HOST` | listen address, default `127.0.0.1` |

A test profile lives in [`tests/fixtures/profile-ejemplo.ts`](../tests/fixtures/profile-ejemplo.ts). A real profile
(Clerk, Vercel Sandbox, Vercel Blob, Gateway, its brand packs and its deploy) belongs to the distro's repo, not here.

## Builder

The builder has no sign-in of its own. Its session is a seam in
[`apps/builder/src/lib/session-provider.ts`](../apps/builder/src/lib/session-provider.ts): every request to the API goes
through `apiFetch`, which asks the active provider for a token and sends it as `Authorization: Bearer <token>`.

```ts
interface SessionProvider {
  /** Current session token, or null without a session. Called on every request: the provider refreshes its own. */
  getToken(): Promise<string | null>
  /** The server rejected the session (401 `no-session`/`expired`, 403 `scope`). */
  onRejected(problem: SessionProblem): void
  /** Optional: with it, the builder can offer "sign out". */
  signOut?(): Promise<void>
  /** Optional: with it, the builder can show who is signed in. */
  user?(): { id: string; label?: string } | null
}
```

The core default, `localSessionProvider`, returns no token and ignores rejections, so local development works as before:
the runtime's local verifier accepts loopback requests without a session. The copy for a rejected session comes from
`sessionProblem` (`apps/builder/src/lib/session.ts`) in both cases.

A distro injects its provider from its own entry file, before it mounts the builder:

```ts
// apps/builder/src/lib/session-provider.ts, from the onbrand package pinned to a tag
import { setSessionProvider } from '<onbrand builder>/lib/session-provider'

setSessionProvider({
  getToken: () => auth.getToken(),
  onRejected: () => auth.openSignIn(),
  signOut: () => auth.signOut(),
  user: () => (auth.user ? { id: auth.user.id, label: auth.user.email } : null),
})
```

The provider is fixed once per build, like `WT_PROFILE_MODULE` on the server: a second `setSessionProvider` call throws.
When the provider implements `user()` or `signOut()`, the top bar menu shows the owner and "Cerrar sesión"; with the core default
that menu stays disabled. The identity SDK (and its sign-in UI around
the builder, if any) lives in the distro: nothing under `apps/builder` imports one (`tests/core-sin-terceros.test.ts`).
The builder never decodes the token; owner and scopes come from the server.

The builder also reads `GET /spend` from the orchestrator and shows the day's spend against
`WT_OWNER_CAP_USD` next to the turn's tokens. Without the orchestrator (`404`) it shows nothing; `VITE_SPEND_FIXTURE=1`
shows sample numbers for local screenshots only.

## Security

- `WT_PROFILE_MODULE` is a path or package fixed by whoever deploys; it is **never user input**. The module runs with the
  full privileges of the process that loads it.
- `adapters(env, role)` receives the **whole** environment, including `WT_ORCH_PRIVATE_KEY`. A profile is trusted code; read only
  the variables it needs and never log the environment.
- The local sandbox (`localSandboxProvider`) gives each VM a short allow-list of variables, not the environment of the
  orchestrator, and starts it with `bun --no-env-file`. A profile that needs to hand a variable to the VM names it in
  `passEnv`. `WT_PROFILE_MODULE` is not in the allow-list: the VM does not load the profile (so none of its orchestrator code runs next to the agent's) unless the profile names it in `passEnv`; then the VM loads it with `role: 'runtime'`.
- `WT_ORCH_HOST` defaults to `127.0.0.1`; expose the orchestrator only behind your own TLS and authentication.

## What reaches the VM

- The profile's `defaults` do **not** reach the VM. A VM that does not load the module uses the core defaults plus the `WT_*`
  variables it inherits. What the VM needs (for example images through the gateway) travels as an explicit variable in the env
  the `SandboxProvider` hands to `ensure` (`WT_IMAGE_PROVIDER=gateway`), or you pass the module itself with `passEnv`.
- With `WT_PROFILE_MODULE` in `passEnv` the role filter only covers the body of `adapters()`; top-level imports are evaluated in
  the VM next to the agent's code. Import the SDKs of orchestrator ports with `await import()` inside the
  `role === 'orchestrator'` branch (and inside the function that uses them), never at the top of the file.
  [`tests/fixtures/profile-ejemplo.ts`](../tests/fixtures/profile-ejemplo.ts) shows it. The signature of `adapters` does not change.
- Do not expose the local orchestrator through a tunnel or reverse proxy: `localSandboxProvider` starts processes on the host
  without isolation and is for development only. Outside loopback, give the profile a real `sandbox` port.
- The blob prefix comes only from `WT_BLOB_PREFIX` (default `wt/`), never from the profile name; a profile `blob` port is
  wrapped by that prefix too.
