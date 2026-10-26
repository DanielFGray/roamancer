import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { sameImageDigest } from "./ReleaseImage.ts";

describe("staged promotion image identity", () => {
  it("matches immutable digests across tagged and pinned references", () => {
    assert.equal(
      sameImageDigest(
        "registry.example/app:abc123@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "registry.example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
      true,
    );
  });

  it("refuses a different or missing digest", () => {
    assert.equal(
      sameImageDigest(
        "registry.example/app:abc123@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "registry.example/app:abc123@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
      false,
    );
    assert.equal(
      sameImageDigest("registry.example/app:abc123", "registry.example/app:abc123"),
      false,
    );
    assert.equal(sameImageDigest("registry.example/app@", "registry.example/app@"), false);
    assert.equal(sameImageDigest("app@sha256:abc", "app@sha256:abc"), false);
  });
});
