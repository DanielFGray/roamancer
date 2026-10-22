import * as Arr from "effect/Array";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

export class ServiceNotRegistered extends S.TaggedError<ServiceNotRegistered>()(
  "ServiceNotRegistered",
  { service: S.String },
) {
  override get message() {
    return `service ${this.service} is not registered in Nomad`;
  }
}

export interface RegistrationRetry {
  readonly times: number;
  readonly spacing: Duration.Input;
}

/**
 * Nomad lists a service only after its allocation starts. A resource that depends on a job
 * can therefore ask before the list has an entry. Retry that empty answer for a bounded time,
 * then fail with ServiceNotRegistered. Lookup failures other than an empty answer are not retried.
 */
export const firstServiceLocation = <A, E, R>(
  service: string,
  lookup: Effect.Effect<ReadonlyArray<A>, E, R>,
  retry: RegistrationRetry,
): Effect.Effect<A, E | ServiceNotRegistered, R> =>
  lookup.pipe(
    Effect.flatMap((locations) =>
      Option.match(Arr.head(locations), {
        onNone: () => Effect.fail(new ServiceNotRegistered({ service })),
        onSome: Effect.succeed,
      }),
    ),
    Effect.retry({
      times: retry.times,
      schedule: Schedule.spaced(retry.spacing),
      while: (error) => error instanceof ServiceNotRegistered,
    }),
  );

/** Two minutes at two-second spacing covers a normal first start of a dependency job. */
export const dependencyRegistrationRetry: RegistrationRetry = { times: 60, spacing: "2 seconds" };
