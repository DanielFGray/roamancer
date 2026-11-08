# Continuous deployment

## Goal

A push to an app's `main` branch releases that commit, and the operator runs no command. The platform builds the commit, runs its tests, and releases it only when they pass. The release waits for the new container's health checks, and Nomad reverts a release that fails them.

This record is the first phase of `pr-previews.md`: its "Merge to deploy" path, without previews and without the GitHub App. It uses that record's terms (image key, ref, reconcile, site policy) and holds only what an unattended release adds. Decisions marked **open** wait for the operator.

## Decisions

### Trigger: a timer reads `main`

The runner's timer reads the `main` commit of each watched repository with `git ls-remote`, once a minute, and runs reconcile for each app whose `main` changed. This needs no public route and no GitHub App, so it does not wait for the public access work. A webhook can come later and run the same reconcile sooner. It changes no decision here.

### Reconcile acts on a change of `main`

Reconcile releases `main` when its tree differs from the last tree that reconcile released or tried for that app. It does not compare `main` with `live`. So:

- After `ops rollback`, `live` stays on the rolled-back release until `main` changes again. The next push, usually the fix, releases normally.
- A build or test that fails is not tried again on each timer run. The next push tries again.

An app with `deploy = "manual"` in the site policy is never released by reconcile; `ops release` still works for it.

### Fetch

The host reads each watched repository with a read-only deploy key for that repository. Reconcile exports `main`'s tree with `git archive` and builds from that tree. `pr-previews.md` already requires a build from an exported tree, because the host has no checkout.

### Build user

Today `nodeBuild` (`Builder.ts`) runs an app's Dockerfile with rootless Podman as the operator, over ssh from the workstation. An unattended build runs code from anyone who can push to `main`. So it runs as a dedicated `builder` user with its own rootless Podman. That user is not `alchemy`, which holds the deploy token, and not the operator, whose shell can reach sudo. It holds only the registry client certificate. The reconcile job gives it the exported tree and reads back the digest.

### Check: tests in the image build (open)

Recommended: the app's Dockerfile runs its tests in a build stage. A failing test fails the build, so reconcile releases nothing and records the failure. This adds no mechanism, and `ops release` runs the same check. A test that needs Postgres or Valkey starts its own server in that stage, or moves to the other option.

The other option: reconcile releases a commit only after its GitHub commit checks pass. The tests then run on GitHub, and a release waits for GitHub and needs a token that can read check status.

### Token: a standing deploy token (open)

A job today uses the token that `ops login` mints from the root token, for 10 hours. A push at night would fail with "run ops login". Options:

- Recommended: a periodic OpenBao token for reconcile jobs, which the runner renews before it expires. The operator creates it once from the root token. Its policies cover what an app deploy does (the app's KV paths, database roles, object store keys and Nomad jobs), not the platform stacks. So it can change any app, but it cannot change a platform service or mint other tokens. Platform deploys still need `ops login`.
- Keep `ops login` only. Pushes deploy only during the 10 hours after a login.

### Approval

Today the workstation shows each plan and asks before it submits the deploy (`host-owned-staged-runner.md`). Under continuous deployment, a push to `main` is the approval, as `staged-releases.md` already says for a merge. So anyone who can push to `main` releases to production, and that includes an agent that holds the operator's GitHub token. An app that needs a person to approve each release sets `deploy = "manual"`.

### Revision lock

`ops` compares the workstation's `tools/alchemy` with the runner's revision because the runner reads what `ops` sends. Reconcile starts on the host and receives nothing from the workstation, so it skips that check. A platform commit then stops only the workstation's `ops` commands until the next rebuild, not releases started by a push.

### Records

Each release goes into the deployment record as an `ops release` does, with its commit. A failed build, test or deploy is a failed job in `ops dash`, with its log.

## Build order

1. Tag images by tree hash, and release an existing image by its key (step 1 of `pr-previews.md`).
2. The `builder` user, and a host-side build from an exported tree.
3. Reconcile of `live` for one app, run by `ops reconcile <app>` and by the timer, with `deploy` in the site policy.
4. The standing deploy token.

The previews of `pr-previews.md` (its steps 2 to 6) come after these.
