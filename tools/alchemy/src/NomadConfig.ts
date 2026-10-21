import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export type NomadTarget = {
  readonly address: string;
  readonly token: Option.Option<Redacted.Redacted<string>>;
};

/** Read the one configured Nomad target. Keep tokens redacted in Effect config. */
export const target = Effect.fn(function* () {
  const address = yield* Config.String("NOMAD_ADDR");
  const token = yield* Config.option(Config.Redacted("NOMAD_TOKEN"));
  return { address, token } satisfies NomadTarget;
});
