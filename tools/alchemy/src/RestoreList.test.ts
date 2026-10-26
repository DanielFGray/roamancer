import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { objectRestoreList, roleRestoreList, remapRoles } from "./RestoreList.ts";

// Entry lines in the format `pg_restore -l` writes, from a postgres:17 dump.
const list = [
  "3; 1259 16384 TABLE public foo postgres",
  "4; 0 0 COMMENT - EXTENSION plpgsql postgres",
  "5; 0 0 ACL - SCHEMA app source_owner",
  "6; 826 16398 DEFAULT ACL app DEFAULT PRIVILEGES FOR TABLES source_owner",
  "7; 0 0 POLICY public foo my_policy source_owner",
].join("\n");

describe("objectRestoreList", () => {
  it("keeps the objects and drops role-bearing entries and extension comments", () => {
    assert.equal(objectRestoreList(list), "3; 1259 16384 TABLE public foo postgres");
  });
});

describe("roleRestoreList", () => {
  it("selects ACL, DEFAULT ACL and POLICY entries only", () => {
    assert.equal(
      roleRestoreList(list),
      [
        "5; 0 0 ACL - SCHEMA app source_owner",
        "6; 826 16398 DEFAULT ACL app DEFAULT PRIVILEGES FOR TABLES source_owner",
        "7; 0 0 POLICY public foo my_policy source_owner",
      ].join("\n"),
    );
  });
});

describe("remapRoles", () => {
  it("replaces whole role identifiers, bare or quoted, and nothing that only contains one", () => {
    assert.equal(
      remapRoles(
        'ALTER DEFAULT PRIVILEGES FOR ROLE source_owner GRANT SELECT ON TABLES TO "source_owner"; -- source_ownerish',
        "source_owner",
        "target_owner",
      ),
      'ALTER DEFAULT PRIVILEGES FOR ROLE "target_owner" GRANT SELECT ON TABLES TO "target_owner"; -- source_ownerish',
    );
  });
});
