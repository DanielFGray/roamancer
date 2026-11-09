/**
 * How the front end writes a secret for `alchemy-runner secret set`: with the `ops login`
 * token, the one jobs use. That token is a child of the root token, so while it lasts,
 * whoever can reach the submit socket can set secrets, as they can already deploy.
 */
import { Context, Effect, type Redacted } from "effect";

export class SecretWriter extends Context.Service<
  SecretWriter,
  {
    /** Set `key` at the KV v2 `path` with `token`, keeping the path's other keys. */
    readonly write: (
      token: Redacted.Redacted<string>,
      path: string,
      key: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, { readonly message: string }>;
  }
>()("queue/SecretWriter") {}

/**
 * A secret's value as piped on stdin. One trailing newline is dropped, the one that `echo`,
 * `printf '%s\n'` or a file's last line adds; any other whitespace is part of the value.
 */
export const pipedValue = (text: string) => text.replace(/\r?\n$/, "");
