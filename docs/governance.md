# Governance

The repo's working rules: git, branches, worktrees, changelog and releases. They are the team's and the program
orchestrator's contract. Changes to this document go through a PR like any other.

**Language:** repo-facing text (README, CHANGELOG, docs, release notes, branch and tag names, PR titles) is in
**English** from now on. Internal code comments may stay as they are.

## 1. Git

- **main is sacred.** Never push directly to main. Every change enters through a PR.
- **One branch per change**, named `<type>/<slug>` (`feat/`, `fix/`, `perf/`, `chore/`, `docs/`, `refactor/`,
  `ci/`). The type matches the commit's.
- **Commits:** `type(scope): description`. The message explains the **why**, not the what. One change per commit.
- **Merge = squash**, with `gh pr merge --squash --delete-branch`. The squash deletes the remote and local branch,
  which is what keeps dead branches from piling up (the squash changes the SHA, so git never sees them "merged").
- **Small PRs:** if a plan goes past ~5 files, split it into several PRs.
- **Rebase before merging a stack:** after each squash to main, the next PR in the stack rebases (`git merge
  origin/main`) so its CI re-runs and insertion clashes resolve.

## 2. Worktrees

- **One worktree per active task**, under a known folder; never in the scratchpad of a session that will close.
- **Worktree name = branch name** without the type (`wt-<slug>`).
- **Removed when the task closes:** `git worktree remove`. An abandoned worktree blocks checking out its branch.
- Before removing a worktree, verify it has no uncommitted changes or unpushed commits; if it does, pin its HEAD
  with a `keep/<slug>` ref before removing it.

## 3. Changelog

- Lives in [`CHANGELOG.md`](../CHANGELOG.md), Keep a Changelog format, semantic versioning.
- Records **product decisions and capability changes**, not every commit.
- **When to update it** (in the same PR that makes the change):
  - A PR that **changes what the product does** or **adds/removes a capability** → `Added`/`Changed`/`Removed`/
    `Fixed` under `[Unreleased]`.
  - An **architecture decision with a why** → also an ADR in `docs/adr/`.
  - A purely internal change (refactor, test, lint, formatting) does **not** go in the changelog.
- **SemVer:** MAJOR breaks a contract (transport API, event format, block contract), MINOR adds a compatible
  capability, PATCH fixes without changing a contract.

## 4. Releases

A release packages a version and publishes a GitHub Release. It is triggered by a `vX.Y.Z` **tag**.

1. **Cut the version (in a PR):** rename the changelog's `[Unreleased]` to `[X.Y.Z] — title — YYYY-MM-DD`, open an
   empty `[Unreleased]`, and update the compare links at the bottom. Cutting a version and approving it is the repo
   owner's decision; a session does not do it on its own.
2. **Tag:** `git tag vX.Y.Z && git push origin vX.Y.Z` on the main commit with the changelog already cut.
3. **The workflow** [`release.yml`](../.github/workflows/release.yml) runs on the tag:
   - extracts that version's section from the changelog as the notes,
   - creates the GitHub Release (GitHub attaches the tag's source),
   - builds and attaches the DS skill package **if a vault is configured** (`WT_VAULT_ROOT`); otherwise it skips it
     and notes so.
4. **The DS registry → Blob is manual** (`scripts/build-registry.ts`, a distro script since the alpha; deploy with the Vercel CLI): it needs the Blob
   secrets and is an owner deploy action, not CI. The core publishes nothing to Blob.

## 5. Packages and artifacts

- **DS skill** (`scripts/build-ds-skill.ts --mode agent`, which ships with the distro since the alpha; the core's `base-agent` skill lives in `templates/base-scaffold/skill/`): the package the composer agent reads. Deterministic from
  the catalog + the vault. Attached to the release when the vault is available.
- **DS registry** (`scripts/build-registry.ts`, which ships with the distro since the alpha): published to the private Vercel Blob, pinned (`index@sha`). It is a
  deploy publish, manual and with the owner's OK. The core has no Blob step: it builds its base registry with `scripts/build-base-registry.ts`.
- onbrand **does not publish an npm package**: it is an app, not a library. If that changes, add the publish job and
  define the package here first.

## 6. Program orchestration

- There is **one orchestrator** of git and the program. It is the only one that merges to main and the one that
  keeps the index, the CHANGELOG and this document.
- **It does not launder authorization:** spending credits and outward actions (deploy, publish, delete, install
  deps) need the owner's OK **in the session that runs them**; an orchestrator relay does not count.
- **It does not force service gates.** If something is blocked, it is reported, not worked around.
- It reads the code a session calls "green" before taking it as good.
- Code standards (module rules, change rules, guards) live in [`docs/estandares.md`](estandares.md); a rule without
  provenance does not enter, and every structural rule has an executable guard.

## 7. Flaky tests

- A test that fails twice without its code being touched goes to **quarantine** (`test.skip` with a `HACK:` marker
  and its re-enable trigger), not deleted. It is re-enabled once stabilized (deterministic clock/timers).
- No wall-clock assertions: they are unstable in CI under load.
