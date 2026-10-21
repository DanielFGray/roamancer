# Control-plane hardening plan

This plan drives Prog epic `ep-cd5508`. The epic is complete only when every child task is complete and a clean production-shaped environment proves all of these statements:

- Project-controlled code cannot read control-plane state, cluster SSH credentials, or another project's secrets.
- No long-running process holds an OpenBao root token.
- One versioned definition owns every movable workload.
- Accepted operations and webhook jobs survive process death and resume idempotently.
- Port allocation remains unique under concurrent deployment.
- Empty or corrupt control-plane state fails closed when managed resources exist.
- Encrypted backups leave the source host, restore drills rebuild every data service and the deployment control plane, and status survives restart.
- Consul and API ingress match their recorded security decisions.
- A clean apply, a second convergent apply, and the complete automated suite pass.

## Scope and rigor

The epic has 15 child tasks. Six are root architecture or security decisions, eight depend on those decisions or provide verification, and documentation comes last. Identity separation, state ownership, recovery, and service ownership are expensive to reverse and have cluster-wide blast radius. They require high rigor: two independent designs, an adversarial judge, recorded decisions, failure-injection tests, and production-shaped VM evidence. Formatting cleanups and isolated test-adapter fixes use ordinary review and automated checks.

## Sequence

1. Stabilize the existing firewall, provisioning, backup-command, and test-adapter patch. Keep unrelated concerns in separate commits.
2. Close the clean-host verification gap with first-apply, effective-firewall, reconnect, and second-apply checks.
3. Design the shared trust and ownership model for `ts-db4676`, `ts-42195e`, `ts-0991dd`, and `ts-21f481`. Compare at least two distinct shapes before implementation.
4. Implement identity containment and recoverable OpenBao bootstrap before moving more authority into the agent.
5. Establish the workload manifest and durable operation model. Then implement transactional ports, durable webhook jobs, and safe service moves.
6. Decide whether Consul remains. Implement that decision before completing backup discovery.
7. Finish backup, ingress, artifact verification, hostile-input tests, VM recovery drills, and documentation.

Each implementation unit states a hypothesis, names its check before editing, and receives one of three results: `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`. An inconclusive result does not satisfy a Prog definition of done.

