# Continuous deployment

## Goal

A push to an app's `main` branch releases that commit, and the operator runs no command after the push. The platform builds the commit and releases it only when its tests passed and were signed off. The release waits for the new container's health checks, and Nomad reverts a release that fails them.

This record replaces `pr-previews.md` for apps hosted on the control host: one staged copy per app, fed by `develop`, instead of a preview per pull request, and no forge. It uses that record's terms (image key, ref, reconcile) and holds only what an unattended release adds.

## Decisions

### Trigger: a timer reads `main`

The runner's timer reads the `main` commit of each watched app's repository on the control host once a minute, and runs reconcile for each app whose `main` changed. This needs no public route and no forge. A git hook in the repository can come later and run the same reconcile sooner. It changes no decision here.

### Reconcile acts on a change of `main`

Reconcile releases `main` when its tree differs from the last tree that reconcile released or tried for that app. It does not compare `main` with `live`. So:

- After `ops rollback`, `live` stays on the rolled-back release until `main` changes again or the operator runs `ops reconcile <app>`. The next push, usually the fix, releases normally.
- A build or deploy that fails is not tried again on each timer run. The next push tries again, or `ops reconcile <app>`, which releases the same tree again when the failure came from outside the tree, such as a full disk. A retry still needs the signoff and a valid token. The queue keeps a retry job apart from the timer's job for the same app, because a retry merged into a timer job would skip the tried tree.
- A tree without a signoff, or a run without a valid token, is not a try. Reconcile releases that tree when the signoff or the login arrives.

An app with no repository on the control host is never released: a push to `main` there is the only release.

### Stage: `develop` deploys the staged copy

`main` is production and `develop` is the stage. Each app has two stages, and each stage has its own reconcile job and record: the app's own name for `main`, and `<app>-staged` for `develop`. The timer queues the live job first. The queue runs one job at a time, so a long staged deploy delays a `main` push that comes after it. A signed-off push to `develop` deploys the tailnet-only staged copy (`StagedCartridge.ts`) on the image of its tree, and records no deployment. The same rules apply as for `main`: a signoff and a valid token, and one try per tree. `ops reconcile <app>` retries `main`, and `ops reconcile <app>-staged` retries `develop`, so a retry never touches the other stage.

A merge of `develop` into `main` is the promotion. A fast-forward merge gives `main` the staged tree, so the release reuses the staged image and its signoff and builds nothing.

`ops discard <app>` destroys the staged copy and its database copies. Deleting `develop` only stops updates, so content edited in the stage survives it. After a discard, the next new tree on `develop` makes a new staged copy, whose databases copy production again. An app whose services write a host volume cannot be staged yet; its `develop` push records the refusal as a failed try.

### Repositories on the control host

Each watched app has a bare repository on the control host, `/srv/git/<app>.git`, and a push to its `main` releases it. The operator pushes over ssh as their own account (`git push cynic main`, with the remote `cynic:/srv/git/<app>.git`), so the release path needs no forge, no deploy key and no network beyond the tailnet. GitHub or another forge stays a mirror that the operator pushes to when they choose; it is not on the release path.

The runner module makes the folder. `ops repo create`, run in an app's checkout, makes that app's repository over ssh as the operator (`alchemy-runner repository <app>`), adds a remote named after the host, and installs the signoff hook. It never touches a repository that exists. The operator owns each repository; the folder is setgid group `alchemy-repositories`, whose members are the operator and the runner, so the runner reads every object a push writes and cannot change one. The operator must be a member: Linux clears a folder's setgid bit when a user outside its group changes its mode, as git does to each folder it makes, and the objects in that folder then get the operator's own group. Git refuses a repository another user owns, so `/etc/gitconfig` lists the folder in `safe.directory`. The runner's nightly restic backup includes the folder, because it holds the only pushed copy outside the operator's machines.

Reconcile reads `main` in the repository itself: no fetch and no cache. A release records the repository's root commit as the app's origin, which the full history in the repository gives. Reconcile exports `main`'s tree with `git archive` and builds from that tree. `pr-previews.md` already requires a build from an exported tree, because the host has no checkout.

