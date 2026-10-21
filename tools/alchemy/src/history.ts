import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as OperationHistory from "./OperationJournal.ts"

const program = Effect.gen(function*() {
  const journal = yield* OperationHistory.OperationJournal
  const events = yield* journal.history
  if (events.length === 0) {
    yield* Effect.log("No recorded operations.")
  } else {
    yield* Effect.forEach(events, (event) => Effect.log(OperationHistory.formatOperation(event)))
  }
}).pipe(Effect.provide(OperationHistory.layer()))

void Effect.runPromiseExit(program).then((exit) => Exit.match(exit, {
  onSuccess: () => undefined,
  onFailure: (cause) => {
    console.error(Cause.pretty(cause))
    process.exitCode = 1
  }
}))
