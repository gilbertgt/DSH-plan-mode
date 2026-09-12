# Secure Release Pipeline Plan

Issue: #2

## Goal

Make the public GitHub repository and public npm package safe to release by default. The release system must fail closed: if the exact package cannot be proven safe, complete, reproducible enough for the configured inputs, and traceable to the intended Git tag, it must not be published.

This plan deliberately optimizes GitHub Actions usage. Security gates remain mandatory, but the same expensive validation should not be repeated across PR, Windows, Node-version, and release lanes unless that repetition catches a distinct class of failure.

## Release contract

Every npm release must satisfy all of the following:

1. The release source is a Git tag on a trusted repository commit.
2. `vX.Y.Z` tag and `package.json` version are identical.
3. A committed `package-lock.json` exists before any release packaging is allowed.
4. Release dependency installation uses `npm ci --ignore-scripts`.
5. Tests, type checking, supported-DSH compatibility, and release build pass.
6. Build starts from a clean `lib/` output directory.
7. `npm pack` contents are validated with a strict fail-closed allowlist.
8. Unexpected files are rejected rather than silently published.
9. Built output and the actual packed tarball are scanned for high-confidence credentials, private keys, authentication headers, and local-user paths.
10. The exact `.tgz` that passes verification is the artifact used for publishing; no rebuild or repack occurs after verification.
11. The tarball receives a SHA-256 digest recorded in a release manifest.
12. A clean package-install smoke test passes before staging/publishing.
13. Normal automated publishing uses npm Trusted Publishing via OIDC, not a long-lived npm write token.
14. Post-bootstrap releases use npm staged publishing so a human with 2FA must approve before a version becomes public.
15. The initial package bootstrap is separate because staged publishing requires an existing npm package.
16. Unknown, malformed, unsupported, or unverifiable states fail closed.

## Threat model

The release pipeline must protect against:

- accidental inclusion of `.env`, `.npmrc`, credentials, logs, source maps, test fixtures, artifacts, or local configuration;
- hard-coded secrets accidentally bundled into `lib/*.js`;
- local paths such as `C:\\Users\\<name>\\...`, `/Users/<name>/...`, or `/home/<name>/...` leaking into published output;
- a stale or wrong version being published from the wrong tag;
- publishing an unbuilt package from a fresh clone;
- publishing a tarball different from the one that was reviewed;
- compromised or leaked long-lived npm automation tokens;
- unnecessary Actions consumption caused by duplicate validation.

This project does not attempt to hide source code. The repository and npm package are intentionally public.

## Design

### 1. Package manifest policy

Keep `package.json#files` as the first allowlist. Add a second independent verifier that inspects npm's actual pack manifest.

Allowed package paths:

- `package.json`
- `README.md`
- `LICENSE`
- `compatibility.json`
- `cordis.patch.yml`
- `profiles/worker.cordis.yml`
- `profiles/reviewer.cordis.yml`
- `lib/*.js` at one directory level only

Everything else is rejected. In particular, reject source maps, source files, tests, scripts, CI files, archives, logs, `.env*`, `.npmrc`, key/certificate files, coverage, and local artifacts.

### 2. Sensitive-data scanner

Scan both build output and the extracted final tarball.

Use high-confidence patterns rather than blocking generic words such as `token`, `password`, or `secret` in normal source text. At minimum detect:

- PEM/private-key headers;
- GitHub classic/fine-grained token prefixes;
- npm token prefixes;
- AWS access-key style identifiers;
- authorization/bearer headers carrying long credential-like values;
- obvious secret assignments with long entropy-like values;
- Windows/macOS/Linux user-home absolute paths.

Scanner failures, unreadable files, or unsupported package entries fail closed.

### 3. Pack verification

Upgrade `scripts/pack-check.mjs` so it:

- uses `npm pack --dry-run --json --ignore-scripts`;
- verifies required files;
- rejects every file outside the strict allowlist;
- validates package name and a syntactically valid version without hard-coding `1.0.0`;
- scans the exact on-disk files npm says it would package.

### 4. Exact release artifact

Add a release packer/verifier that:

1. requires `package-lock.json`;
2. validates tag/version/repository state when running as a release;
3. performs a clean build;
4. runs package manifest checks;
5. creates the real `.tgz` once;
6. validates tar entries before extraction;
7. extracts to a temporary directory;
8. reruns manifest and sensitive-data checks on extracted package contents;
9. records SHA-256 and metadata in `.artifacts/release-manifest.json`;
10. performs a clean-install smoke test against that same `.tgz`;
11. never rebuilds or repacks afterward.

### 5. npm lifecycle safety

A fresh clone must not be able to publish stale/missing `lib` output accidentally.

Use lifecycle scripts only as local safety nets. The authoritative release path remains the release workflow.

- `prepack`: build from a clean output directory.
- `prepublishOnly`: run release-safe package verification and refuse unsafe/unprepared state.
- dedicated `release:*` scripts: explicit verification/packing commands for CI and maintainers.

Avoid lifecycle recursion: release scripts that intentionally create the final tarball must use `--ignore-scripts` after the build has already been verified.

### 6. Dependency determinism

A committed `package-lock.json` is required before release.

Once the lockfile is present:

