import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { applyManagedKeys } from "./EnvFile.ts";

describe("applyManagedKeys", () => {
  it("replaces only managed keys and keeps comments and other lines", () => {
    const before = [
      "# keep me",
      "NODE_ENV=development",
      "DATABASE_URL=old",
      "AUTH_DATABASE_URL=old-auth",
      "SECRET=leave",
      "",
    ].join("\n");
    const after = applyManagedKeys(before, {
      DATABASE_URL: "new",
      AUTH_DATABASE_URL: "new-auth",
    });
    assert.equal(
      after,
      [
        "# keep me",
        "NODE_ENV=development",
        "DATABASE_URL=new",
        "AUTH_DATABASE_URL=new-auth",
        "SECRET=leave",
        "",
      ].join("\n"),
    );
  });

  it("appends missing managed keys and preserves export prefixes", () => {
    const before = "export DATABASE_URL=old\n";
    assert.equal(
      applyManagedKeys(before, {
        DATABASE_URL: "new",
        AUTH_DATABASE_URL: "auth",
      }),
      "export DATABASE_URL=new\nAUTH_DATABASE_URL=auth\n",
    );
  });

  it("is a no-op when values already match", () => {
    const contents = "DATABASE_URL=same\n";
    assert.equal(applyManagedKeys(contents, { DATABASE_URL: "same" }), contents);
  });

  it("matches keys with optional spaces around = without appending a duplicate", () => {
    const before = "DATABASE_URL = old\nAUTH_DATABASE_URL= still-old\n";
    assert.equal(
      applyManagedKeys(before, {
        DATABASE_URL: "new",
        AUTH_DATABASE_URL: "new-auth",
      }),
      "DATABASE_URL=new\nAUTH_DATABASE_URL=new-auth\n",
    );
  });

  it("strips ROOT_DATABASE_* keys while writing managed updates", () => {
    const before = [
      "ROOT_DATABASE_URL=postgres://postgres@localhost/template1",
      "ROOT_DATABASE_PASSWORD=secret",
      "DATABASE_URL=old",
      "KEEP=yes",
      "",
    ].join("\n");
    assert.equal(
      applyManagedKeys(before, { DATABASE_URL: "new", SHADOW_DATABASE_URL: "shadow" }),
      ["DATABASE_URL=new", "KEEP=yes", "SHADOW_DATABASE_URL=shadow", ""].join("\n"),
    );
  });
});
