import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { presign } from "./Presign.ts";

const credentials = { accessKeyId: "GKexample", secretAccessKey: "s3cr3t/key+example" };
// The test runner is Bun; the project carries no Bun type definitions, so name the one API used.
declare const Bun: {
  S3Client: new (options: Record<string, string>) => {
    presign: (object: string, options: { expiresIn: number; method: string }) => string;
  };
};

describe("presign", () => {
  it("signs the way Bun's S3 client does, for path-style requests", () => {
    const client = new Bun.S3Client({
      ...credentials,
      endpoint: "http://10.0.0.2:3900",
      bucket: "builds",
      region: "garage",
    });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const theirs = new URL(client.presign("7-tree.tar", { expiresIn: 600, method }));
      const now = new Date(
        theirs.searchParams
          .get("X-Amz-Date")!
          .replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"),
      );
      const ours = new URL(
        presign({
          method,
          endpoint: "http://10.0.0.2:3900",
          region: "garage",
          bucket: "builds",
          object: "7-tree.tar",
          ...credentials,
          expiresSeconds: 600,
          now,
        }),
      );
      assert.equal(ours.origin + ours.pathname, theirs.origin + theirs.pathname);
      assert.equal(
        ours.searchParams.get("X-Amz-Signature"),
        theirs.searchParams.get("X-Amz-Signature"),
      );
    }
  });
});
