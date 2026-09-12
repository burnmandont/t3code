# Sovereign upstream maintenance

Sovereign is a long-lived downstream of `pingdotgg/t3code`. The maintenance
goal is to preserve upstream product behavior while retaining only deliberate
Sovereign ownership: identity, relay and connection routing, distribution,
deployment, observability, branding, and the workflow behavior we explicitly
require.

An ahead/behind count is a signal to inspect, not a reason to deploy. Import an
upstream boundary when it contains a security or provider compatibility fix,
when a desired product change justifies the validation cost, or as part of a
planned maintenance cadence.

## The durable model

Sovereign is one source tree and one product build. The "Sovereign overlay" is
an architectural ownership boundary, not a runtime step that copies files over
T3 Code and not a feature toggle applied after compilation.

Upstream owns the coding product. Sovereign adds narrow adapters and additive
infrastructure around it. On an update, Git imports upstream history once and
maintainers resolve only the semantic overlap between those ownership areas.
We do not manually cherry-pick every missing upstream commit, and we do not
accept unrelated downstream divergence merely because it already exists.

The deployed branch is append-only. Never rebase or force-push a commit from
which a signed runtime or client was published. Runtime versions contain the
source commit, artifacts are immutable, and reliable rollback depends on old
commit hashes retaining their meaning.

## Branch roles

- `upstream/main` is fetch-only. Its push URL remains disabled.
- `sovereign/main` is the canonical deployed production line.
- `upstream-sync/<target>` is a disposable integration branch created from the
  current `origin/sovereign/main`.
- A short-lived `sovereign/next-<upstream-sha>` branch may be used for a major
  reconstruction, but it does not become production until the same validation
  and promotion rules have been satisfied.

Use one explicit merge commit to import an upstream target. That keeps both
provenance lines auditable and advances `sovereign/main` without rewriting any
published history.

## Sovereign ownership layers

The historical phrase "eight to ten Sovereign patches" describes these
coherent ownership layers. It is not a promise that production history will
contain exactly that many Git commits. Fixes found during validation may remain
as small follow-up commits; do not rewrite deployed history to make the count
look tidy.

1. **Connection routing** — multiple routes for one environment, runtime route
   selection, reconnect behavior, and consistent environment identity.
2. **Port forwarding** — desktop runtime-only TCP forwards and their lifecycle
   and presentation.
3. **Required product UX** — copy behavior, filesystem browsing, terminal and
   dotfile behavior, chat/sidebar behavior, optional legacy presentation, and
   other explicitly adopted workflow changes.
4. **Streaming and performance** — bounded/coalesced live updates with the
   chosen defaults and no unbounded render, memory, or disk work.
5. **Portable relay boundary** — control-plane discovery, provider-neutral
   contracts, relay ownership checks, and compatibility across web, desktop,
   mobile, and server.
6. **Sovereign identity and relay** — configured OIDC/OAuth instead of Clerk,
   operator-controlled FRP relay instead of Cloudflare, account switching,
   linking, transfer, revocation, and migration compatibility.
7. **Deployment and distribution** — installed service behavior, canonical
   runtime paths, update-in-place, immutable signed artifacts, publication,
   health checks, and rollback.
8. **Operations and observability** — proxy policy, PostgreSQL migrations and
   backup, telemetry, monitoring, resource visibility, and incident hardening.
9. **Sovereign identity of the product** — name, artwork, icons, bundle and URL
   protocols, CLI presentation, and release-channel metadata.

Prefer additive modules under `infra/account/`, `infra/sovereign/`, and
Sovereign-specific adapters. Keep edits thin in shared entry points, contracts,
desktop lifecycle/IPC, mobile configuration, and the web connection UI. When a
shared hotspot becomes difficult to integrate twice, extract the Sovereign
behavior behind an interface before the next import.

Generic improvements should be proposed upstream. Once upstream contains an
equivalent implementation, remove the downstream version during the next
import rather than preserving both.

## Non-negotiable invariants

Reject an upstream import, even if it compiles, when it violates any of these:

1. Sovereign artifacts do not contain or require Clerk, Cloudflare, or another
   unapproved hosted control-plane implementation.
2. Public runtimes remain control-plane neutral. Private operator URLs and
   credentials appear only in the intended configured artifacts.
