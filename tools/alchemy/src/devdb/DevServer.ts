/**
 * The dev databases' own Postgres server. It runs apart from the live server, so dev work
 * cannot take the live server's connections or push it past its memory limit. The
 * platform-dev-data cartridge declares it; the workstation reads the cartridge for the
 * tunnel's port and the host reads it for the admin connection, so both follow one file.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as Cartridge from "../Cartridge.ts";
import * as Package from "../Package.ts";

export const devServerCartridge = "platform-dev-data";

/** Refused when the cartridge is missing or declares no Postgres server on a fixed port. */
export class DevServerMissing extends S.TaggedError<DevServerMissing>()("DevServerMissing", {
  reason: S.String,
}) {
  override get message() {
    return `the ${devServerCartridge} cartridge ${this.reason}`;
  }
}

/** The dev server's Nomad service name and the fixed host port Nomad binds it to. */
export const devServer = Effect.fn("devdb.devServer")(function* () {
  const cartridge = yield* Option.match(
    yield* Cartridge.findPlatform(Package.root, devServerCartridge),
    {
      onNone: () => Effect.fail(new DevServerMissing({ reason: "is not in platform/" })),
      onSome: Effect.succeed,
    },
  );
  const server = cartridge.servers.find((server) => server._tag === "PostgresServer");
  if (server === undefined) {
    return yield* new DevServerMissing({ reason: "declares no PostgresServer" });
  }
  const hostPort = server.service.hostPort;
  if (typeof hostPort !== "number") {
    return yield* new DevServerMissing({
      reason: "gives its PostgresServer a dynamic port; the tunnel needs a fixed one",
    });
  }
  return { name: server.service.name, hostPort };
});
