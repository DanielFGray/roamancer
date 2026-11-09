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

/** The reference every service of a cartridge runs, with duplicates kept out. */
export const serviceImages = (cartridge: {
  readonly services: ReadonlyArray<{ readonly image: string }>;
}) => [...new Set(cartridge.services.map((service) => service.image))];

/** The distinct registry repositories a cartridge's images come from, without tag or digest. */
export const repositoriesOf = (cartridge: {
  readonly services: ReadonlyArray<{ readonly image: string }>;
}): ReadonlyArray<string> => [
  ...new Set(
    serviceImages(cartridge).map((image) => image.replace(/@.*$/, "").replace(/:[^/:]+$/, "")),
  ),
];

/**
 * The cartridge file's text with every service image replaced by `pinned`. The app's own
 * repository keeps naming its image without a digest; the host records the pinned copy.
 */
export const pinCartridgeText = (
  text: string,
  cartridge: { readonly services: ReadonlyArray<{ readonly image: string }> },
  pinned: string,
) =>
  serviceImages(cartridge).reduce(
    (contents, reference) => contents.replaceAll(`"${reference}"`, `"${pinned}"`),
    text,
  );