3. OAuth uses the configured issuer and resource, PKCE, and the established
   secure-storage boundaries on every applicable client.
4. Relay operations are scoped to the authenticated owner. Sign-out, account
   switching, unlink, transfer, forget, and revocation have distinct and
   correct semantics.
5. One environment may retain multiple connection routes without duplicating
   its projects or threads. Disconnect is temporary; forget removes the saved
   environment; server-side revocation terminates authority.
6. FRPC reaches the operator FRPS deployment through the authenticated public
   boundary while private FRP ports remain private.
7. Service installation and update-in-place preserve environment identity,
   state, secrets, runtime paths, and a usable previous signed version.
8. Web, desktop, mobile, and the previous supported client/server generation
   remain compatible through the rollout window.
9. Sovereign branding is complete in installed applications, update prompts,
   protocols, generated native projects, icons, and build artifacts.
10. Database migrations remain forward-compatible. Never renumber, rewrite, or
    delete a migration that may have run in production.
11. Telemetry, backups, and resource monitoring remain bounded. Do not claim an
    operational incident is solved unless the relevant source and production
    evidence directly support that conclusion.

## Selecting an upstream target

Fetch before every decision; cached refs are not evidence:

```bash
git fetch --prune --tags upstream
git rev-list --left-right --count origin/sovereign/main...upstream/main
git merge-base origin/sovereign/main upstream/main
```

Prefer a stable upstream tag or another exact, reviewed SHA over chasing every
commit on `main`. Import urgent security and provider-protocol fixes promptly.
A narrowly required unreleased fix may be cherry-picked with `-x`, recorded as
temporary, and removed when the containing upstream boundary is later merged.

For the selected range:

- read every authentication, relay, provider protocol, migration, native
  mobile, desktop lifecycle, update, and contract change;
- group ordinary product changes into coherent validation batches even though
  they enter history through one upstream merge;
- compare patches and resulting content, not ancestry alone (`git cherry`,
  `git patch-id`, `git range-diff`, and direct file comparison are useful);
- identify downstream fixes now implemented upstream so they are not retained
  twice;
- record exact target and merge-base SHAs in the integration notes.

## Integration procedure

### 1. Establish a recoverable baseline

Require a clean tree, green production CI at the current Sovereign head,
healthy account/relay/web/FRPS/monitor/database resources, current backups, no
active deployment, and the current versions of production and the intended
canary environment.

Do not update clients, services, dependencies, or production merely to prepare
the audit.

### 2. Create one disposable branch

```bash
git fetch --prune --tags origin upstream
git switch -c upstream-sync/<target> origin/sovereign/main
git merge --no-ff --no-commit <exact-upstream-target>
```

Never resolve the repository wholesale with `--ours` or `--theirs`.

### 3. Resolve by ownership

- Ordinary product behavior follows upstream.
- Sovereign-specific infrastructure and adapter boundaries retain Sovereign
  behavior while adopting compatible upstream contracts.
- Shared contracts are reviewed across server, web, desktop, and mobile.
- Identity and relay behavior is compared semantically; a clean textual merge
  is not proof that ownership, migration, or reconnect behavior is correct.
- Dependency manifests are reconciled intentionally. Regenerate the lockfile
  with the repository-pinned package manager; never hand-edit lockfile conflict
  markers.
- Regenerate generated routes, native projects, workspaces, icons, and config
  from their sources.
- Add a new compatibility migration when required; do not rewrite deployed
  migrations.
- Remove obsolete downstream implementations when upstream supplies an
  equivalent change.

Commit one auditable import:

```text
merge(upstream): integrate <target> at <full-upstream-sha>
```

Small fixes discovered by validation may follow on the same disposable branch.

### 4. Validate without production credentials

The `.gitea/workflows/sovereign-ci-deploy.yml` workflow is a production workflow:
it signs, publishes, and deploys, and it is triggered from `sovereign/main`.
**Do not manually dispatch it from an integration branch as a substitute for
validation.** The credential-free `.gitea/workflows/sovereign-pr.yml` workflow
runs for pull requests into `sovereign/main` and direct pushes to
`upstream-sync/**`. Imported code must not run with signing, registry, GitHub
publication, Coolify, or production database credentials before promotion.

