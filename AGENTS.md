# server-ansible

## Decisions

- Secrets stay in OpenBao: narrow per-purpose tokens, `secret/data/<project>` isolation, rotation. `tools/infra` remains the lifecycle tool for the current Ansible hosts. Alchemy owns application desired state on the rebuilt NixOS host.
- The production host is rebuilt from a backup on a fresh NixOS install, with nixpkgs pinned through `flake.lock`. Platform services start in the new service model on that host, so plans need no in-place migration of running services.
- Alchemy owns application lifecycle on the rebuilt NixOS host. Nix owns the host and rootless Podman setup. Nomad schedules application containers. Application properties contain secret references, not secret values.