- CI/release installs use `npm ci --ignore-scripts`;
- release jobs do not run `npm update` or `npm audit fix`;
- dependency changes happen in reviewed PRs, not during release.

Because the current repository has no lockfile and this implementation environment cannot resolve npm registry dependencies, this PR must add a release guard that blocks packaging until the lockfile is committed. Do not spend a temporary Actions workflow solely to generate it. The first normal dependency install by the maintainer/worker should generate and commit it; then PR CI should be switched from `npm install` to `npm ci`.

### 7. CI budget policy

Keep PR CI focused on unique failure modes:

- Ubuntu Node 22: authoritative unit/integration/typecheck/build/package-layout/DSH rc.1 lane.
- Windows: keep only Windows-specific platform/package behavior that Linux cannot prove; avoid repeating typecheck and package-policy checks already enforced on Ubuntu.
- Node 24: keep lightweight dependency-free platform tests only.
- DSH rc.2 preview: manual and non-blocking until promoted.

Do not run the full tarball release pipeline on every PR. The final tarball, clean-install smoke test, SHA-256 manifest, provenance/staging path, and npm CLI upgrade belong to release-tag runs only.

### 8. Release workflow

Add a separate `.github/workflows/release.yml` rather than mixing publishing into `ci.yml`.

Trigger only on version tags (`v*`) so normal pushes do not consume release CI.

Use minimum permissions:

- `contents: read`
- `id-token: write` only for npm OIDC Trusted Publishing

Release flow:

1. clean checkout;
2. Node 22.19+ setup;
3. require committed lockfile;
4. `npm ci --ignore-scripts`;
5. run core release verification;
6. create and verify the exact `.tgz`;
7. upload the `.tgz` + release manifest as a GitHub Actions artifact;
8. if staged publishing is explicitly enabled for the repository/package, install an npm CLI version supporting `npm stage publish` and stage that exact `.tgz` via OIDC;
9. otherwise stop safely after producing the verified artifact.

The workflow must never silently fall back from staging to direct `npm publish`.

### 9. Bootstrap versus normal releases

Initial package creation is special.

For the first npm release:

- run the full tag release workflow in verification/artifact mode;
- download the exact verified `.tgz` artifact;
- publish that exact tarball once with maintainer 2FA and `--access public`;
- configure npm Trusted Publisher for `release.yml`;
- configure the trusted publisher for stage-only operation;
- configure package publishing access to require 2FA and disallow traditional tokens where supported;
- enable staged release mode for subsequent versions.

All later versions:

- tag -> release workflow -> `npm stage publish <verified.tgz>` via OIDC -> maintainer reviews staged package -> 2FA approval.

### 10. Public-repository security

Before changing repository visibility to public:

- scan the complete Git history for secrets, including deleted historical files;
- revoke/rotate any real credential found before history cleanup;
- enable GitHub Secret Scanning and Push Protection when available;
- enable Dependabot alerts;
- protect `main` with required PR + required CI and block force-push/delete;
- add `SECURITY.md` explaining how to report sensitive vulnerabilities without posting secrets publicly.

CodeQL is recommended, but it should not be added merely to increase CI volume. Enable it if its security value for this TypeScript/JavaScript codebase justifies the additional Actions consumption.

## Files to change

Expected implementation surface:

- `Plan.md` — this plan.
- `package.json` — lifecycle/release scripts and safe publish metadata.
- `scripts/release-policy.mjs` — shared allowlist + scanner + validation primitives.
- `scripts/pack-check.mjs` — strict dry-run package firewall.
- `scripts/release-pack.mjs` — exact tarball creation, extraction verification, digest, smoke test.
- `scripts/release-source-check.mjs` — tag/version/repository/lockfile release-source checks.
- `test/unit/release-policy.test.mjs` — policy/scanner regression tests.
- `.github/workflows/ci.yml` — reduce redundant checks while retaining distinct platform coverage.
- `.github/workflows/release.yml` — low-frequency, least-privilege release pipeline.
- `SECURITY.md` — public vulnerability-reporting and secret-handling policy.
- `package-lock.json` — required follow-up generated by a normal dependency install before any release is allowed.

## Acceptance tests

The implementation is not complete unless tests demonstrate at least:

- valid current package layout passes;
- an unexpected file fails;
- `.map`, `.env`, `.npmrc`, key material, and archive-like additions fail;
- private-key content fails;
- GitHub/npm/AWS-style credential content fails;
- Windows/macOS/Linux local-user paths fail;
- harmless occurrences of generic words such as `tokenBudget` do not fail;
- version is no longer hard-coded to `1.0.0`;
- missing `package-lock.json` blocks release packaging;
- tag/version mismatch blocks release;
- malformed tar entries or unexpected extracted files block release;
- release manifest records the tarball SHA-256;
- no release path rebuilds after the verified tarball has been created.

## Merge gate

Before merging this implementation PR:

1. review the complete diff independently from the implementation pass;
2. confirm the release workflow cannot directly publish when configured for staging;
3. confirm missing lockfile prevents release rather than weakening validation;
4. confirm PR CI is not materially more expensive than the existing workflow and redundant checks were removed where safe;
5. require existing CI to pass;
6. merge only if review has no unresolved blocker/high-severity finding.
