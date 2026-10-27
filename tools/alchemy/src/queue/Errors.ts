/**
 * Tagged failures for the queue front end and job units.
 */
import { Schema as S } from "effect";

/** OpenBao token file missing, empty, or rejected by checkToken. */
export class LoginRequired extends S.TaggedError<LoginRequired>()("LoginRequired", {}) {
  override get message() {
    return "run ops login";
  }
}

export class JobNotFound extends S.TaggedError<JobNotFound>()("JobNotFound", {
  id: S.Number,
}) {
  override get message() {
    return `no job ${this.id}`;
  }
}

export class JobNotQueued extends S.TaggedError<JobNotQueued>()("JobNotQueued", {
  id: S.Number,
  state: S.String,
}) {
  override get message() {
    return `job ${this.id} is ${this.state}, expected queued`;
  }
}

export class JobNotStarting extends S.TaggedError<JobNotStarting>()("JobNotStarting", {
  id: S.Number,
  state: S.String,
}) {
  override get message() {
    return `job ${this.id} is ${this.state}, expected starting`;
  }
}

export class JobNotActive extends S.TaggedError<JobNotActive>()("JobNotActive", {
  id: S.Number,
  state: S.String,
}) {
  override get message() {
    return `job ${this.id} is ${this.state}, expected active`;
  }
}

export class CancelRefused extends S.TaggedError<CancelRefused>()("CancelRefused", {
  id: S.Number,
  state: S.String,
}) {
  override get message() {
    return `job ${this.id} is ${this.state}, not cancelable`;
  }
}

export class InvalidJobRow extends S.TaggedError<InvalidJobRow>()("InvalidJobRow", {
  cause: S.Unknown,
}) {
  override get message() {
    return "job row payload failed schema decode";
  }
}

export class UnitsError extends S.TaggedError<UnitsError>()("UnitsError", {
  message: S.String,
}) {}

export class QueueProtocolError extends S.TaggedError<QueueProtocolError>()("QueueProtocolError", {
  message: S.String,
}) {}

export class TokenWriteError extends S.TaggedError<TokenWriteError>()("TokenWriteError", {
  message: S.String,
}) {}
