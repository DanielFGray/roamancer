# Alchemy operation history

## Problem

Alchemy owns the desired resources in the stack and reconciles them with Nomad. Its local state does not provide an append-only history of provider operations. The recovered Effect EventLog prototype has a SQLite journal, but it recorded results after a separate apply loop. The current provider needs history without creating a second source of desired state.

## Usage

Deployments keep the existing commands. Operators can inspect recorded resource operations with:

```sh
cd tools/alchemy
bun run history
```

The Nomad provider records an operation around each reconcile or delete. An interrupted operation has a `started` event and no terminal event. The next Alchemy plan marks that resource for reconciliation. The provider checks live Nomad state and either completes the operation or reapplies the declared job.

## Shape

`OperationJournal` hides Effect EventLog, the SQL journal, SQLite, and operation replay behind three methods:

```ts
run(operation, effect) // record start and result around a resource operation
hasPending(resourceId) // detect a start without a success or failure
history                // return decoded operation records for the history command
```

Events contain the Alchemy resource ID, provider name, Nomad job name, action, operation ID, and timestamp. They do not contain job specs, secret values, error messages, or credentials. The database lives at `.alchemy/operations.sqlite`, beside Alchemy's local resource state. The stack remains the source of desired state. Nomad remains the source of observed job state.

The provider writes the start event before it changes Nomad. If that write fails, it does not start the external operation. It writes a success event after Nomad settles. If the process stops before that event, the next plan sees the pending operation and retries against live Nomad state. A successful retry also records which earlier attempts it resolved. A failure event records the operation's end without persisting error details.

The journal uses Effect 4.0.2's unstable `EventLog` and `SqlEventJournal` modules. One module contains those imports so an Effect API change stays local.

## Synthesis decision

The operation-history candidate supplies the base design: Alchemy keeps resource ownership and desired state; EventLog records provider operations. The pending-operation check adds a recovery trigger from the second candidate. Event replay does not recreate the stack, and the event log does not replace Alchemy state.

## Tradeoffs accepted

- A failed or interrupted journal write can stop or report a failed deployment. This keeps the journal and provider operation status aligned. A later Alchemy run can reconcile the pending operation from the stack and live Nomad state.
- SQLite is suitable for the current single-writer setup. The journal does not coordinate independent Alchemy writers.
- The history database and Alchemy state must be preserved together. Neither file is a backup by itself.
- Event history grows with resource operations. This first version has no retention or archive policy.

## Alternatives considered

- **Alchemy state only.** This keeps less data, but it cannot show an operation timeline or identify an operation interrupted between the provider call and Alchemy state update.
- **EventLog as desired state.** Rejected because it would duplicate the stack's resource graph, diff, and deletion rules.
- **A separate durable workflow for every Nomad update.** Rejected for the current provider. Its reconcile operation is idempotent and checks live Nomad state. Use Effect Workflows for future multi-step release or database cutover procedures that need ordered phases and compensation.

## Open questions and risks

This does not start Alchemy after a host reboot. It recovers when an operator runs the next plan. The journal is not a write-ahead log for Nomad: the SQLite commit and Nomad HTTP change cannot share one transaction. A pending event triggers a live-state retry; it does not prove that Nomad did or did not accept the request. The journal itself does not lock Nomad operations across processes. Staged applies take one host-local flock lock in the staged runner; a workstation lock does not coordinate with that runner on the NixOS host.

## Next implementation step

Use the same journal for Caddy route operations when the Alchemy Caddy provider is added, then verify a forced process stop between the external update and its completion event.