The runner uploads the exported tree to a `builds` bucket in Garage and gives the build job a presigned URL for it that expires after a few minutes. Nomad's `artifact` block fetches and unpacks the tree before the task starts, so the build container receives no credential. A batch job has no stdin, which is how today's ssh build receives its tree.

### Build: a Nomad batch job in the builder's Podman, on worker nodes

An unattended build runs code from anyone who can push to `main`, so it runs apart from the workstation and from the operator's account.

The build is a Nomad batch job. Nomad places it as it places every job: the scheduler algorithm is `spread` (`nixos/cynic/nomad-acl.nix`), so the build goes to the least-loaded eligible node, and a node added later takes builds with no change here. The image goes to the registry, which every node pulls from, and the runner's record maps the tree to the digest wherever the build ran.

The build task runs Buildah (chroot isolation, `vfs` storage) in a platform image built by the root flake. The job mounts the node's registry CA folder read-only and passes it to Buildah with `--cert-dir`, so the image holds no site facts. The image holds a registries.conf that resolves short names on Docker Hub, as the hosts' Podman does today. Measured on atheist on 2026-11-08, nested in rootless Podman with default security options: dfg.rocks built in 111 s with a peak of 1.6 GB, and postgres.garden in 475 s with a peak of 2.0 GB, file cache included.

Isolation:

1. **A `builder` user with its own rootless Podman.** The Podman driver selects it by a named `socket` block (`socket = "builder"` in the task). That user is not `nomad`, whose Podman runs the production containers, not `alchemy`, which holds the deploy token, and not the operator, whose shell can reach sudo.
2. **Worker nodes only.** Only worker nodes have the builder socket, and the job is constrained to them. cynic holds OpenBao, the registry and the runner, and a kernel exploit from build code there would reach them. Today atheist is the only worker.
3. **Egress by user.** Rootless Podman's traffic leaves the host as the builder user, so the node's firewall matches that user and allows only the registry, DNS and the public internet. It drops the LAN, the tailnet, OpenBao, Nomad and Garage's admin port.
4. **No credentials in the build.** The registry checks none. The tree comes by a presigned URL, and the task gets no Nomad workload identity file or variable.
5. **Limits.** A build reserves 256 MB in Nomad and may use up to 2 GB (`memory_max`), or what its cartridge sets. This needs Nomad memory oversubscription, which the scheduler settings in `nomad-acl.nix` turn on; it changes only jobs that set a maximum. The builder user's systemd slice caps all builds on a node together and gives them a low CPU weight, so production containers win under contention.

The runner reads the digest that the job prints, with its own Nomad token. It treats that output as untrusted: it records a digest only after the registry answers for `<repository>@<digest>`, and only under the repository and key it chose for that job. The builder cannot reach the runner socket, so a Dockerfile cannot record an image under another app's tree.

A release and `ops stage` use the same build job: the exported tree goes to the runner, which uploads it and submits the job. The ssh build as the operator and the Docker build on the workstation no longer exist, so every image, manual or unattended, comes from one build path with one set of limits.

gVisor was measured and not chosen. Buildah fails inside it (no `/proc/<pid>/setgroups`), Kaniko builds dfg.rocks there in 407 s, and the container's memory limit is not enforced under rootless Podman. It would let builds run on cynic.

### Check: a signoff keyed by tree

`ops signoff [commit]` runs the app's checks on the developer's machine and records that they passed. It exports the commit's tree (`HEAD` by default) with `git archive`, runs `scripts/worktree-setup` there when the app has one, and then `scripts/verify`. These are the project scripts that foreman runs before it lands a branch, so one script says what "checked" means for both. Each project decides what its verify runs: unit tests, browser tests, a build, or nothing. The platform needs only an exit code of 0. The export holds only committed files, so uncommitted edits, ignored files such as `.env`, and the checkout's `node_modules` cannot change the result. The export has no `.git` folder, so a verify script must not need one.

