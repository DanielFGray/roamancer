# server-ansible

## Decisions

- Secrets stay in OpenBao: narrow per-purpose tokens, `secret/data/<project>` isolation, rotation. Alchemy owns application desired state on the rebuilt NixOS host.
- The production host is rebuilt from a backup on a fresh NixOS install, with nixpkgs pinned through `flake.lock`. Platform services start in the new service model on that host, so plans need no in-place migration of running services.
- Alchemy owns application lifecycle on the rebuilt NixOS host. Nix owns the host and rootless Podman setup. Nomad schedules application containers. Application properties contain secret references, not secret values.

## Platform changes

- New `tools/alchemy` or `nixos/` code reaches a host only through `ops rebuild`, which needs the operator's password. Keep platform commits on a branch until the next rebuild, and merge them into develop just before it, for every waiting commit at once. Ask for a rebuild only when a deploy needs a change.
- Edit platform code in a git worktree, not in the shared checkout. `ops` refuses every job while this checkout's `tools/alchemy`, uncommitted edits included, differs from the runner's revision, so an edit in progress blocks every agent's deploys.
