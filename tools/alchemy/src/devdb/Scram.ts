/**
 * SCRAM-SHA-256 password verifiers, the form PostgreSQL stores in pg_authid (RFC 5802,
 * RFC 7677). `ops dev db` sends the host only these, so no dev login password leaves the
 * workstation or rests in a queued job row.
 *
 * PostgreSQL stores a PASSWORD string as given when it parses as a verifier, and hashes
 * it as a plaintext password when it does not. A malformed verifier therefore creates a
 * role that nobody can log in as, so `Verifier` checks the shape where the host decodes
 * the request.
 */
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";

// PostgreSQL's own default (scram_iterations).
const iterations = 4096;

const base64 = "[A-Za-z0-9+/]+={0,2}";
export const Verifier = S.String.check(
  S.isPattern(new RegExp(`^SCRAM-SHA-256\\$[1-9][0-9]*:${base64}\\$${base64}:${base64}$`)),
);

/**
 * The verifier of `password` with a fresh random salt. The password must need no
 * SASLprep normalisation; generated dev passwords are lowercase hex.
 */
export const scramVerifier = Effect.fn("devdb.scramVerifier")(function* (
  password: Redacted.Redacted<string>,
) {
  const crypto = yield* Crypto.Crypto;
  const salt = yield* crypto.randomBytes(16);
  return verifierWithSalt(Redacted.value(password), salt);
});

const verifierWithSalt = (password: string, salt: Uint8Array) => {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${Base64.encode(salt)}$${Base64.encode(storedKey)}:${Base64.encode(serverKey)}`;
};
