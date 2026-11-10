# server-ansible

## Decisions

- Secrets stay in OpenBao: narrow per-purpose tokens, `secret/data/<project>` isolation, rotation. Alchemy owns application desired state on the rebuilt NixOS host.
- The production host is rebuilt from a backup on a fresh NixOS install, with nixpkgs pinned through `flake.lock`. Platform services start in the new service model on that host, so plans need no in-place migration of running services.
- Alchemy owns application lifecycle on the rebuilt NixOS host. Nix owns the host and rootless Podman setup. Nomad schedules application containers. Application properties contain secret references, not secret values.

## Platform changes

- New `tools/alchemy` or `nixos/` code reaches a host only through `ops rebuild`, which needs the operator's password. Ask for a rebuild only when a deploy needs a change. A commit that adds a key to a job request or a cartridge makes `ops` fail against the older runner, so keep it on a branch and merge it into develop just before the rebuild.