Verify runs once per tree. The developer runs `ops signoff` when the work is ready, or foreman runs it when it lands a branch. A push does not run the tests again. `ops signoff install` writes a git pre-push hook in the app's repository. The hook refuses a push to `main` or `develop` of the app's repository on the control host when the tree of a commit it sends has no signoff there, and it runs no tests itself. A push to a mirror deploys nothing, so the hook does not check it:

```sh
ops signoff install   # once per clone; linked worktrees share the hook
ops signoff           # run scripts/verify on HEAD, and record that it passed
git push              # the hook finds the signoff; reconcile releases within a minute
```

`git push --no-verify` skips the check. When the control host does not answer, the hook prints a warning and the push continues, so an outage of the control host does not block a push to a mirror. Either way, reconcile releases that tree only after `ops signoff <commit>` records a signoff.

The runner stores the app, the tree hash, the commit and the last lines of the verify output. Reconcile releases `main` only when its tree has a signoff. A signoff does not need the commit to be on the remote: the runner stores it by tree, and a tree that is never pushed is never released. So foreman can sign off a branch when it lands, before anyone pushes it.

The record is keyed by tree, like the images. A squash merge makes a new commit with the same tree, so the signoff of the PR's last commit still applies. A GitHub commit status would not survive that, because it belongs to one commit.

The signoff proves that the operator's ssh key sent it. An agent that holds that key can sign off too, as it can push to `main`.

### Token: `ops login` only

A reconcile job uses the same token as any job, the one `ops login` mints for 10 hours. Without a valid token, reconcile records "run ops login" and releases nothing. It tries again on the next timer run after a login, because no release was tried. So a push deploys only while the operator is logged in. A standing token can come later; it would change only this section.

### Approval

Today the workstation shows each plan and asks before it submits the deploy (`host-owned-staged-runner.md`). Under continuous deployment, a push to `main` is the approval, as `staged-releases.md` already says for a merge. So anyone who can push to `main` releases to production, and that includes an agent that can use the operator's ssh key. That push is the only way to release, so the ssh key that can push and the `ops login` token that reconcile needs decide who can release.

### Revision lock

`ops` compares the workstation's `tools/alchemy` with the runner's revision because the runner reads what `ops` sends. Reconcile starts on the host and receives nothing from the workstation, so it skips that check. A platform commit then stops only the workstation's `ops` commands until the next rebuild, not releases started by a push. `ops signoff` skips the check too, because the runner only stores a signoff, so a platform commit does not stop a push either.

### Watched apps and timer

The repositories folder is the list of watched apps: reconcile watches every `<app>.git` in it, so adding an app needs no `ops rebuild`. A rebuild gate on that list would add no protection. A release needs the operator's `ops login` token, and that token can already deploy any cartridge with `CARTRIDGE=<file> ops deploy`, a new one included. Making a repository needs the operator's ssh login, which can already push to `main`. A systemd timer queues one `reconcile` job per repository every minute; the queue keeps at most one waiting or running reconcile job per app, so a slow release is not queued twice. A repository that cannot be read is an outcome shown in `ops dash`, not a failed job, so the timer does not fill the queue with failures.

### Records

Each release goes into the deployment record with its commit and its signoff. A failed build or deploy is a failed job in `ops dash`, with its log.

## Build order

1. Tag images by tree hash, and release an existing image by its key (step 1 of `pr-previews.md`).
2. The build job: on worker nodes, the `builder` user, its Podman socket, its firewall rule and slice limits, and memory oversubscription; the Buildah platform image; the `builds` bucket; and the runner's build that submits the job, reads its digest, checks it and records it.
3. `ops signoff` and the runner's signoff record, and the pre-push hook that runs it.
4. Reconcile of `live` for one app, run by `ops reconcile <app>` and by the timer, for each app with a repository on the control host. Done.

The previews of `pr-previews.md` (its steps 2 to 6) come after these.
