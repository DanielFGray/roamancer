/**
 * AWS Signature Version 4 query signing for path-style S3 requests (Garage). A signed URL lets
 * a holder run one request on one object until it expires, without holding the key.
 */
import { createHash, createHmac } from "node:crypto";

export interface PresignInput {
  readonly method: "GET" | "PUT" | "DELETE";
  /** `http://host:port`, with no path. The Host header is signed, so callers must use this exact origin. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** The object name, without a leading slash. */
  readonly object: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly expiresSeconds: number;
  readonly now: Date;
}

/** The URL, with the signature in its query. */
export const presign = (input: PresignInput): string => {
  const url = new URL(input.endpoint);
  const stamp = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const path = `/${input.bucket}/${input.object.split("/").map(encode).join("/")}`;
  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(input.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n");
  const key = [day, input.region, "s3", "aws4_request"].reduce(
    (secret, part) => hmac(secret, part),
    `AWS4${input.secretAccessKey}` as string | Buffer,
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `${url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};

/** RFC 3986 percent-encoding, which S3 signing requires and `encodeURIComponent` does not give. */
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
