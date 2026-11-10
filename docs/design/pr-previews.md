# Pull request previews

## Goal

You choose a pull request (PR) on an app repository, and the platform runs it at a tailnet-only preview address beside the live release. The preview follows new pushes, gets removed when the PR closes, and a merge into `main` deploys the merged code. When the merged code is the code the preview ran, the deploy reuses the preview's image and builds nothing.

This record extends `staged-releases.md`, which defines candidate, promotion and rollback.

## Terms

- **Image key.** The git tree hash of the commit an image was built from (`git rev-parse <commit>^{tree}`). Two commits with the same files have the same tree hash, even when their commit hashes differ, as after a squash merge.
- **Ref.** A name that points at one image of an app. `live` is a ref. Each preview is a ref, `preview` by default, or another name you give.
- **Preview.** A running staged copy of an app for one ref. The copy has its own names, databases, roles, secrets and tailnet route (`StagedCartridge.staged`).
- **Owner PR.** A PR whose author GitHub reports as the repository owner. Your own PRs and the PRs your agents send with your token are both owner PRs, so GitHub cannot tell them apart.
- **Reconcile.** A step that reads GitHub's state for one app, compares it with what the platform runs, and makes the platform match.

## Decisions

### The host command decides; GitHub reports code changes

Every decision comes from an `ops` command that you run:

- `ops preview <app> <pr> [--as <ref>]` puts a PR in a preview. Without `--as`, the ref is `preview`, and the PR replaces the one that ref showed.
- `ops preview drop <app> <ref>` removes a preview and its data.
- `ops preview data <app> <ref> live` gives a preview a copy of the live databases. `ops preview data <app> <ref> reset` starts the preview's data again from empty.

GitHub labels and PR comments decide nothing. An agent that holds your token can add labels and post comments as you, so a label or a comment such as `/stage` cannot prove that you approved anything.

GitHub events report code changes only: a push to a PR, a merge, a close, and a push to `main`.

### One path for changes

An event names the app it touches and runs reconcile for that app at once. A timer runs reconcile for every app, so a lost event delays a change and does not lose it. Reconcile is the only code that changes previews or `live`. A second run with no new events changes nothing, so a repeated or late event does no harm.

The host marks a plan stale when any deploy, destroy or rollback finishes after it (`queue/Store.ts`). So reconcile submits one plan and its deploy at a time, through the existing job queue.

### Images keyed by tree

The builder tags each image with its tree hash and pushes it once. After each push, the runner records the pushed digest for the tree. Before it builds, reconcile reads that record and uses the recorded image if one exists. It never trusts the registry's tag, because the registry takes pushes from every node without credentials.

When the platform deletes an image, it deletes the image's record too. It deletes an image only when no ref points at it and it is not:

- the image of `main`'s tree,
- one of the last three live releases, kept for rollback,
- the newest image of an open PR, so choosing that PR again builds nothing.

### Trust

For an owner PR, a preview follows each new push to the PR. For a PR by any other author, `ops preview` approves the PR's current commit only. A later push keeps the preview on the approved commit, and the PR comment says the push waits for you to run `ops preview` again.

### Stacks

A stacked PR is based on the branch of another open PR. When you choose a PR that has PRs stacked on it, the preview shows the top of the stack, because the top's branch contains the lower PRs. Each lower PR gets a comment that names the PR whose preview contains it. When a lower PR gets a push that the top does not contain yet, the comment says the top needs a restack.

### Data

A preview starts with empty databases, and the app's migrations build them. Data survives pushes to the same PR, and migrations run forward. When a ref switches to another PR, its data starts again. If a PR edits a migration it already applied, run `ops preview data <app> <ref> reset`.

### Merge to deploy

By default, `live` follows the tree of `main`. When `main` changes, reconcile releases `main`'s tree:

- If an image with that tree exists, reconcile releases it. A squash or fast-forward merge of an up-to-date branch gives the PR's own tree, so the release reuses the preview's image.
- If no image has that tree, `main` moved under the PR and nobody previewed the merged code. Reconcile builds `main` and releases that image. The commit status says it was a fresh build.

Either way, reconcile releases `main`'s tree only when it has a signoff (`continuous-deployment.md`). A merged tree that nobody tested gets none until someone runs `ops signoff` on it.

An app with no repository on the control host is not watched. A merge then deploys nothing, and `live` changes only when you run `ops release`. The image of `main`'s tree stays, so that release builds nothing when a preview ran the same tree.

A merge into `main` is your approval, as `staged-releases.md` says. A release still waits for the new container's health checks, and Nomad reverts a release that fails them.

### GitHub App

A GitHub App delivers signed events to a public Traefik route and gives the platform short-lived tokens. With those tokens, the platform reads PR state and posts a commit status and one PR comment per PR, which it updates in place. The comment gives the preview address, the tree the preview runs, and its data (empty or a live copy). Other people can install the same app on their own repositories.

The public route depends on the work that secures public access to the platform's API and webhooks.

### Site policy

The site folder holds the policy, beside `site.toml`. An app repository never holds it, because a PR can change any file in its own repository. The policy sets, per app, the most previews it may run at once. Which apps the platform watches is not policy: it is the set of repositories on the control host (`continuous-deployment.md`). An org-level layer can come later with the same fields. Its limits apply first, and an app's policy cannot raise them.

## Constraints in the current code

- The stage name is `<app>-staged` with a fixed suffix (`StagedCartridge.stagedSuffix`, `release.ts`, `queue/StagelessJobs.ts`). `Cartridge.DerivedInstance` is the closed list `"staged" | "dev"`, and app names may not contain those words. Named refs need a reserved name form that cannot collide with an app name. They also need sanitizing and the 63-byte limit that Postgres identifiers and DNS labels share. A queue job carries the app and the ref as separate fields, because app names contain hyphens.
- `release.ts` builds from a local checkout. The receiver has no checkout, so build, push and deploy must take an exported tree.
- A staged copy runs one image for all its services and refuses a service that writes a host volume. Previews have the same limits.

## Build order

Steps 1 and 4, for `live` only, ship first as continuous deployment (`continuous-deployment.md`).

1. Tag images by tree hash, and release an existing image by its key.
2. Named refs in the staged copy, in place of the fixed `staged` instance.
3. The `ops preview` commands.
4. Reconcile for one app, run by the commands and by a timer.
5. The GitHub App, its public route, and events that run reconcile.
6. PR comments and commit statuses.

## Prototype

A throwaway prototype of this model is on the `prototype/pr-previews` branch (`tools/alchemy/prototype/pr-previews.prototype.html`). It confirmed that tree-keyed images let a same-tree squash merge release without a rebuild, and that one reconcile after lost events catches up while a second changes nothing. It also showed that "the newest push takes the shared preview" makes the preview switch PRs and reset its data on every push. That result led to the `ops preview` command. The prototype still models label-driven refs and newest-push selection, which this record replaces.
