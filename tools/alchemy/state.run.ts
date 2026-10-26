import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { providers } from "./src/StackProviders.ts";

const stack = Alchemy.Stack(
  "cartridge",
  { providers, state: Alchemy.localState() },
  Effect.succeed({ resources: {} }),
);

export default stack;
