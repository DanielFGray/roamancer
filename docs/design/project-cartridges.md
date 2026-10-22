# Project-owned service cartridges

## Problem

The Alchemy stack accepts an app-owned declaration while it keeps ownership of Nomad, NixOS, rootless Podman, secret delivery, and Alchemy state. App repositories use different dependency versions, so importing their Alchemy code into the platform would couple deployment to each app's runtime and package lock.

## Usage

An app owns `deploy/cartridge.json`. A cartridge is a versioned JSON file that describes services and their data needs. This example declares one service:

```json
{
  "apiVersion": "server-ansible/v2",
  "name": "noneuclid",
  "services": [
    {
      "name": "noneuclid",
      "image": "localhost/noneuclid:trial",
      "hostPort": 18518,
      "containerPort": 5181,
      "storage": { "volume": "noneuclid-data", "mountPath": "/data" },
      "healthCheck": { "type": "http", "path": "/" },
      "cpu": 2000,
      "memoryMB": 1024,
      "networkMode": "bridge",
      "environment": [],
      "connections": [],
      "secrets": []
    }
  ]
}
```

The operator points the Alchemy runner at this file with `ALCHEMY_CARTRIDGE` and passes `--stage noneuclid`. The stage must match the cartridge's `name`. The runner validates its version and fields, then plans the job through the `NomadJob` resource.

## Shape

`Cartridge.ts` owns the versioned input schema, file decoder, and expansion into resources. A cartridge declares `name`, optional `servers`, `postgres`, `valkey`, and a `services` array. It either provides servers or requests PostgreSQL and Valkey access. Services can appear in any declaration order: `effect/Graph` orders them by their connections, and the schema rejects missing providers and cycles. `Compose.ts` connects resource outputs to dependent jobs. `alchemy.run.ts` checks the stage and supplies the platform providers. The app repository owns the cartridge data; the platform owns the Nomad mapping, resource state, host rules, credentials, and secret policy.

This is a project-owned declaration, not project-authored Alchemy code. It does not run app code in the deployment process. A cartridge describes a set of Nomad jobs plus declared Postgres and Valkey needs; the platform expands it into a resource plan and provisions databases, access, and credentials. `connections` can name another service declared in the same cartridge.

## Synthesis decision

Choose a validated JSON cartridge over a TypeScript module or a full app-authored Alchemy stack. JSON does not execute project code in the control process and does not require each app to install the platform's Alchemy and Effect versions. The platform validates one versioned data shape before it can reach the Nomad adapter.

The TypeScript candidate offers editor types, but loading a TypeScript module executes its top-level code and requires compatible runtime dependencies in each app repository. A project-authored Alchemy stack would expose provider and state details and would couple separate lockfiles. The JSON cartridge gives up arbitrary composition until a shared resource graph API exists.

## Tradeoffs accepted

- App authors declare services and data needs in a narrow data format in exchange for platform-controlled providers and runtime validation.
- The image must be built and made available before deployment; image building is a separate lifecycle.
- Noneuclid's existing Compose push flow remains separate from this testground path. Its deployment settings can drift from the cartridge until that flow is migrated or retired.
- The first cartridge can name a host volume but cannot create that host resource. Nix remains its owner.
- Image building and registry selection remain separate lifecycle work.
- The runner uses the `cartridge` stack and a stage named after each cartridge. Platform and app cartridges therefore have separate local resource state.

## Open questions and risks

- Project cartridges request platform capabilities by logical name: an app declares `postgres` database names and `valkey` access, and the platform derives every role name, login, key prefix, secret path and OpenBao role from the app name. (Answered by cartridge v2.)
- Which image registry and immutable image identifier should the build path produce?
- Where should durable Alchemy state live when more than one operator or machine deploys?

## First implementation result

The initial Noneuclid proof loaded its declaration and produced no change to the managed job. The current v2 implementation also composes PostgreSQL databases, Valkey access, generated admin credentials, and jobs with runtime secrets and optional prestart migrations.

On 2026-10-21, the platform-data cartridge deployed shared PostgreSQL and Valkey on cynic. Authentication, container replacement, and a final no-change plan passed; see [the saved proof](../../.audit/cynic-platform-data-proof.txt). App-scoped database and Valkey provisioning still need an end-to-end proof. Cross-cartridge server dependencies, image delivery, and multi-node data movement remain separate work.
