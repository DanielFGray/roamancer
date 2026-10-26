import * as Option from "effect/Option";

/** The digest of a tagged or digest-pinned image reference, when it is a well-formed sha256 digest. */
export const imageDigest = (image: string): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(image.split("@")[1]), (digest) =>
    /^sha256:[0-9a-f]{64}$/.test(digest),
  );

/** Promotion is safe only when both references name the same immutable image bytes. */
export const sameImageDigest = (left: string, right: string) =>
  Option.match(imageDigest(left), {
    onNone: () => false,
    onSome: (digest) => imageDigest(right).pipe(Option.contains(digest)),
  });
