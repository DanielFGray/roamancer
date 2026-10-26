import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as Effect from "effect/Effect";
import { kvLocation, sshArguments } from "./HostSecrets.ts";

describe("HostSecrets", () => {
  it("splits a KV v2 API path into the mount and the path within it", async () => {
    assert.deepEqual(await Effect.runPromise(kvLocation("secret/data/platform/openobserve")), {
      mount: "secret",
      path: "platform/openobserve",
    });
    await assert.rejects(Effect.runPromise(kvLocation("secret/giglist")));
  });

  it("passes each argument to the remote script as one word", () => {
    const awkward = ["it's", "two words", "$HOME", "a;b"];
    const [, command] = sshArguments("host", 'printf "%s\\n" "$@"', awkward);
    // ssh hands the command line to the remote user's shell, as sh -c does here.
    assert.equal(
      execFileSync("sh", ["-c", command!], { encoding: "utf8" }),
      awkward.join("\n") + "\n",
    );
  });
});
