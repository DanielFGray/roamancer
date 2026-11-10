# Cutover: Alchemy state to the runner account

Move Alchemy state from the operator home to `/var/lib/alchemy`, rebuild so the
operator leaves group `alchemy` and holds only a read-only Nomad token, then
verify. An operator with sudo can still reach everything; this cutover removes
standing access, not root.

Run `ops` commands on the workstation. Run every other command in an SSH session on cynic. `sqlite3` comes from the rebuild in step 1.

## 1. Preconditions

Rebuild cynic from a commit that has the queue client (`alchemy-runner submit`, `alchemy-runner login`) and the workstation `ops` that uses it, but not this runbook's Nix changes (group removal, backup path, operator token):

```sh
ops rebuild cynic
```

```sh
ops login
```

Confirm one queued plan job with a token has succeeded (empty runner state,
plan only).

## 2. Close admission

```sh
sudo systemctl stop alchemy-submit
```

Confirm no active queue rows (`jobs.id`, `jobs.state` in
`/var/lib/alchemy/queue.sqlite`; active states are `queued`, `starting`,
`running`):

```sh
sudo -u alchemy sqlite3 /var/lib/alchemy/queue.sqlite "select id,state from jobs where state in ('queued','starting','running')"
```

Expect no rows.

```sh
systemctl list-units 'alchemy-job@*'
```

Expect no active unit.

## 3. Consistent backup

Pick a date stamp, for example `2026-10-28`.

```sh
DATE=$(date +%F)
sudo sqlite3 -readonly /home/$USER/alchemy/.alchemy/operations.sqlite "VACUUM INTO '/var/lib/backups/alchemy-operations-pre-cutover-$DATE.sqlite'"
sudo tar -C /home/$USER/alchemy -czf /var/lib/backups/alchemy-dot-alchemy-pre-cutover-$DATE.tar.gz .alchemy
```

## 4. Move state

The trailing slashes copy the contents, so state from the precondition plan job is replaced, not nested.

```sh
sudo mkdir -p /var/lib/alchemy/.alchemy
sudo rsync -a --delete /home/$USER/alchemy/.alchemy/ /var/lib/alchemy/.alchemy/
sudo chown -R alchemy:alchemy /var/lib/alchemy/.alchemy
sudo chmod 0700 /var/lib/alchemy/.alchemy
```

## 5. Rebuild with the cutover changes

Open admission again: the state is in place, and `ops rebuild` ends with a queued job. On cynic:

```sh
sudo systemctl start alchemy-submit
```

On the workstation:

```sh
ops rebuild cynic
```

This rebuild removes the operator from group `alchemy`, points the Alchemy
restic backup at `/var/lib/alchemy/.alchemy`, and installs the read-only
operator Nomad policy and `nomad-acl-issue-operator`.

## 6. Credentials

Rotate the Nomad controller token (issue a new one, then delete every
`alchemy-controller` accessor the first list shows) as in `nomad-acl-operations.md`:

```sh
sudo sh -c 'export NOMAD_TOKEN="$(cat /var/lib/nomad-acl/bootstrap.token)"; exec nomad acl token list'
sudo nomad-acl-issue-controller
sudo sh -c 'export NOMAD_TOKEN="$(cat /var/lib/nomad-acl/bootstrap.token)"; exec nomad acl token delete <old-controller-accessor-id>'
```

Issue the read-only operator token:

```sh
sudo nomad-acl-issue-operator
```

Revoke the operator's OpenBao token, then delete its file in the runtime
directory. The `bao` CLI defaults to HTTPS, and the loopback listener is plain HTTP.
The file is deleted only when the revoke succeeds:

```sh
BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=$(cat "$XDG_RUNTIME_DIR/openbao.token") bao token revoke -self &&
  rm -f "$XDG_RUNTIME_DIR/openbao.token"
```

End every existing SSH session for the operator, this one included, as the last command of this step. Supplementary groups from before the rebuild stay in those sessions.

```sh
loginctl terminate-user "$USER"
```

## 7. Login and plan

Open a new SSH session.

```sh
ops login
```

On cynic, list the stages that have state:

```sh
sudo ls /var/lib/alchemy/.alchemy/state/cartridge
```

On the workstation, plan each one and expect no changes. An app stage that was
never released through the operation journal fails with "no recorded deployment";
`ops dash` lists only journaled apps. To record one, push a signed-off commit to `main`
in the app's repository on the control host (`ops repo create`). That deploys the
commit to production.

```sh
ops plan --stage <stage>
```

## 8. Verify from a fresh SSH session

Confirm the operator cannot read the runner home, the controller token, or
submit a Nomad job with the read-only token:

```sh
ls /var/lib/alchemy
cat /var/lib/nomad-acl/controller.env
NOMAD_TOKEN=$(cat /var/lib/nomad-acl/operator.token)
printf '%s\n' '{"Job":{"ID":"acl-probe","Name":"acl-probe","Type":"service","Datacenters":["dc1"],"TaskGroups":[{"Name":"g","Count":1,"Tasks":[{"Name":"t","Driver":"raw_exec","Config":{"command":"/bin/true"}}]}]}}' > /tmp/acl-probe.json
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Nomad-Token: $NOMAD_TOKEN" -X POST http://127.0.0.1:4646/v1/jobs --data-binary @/tmp/acl-probe.json
rm /tmp/acl-probe.json
```

Expect permission denied on `ls` and `cat`, and HTTP `403` on the submit. The
credential directory is 0711, so `ls` of a named file in it succeeds; reading it does not.

```sh
ops dash
```

Expect the fleet picture.

```sh
sudo systemctl start restic-backups-alchemy
sudo systemctl status restic-backups-alchemy
```

Expect a successful run that reads `/var/lib/alchemy/.alchemy`.

## 9. Rollback

Rollback is valid only by copying the runner's **current** state back to the
operator home. Do not restore the pre-cutover tar after any queued write has
changed `/var/lib/alchemy/.alchemy`.

```sh
sudo systemctl stop alchemy-submit
sudo -u alchemy sqlite3 /var/lib/alchemy/queue.sqlite "select id,state from jobs where state in ('queued','starting','running')"
systemctl list-units 'alchemy-job@*'
sudo rsync -a --delete /var/lib/alchemy/.alchemy/ /home/$USER/alchemy/.alchemy/
sudo chown -R "$USER:" /home/$USER/alchemy/.alchemy
```

Restore the previous Nix generation (or a config that still points backups and
group membership at the operator home), then:

```sh
ops rebuild cynic
ops login
ops plan --stage <stage>
```

for every stage, and confirm the restic Alchemy backup path matches the
restored layout.

Run `sudo systemctl start alchemy-submit` on cynic before that `ops rebuild`,
because the rebuild ends with a queued job.