`infra/sovereign/ci/test-fork-invariants.mjs` is the executable catalog of
downstream ownership. It names and runs focused behavioral tests for each
Sovereign feature layer, so deleting or renaming a fork-owned test during an
upstream merge fails before the broad package suites run. Add a focused test to
that catalog whenever Sovereign adopts another durable product opinion.

Validation covers:

- focused tests for every changed server, relay, account, contract, web,
  desktop, and mobile behavior;
- web, server, desktop, and generated iOS build closure;
- absence of Clerk, Cloudflare, private operator credentials, and private
  endpoints from artifacts where they are forbidden;
- OAuth login/callback/sign-out/account switching and retained environment
  ownership;
- local, direct/SSH, and relay routes for the same environment;
- disconnect, reconnect, forget, revoke, transfer, and offline behavior;
- thread/history ordering and compatibility across environment reconnects;
- runtime-only port forwarding creation, failure, stop, and app-quit cleanup;
- preservation of the typed forwarding transport-adapter boundary and bounded
  `primary`/`direct`/`relay`/`ssh` desktop telemetry; rerun identical untouched
  versus integrated desktop-listener latency, 16-way fan-out, and bulk-transfer
  benchmarks when upstream changes forwarding, authorization IPC, connection
  routing, WebSocket handling, or desktop observability;
- SSH environment setup retains both the T3 HTTP `-L` listener and the private
  loopback SOCKS `-D` listener; an SSH-prepared forward selects
  `ssh-direct-tcpip-v1`, bypasses ticket/WebSocket/server-bridge work, restricts
  its destination to remote loopback, and closes on route-generation changes;
- terminal sustained-output behavior, including the invariant that each PTY
  callback performs work proportional to new output rather than repeatedly
  splitting or joining the full retained history;
- service install, update-in-place, restart, state preservation, and exact
  rollback;
- database migrations against a production-shaped snapshot and backup/restore
  compatibility;
- observability, resource telemetry, and disk-I/O bounds affected by the range;
- the server-runtime source allowlist still covers every server bundle input
  while excluding client-only trees, and Gitea, Docker, and Apple builders
  derive and inject the same content identity before release-version rewrites;
- new web/desktop/mobile against new server, previous clients against new
  server, and new clients against the previous supported server.

Use real seeded data and a non-production state directory. Never point a test
server at live `~/.t3/userdata`.

### 5. Promote the exact tested commit

After review and credential-free validation, advance production only by
fast-forwarding `sovereign/main` to the tested integration commit. Do not create
a different production commit after testing and do not force-push.

The production workflow then builds and publishes artifacts for that exact
commit and updates the control plane. A production workflow that publishes one
source SHA and deploys another has failed the release boundary.

### 6. Canary and roll out

After production CI and public-boundary verification are green:

1. install the exact new signed runtime on one non-critical linked environment;
2. test OAuth discovery, SSH and relay routing, a provider turn, terminal,
   filesystem behavior, port forwarding, reconnect, service restart, thread
   recovery, disconnect/forget separation, revocation, and relink;
3. observe resource, relay, error, and disk telemetry through the agreed window;
4. update remaining environments in controlled batches;
5. retain the previous exact runtime and last-known-good control-plane
   deployment until the observation window closes.

Client rollout should remain compatible with both the new and previous server
generation so desktop and mobile updates do not require a single simultaneous
cutover.

## Rollback

Never rewrite the deployed branch to remove a bad import.

- Before promotion, fix or abandon the disposable integration branch.
- After promotion, revert the upstream merge in a new commit and let normal CI
  produce a new signed release.
- For immediate mitigation, pin remote environments to the previous exact
  signed runtime and use the last-known-good control-plane deployment.
- Do not roll a database schema backward destructively. Restore compatibility
  in forward code, or use the separately rehearsed database recovery plan when
  data recovery is actually required.

Record the failed target, affected invariant, rollback version, and any
temporary compatibility patch required by the next attempt.

## After every import

1. Recompute ahead/behind and merge-base information from freshly fetched refs.
2. Review newly overlapping files and extract Sovereign behavior from recurring
   shared hotspots.
3. Propose generic downstream improvements upstream.
4. Remove downstream patches that upstream now supplies equivalently.
5. Update this ownership map and compatibility matrix when product decisions
   change.

The objective is not the smallest textual diff at any cost. It is the smallest
explicit semantic boundary that preserves the complete Sovereign product while
letting upstream continue to own everything else.
