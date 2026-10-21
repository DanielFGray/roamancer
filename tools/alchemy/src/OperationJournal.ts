import { SqliteClient } from "@effect/sql-sqlite-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as EventGroup from "effect/eventlog/EventGroup"
import * as EventJournal from "effect/eventlog/EventJournal"
import * as EventLog from "effect/eventlog/EventLog"
import * as EventLogEncryption from "effect/eventlog/EventLogEncryption"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Schema from "effect/Schema"
import * as SqlEventJournal from "effect/eventlog/SqlEventJournal"
import * as PlatformError from "effect/PlatformError"

const OperationFields = {
  operationId: Schema.String,
  resourceId: Schema.String,
  provider: Schema.String,
  target: Schema.String,
  action: Schema.Literals(["reconcile", "delete"]),
  timestampMs: Schema.Number
}

const OperationStarted = Schema.TaggedStruct("OperationStarted", OperationFields)
const OperationSucceeded = Schema.TaggedStruct("OperationSucceeded", OperationFields)
const OperationFailed = Schema.TaggedStruct("OperationFailed", OperationFields)
const OperationResolved = Schema.TaggedStruct("OperationResolved", {
  ...OperationFields,
  resolvedBy: Schema.String
})
const OperationEvent = Schema.Union([OperationStarted, OperationSucceeded, OperationFailed, OperationResolved])
type OperationEvent = typeof OperationEvent.Type
type StartedOperation = typeof OperationStarted.Type
type OperationInput = Omit<typeof OperationStarted.Type, "_tag" | "operationId" | "timestampMs">
type JournalError = EventJournal.EventJournalError | Schema.SchemaError

const OperationEvents = EventGroup.empty.add({
  tag: "OperationRecorded",
  primaryKey: (event) => event.resourceId,
  payload: OperationEvent
})

const schema = EventLog.schema(OperationEvents)

const handlers = EventLog.group(OperationEvents, (handler) =>
  handler.handle("OperationRecorded", () => Effect.void)
).pipe(Layer.provide(EventLog.layerRegistry))

export class OperationJournal extends Context.Service<OperationJournal, {
  readonly run: <A, E, R>(
    operation: OperationInput,
    action: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | JournalError | PlatformError.PlatformError, R>
  readonly history: Effect.Effect<ReadonlyArray<OperationEvent>, JournalError>
  readonly hasPending: (resourceId: string) => Effect.Effect<boolean, JournalError>
}>()("alchemy/OperationJournal") {}

const makeService = Effect.gen(function*() {
  const crypto = yield* Crypto.Crypto
  const eventLog = yield* EventLog.EventLog
  const write = yield* EventLog.makeClient(schema)

  const history = Effect.gen(function*() {
    const entries = yield* eventLog.entries
    return yield* Effect.forEach(entries, (entry) =>
      Schema.decodeUnknownEffect(OperationEvents.events.OperationRecorded.payloadSchemaBinary)(entry.payload)
    )
  })

  const record = (event: OperationEvent) => write("OperationRecorded", event)

  const pendingOperations = (events: ReadonlyArray<OperationEvent>, resourceId: string) => {
    const started = new Map<string, StartedOperation>()
    const resolved = new Set<string>()
    for (const event of events) {
      Match.value(event).pipe(
        Match.when({ _tag: "OperationStarted" }, (operation) => {
          if (operation.resourceId === resourceId) started.set(operation.operationId, operation)
        }),
        Match.when({ _tag: "OperationSucceeded" }, (operation) => resolved.add(operation.operationId)),
        Match.when({ _tag: "OperationFailed" }, (operation) => resolved.add(operation.operationId)),
        Match.when({ _tag: "OperationResolved" }, (operation) => resolved.add(operation.operationId)),
        Match.exhaustive
      )
    }
    return Array.from(started.values()).filter((operation) => !resolved.has(operation.operationId))
  }

  const run = Effect.fn(function*<A, E, R>(operation: OperationInput, action: Effect.Effect<A, E, R>) {
    const previous = pendingOperations(yield* history, operation.resourceId)
    const operationId = yield* crypto.randomUUIDv7
    yield* record(OperationStarted.make({
      ...operation,
      operationId,
      timestampMs: yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()))
    }))

    const result = yield* Effect.exit(action)
    if (Exit.isSuccess(result)) {
      const timestampMs = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()))
      yield* Effect.forEach(previous, (unfinished) => record(OperationResolved.make({
        operationId: unfinished.operationId,
        resourceId: unfinished.resourceId,
        provider: unfinished.provider,
        target: unfinished.target,
        action: unfinished.action,
        timestampMs,
        resolvedBy: operationId
      })))
      yield* record(OperationSucceeded.make({
        ...operation,
        operationId,
        timestampMs
      }))
      return result.value
    }

    yield* record(OperationFailed.make({
      ...operation,
      operationId,
      timestampMs: yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()))
    })).pipe(
      Effect.catchTag("EventJournalError", (error) =>
        Effect.logError("Could not record failed operation", error)
      )
    )
    return yield* Effect.failCause(result.cause)
  })

  return OperationJournal.of({
    run,
    history,
    hasPending: Effect.fn(function*(resourceId) {
      const events = yield* history
      return pendingOperations(events, resourceId).length > 0
    })
  })
})

export const layer = () => Layer.unwrap(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(".alchemy", { recursive: true })
    const eventLogLayer = EventLog.layer(schema, handlers).pipe(
      Layer.provide(SqlEventJournal.layer()),
      Layer.provide(SqliteClient.layer({ filename: ".alchemy/operations.sqlite" })),
      Layer.provide(
        Layer.effect(EventLog.Identity, EventLog.makeIdentity).pipe(
          Layer.provide(EventLogEncryption.layerSubtle)
        )
      )
    )
    return Layer.effect(OperationJournal, makeService).pipe(
      Layer.provide(eventLogLayer),
      Layer.provide(NodeCrypto.layer)
    )
  })
).pipe(Layer.provide(NodeFileSystem.layer))

export const formatOperation = (event: OperationEvent): string => {
  const time = new Date(event.timestampMs).toISOString()
  const recovery = Match.value(event).pipe(
    Match.when({ _tag: "OperationResolved" }, (resolved) => ` by ${resolved.resolvedBy}`),
    Match.orElse(() => "")
  )
  return `${time} ${event._tag} ${event.action} ${event.provider} ${event.target} (${event.resourceId})${recovery}`
}
