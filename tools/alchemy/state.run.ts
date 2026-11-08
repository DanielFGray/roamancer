import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { providers } from "./src/StackProviders.ts";
import * as Package from "./src/Package.ts";

const stack = Alchemy.Stack(
  Package.stack,
  { providers, state: Alchemy.localState() },
  Effect.succeed({ resources: {} }),
);

export default stack;
