/**
 * OpenBao KV secrets on the control host, reached from the workstation with one `ssh` per
 * command. OpenBao listens only on the host's loopback address and the `login` token stays in
 * the host's runtime folder, so each command runs the host's `bao` CLI there. Secret values
 * go to the host on stdin and never come back: reads return key names only.
 */
import { Effect, Redacted, Runtime, Stream } from "effect";
import { Schema as S } from "effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

/** A failure the operator can act on, printed without a stack trace. */
export class HostSecretsError extends S.TaggedError<HostSecretsError>()("HostSecretsError", {
  message: S.String,
}) {
  readonly [Runtime.errorReported] = false;
}

/** The key names stored at each KV v2 API path; an empty list where nothing is stored. */
export const storedKeys = Effect.fn("HostSecrets.storedKeys")(function* (
  host: string,
  paths: ReadonlyArray<string>,
) {
  const locations = yield* Effect.forEach(paths, kvLocation);
  const lines = yield* ssh(
    host,
    readKeysScript,
    locations.flatMap(({ mount, path }) => [mount, path]),
    "ignore",
  );
  const keys = yield* Effect.forEach(lines.trim().split("\n"), (line) =>
    S.decodeUnknownEffect(S.fromJsonString(S.Array(S.String)))(line).pipe(
      Effect.mapError(
        () => new HostSecretsError({ message: `unexpected key list from ${host}: ${line}` }),
      ),
    ),
  );
  return new Map(paths.map((path, index) => [path, keys[index] ?? []]));
});

/** Set one key at a KV v2 API path and keep the other keys there. */
export const writeKey = Effect.fn("HostSecrets.writeKey")(function* (
  host: string,
  apiPath: string,
  key: string,
  value: Redacted.Redacted<string>,
) {
  const { mount, path } = yield* kvLocation(apiPath);
  yield* ssh(
    host,
    writeKeyScript,
    [mount, path, key],
    Stream.make(new TextEncoder().encode(Redacted.value(value))),
  );
});

/**
 * Split a KV v2 API path, as cartridges name it (`secret/data/giglist`), into the mount and
 * the path within it, as the `bao kv` commands take them.
 */
export const kvLocation = (apiPath: string) => {
  const match = /^([^/]+)\/data\/(.+)$/.exec(apiPath);
  return match === null
    ? Effect.fail(
        new HostSecretsError({
          message: `'${apiPath}' is not a KV v2 path like secret/data/<name>`,
        }),
      )
    : Effect.succeed({ mount: match[1]!, path: match[2]! });
};

/** The `ssh` arguments that run `script` on `host` with `args` as its positional parameters. */
export const sshArguments = (host: string, script: string, args: ReadonlyArray<string>) => [
  host,
  ["sh", "-c", script, "sh", ...args].map(quote).join(" "),
];

// Exit 3 when the token is missing or expired, so the workstation can name `ops login`.
const loginScript = `set -eu
export BAO_ADDR=http://127.0.0.1:8200
BAO_TOKEN=$(cat "$XDG_RUNTIME_DIR/openbao.token" 2>/dev/null) || exit 3
export BAO_TOKEN
bao token lookup >/dev/null 2>&1 || exit 3
`;

// One JSON array of key names per mount and path pair. The values stay in a host variable;
// a path with no stored version prints [].
const readKeysScript = `${loginScript}while [ $# -gt 1 ]; do
  if entry=$(bao kv get -format=json -mount="$1" "$2" 2>/dev/null); then
    printf '%s\\n' "$entry" | jq -c '.data.data // {} | keys'
  else
    echo '[]'
  fi
  shift 2
done
`;

// `kv patch` fails on a path with no metadata yet, so the first key at a path is a put that
// refuses to overwrite one written meanwhile.
const writeKeyScript = `${loginScript}if bao kv metadata get -mount="$1" "$2" >/dev/null 2>&1; then
  bao kv patch -mount="$1" "$2" "$3=-" >/dev/null
else
  bao kv put -cas=0 -mount="$1" "$2" "$3=-" >/dev/null
fi
`;

const ssh = Effect.fn("HostSecrets.ssh")(function* (
  host: string,
  script: string,
  args: ReadonlyArray<string>,
  stdin: ChildProcess.CommandInput,
) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("ssh", sshArguments(host, script, args), { stdin, stderr: "inherit" }),
  );
  const output = yield* Stream.mkString(Stream.decodeText(handle.stdout));
  const code = yield* handle.exitCode;
  if (code === 3) {
    return yield* new HostSecretsError({
      message: "The OpenBao token is missing or expired. Run `ops login` first.",
    });
  }
  if (code !== 0) {
    return yield* new HostSecretsError({ message: `bao on ${host} exited ${code}` });
  }
  return output;
}, Effect.scoped);

/** Quote one word for the remote shell that `ssh` hands its command line to. */
const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
