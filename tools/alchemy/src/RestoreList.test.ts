import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterAclRestoreList, filterRestoreList, remapAclRoles } from "./RestoreList.ts";

// Entry lines in the format `pg_restore -l` writes, from a postgres:17 dump.
const list = [
  "3; 1259 16384 TABLE public foo postgres",
  "4; 0 0 COMMENT - EXTENSION plpgsql postgres",
  "5; 0 0 ACL - SCHEMA app source_owner",
  "6; 826 16398 DEFAULT ACL app DEFAULT PRIVILEGES FOR TABLES source_owner",
].join("\n");

describe("filterRestoreList", () => {
  it("keeps the objects and drops ACL entries and extension comments", () => {
    assert.equal(filterRestoreList(list), "3; 1259 16384 TABLE public foo postgres");
  });
});

describe("filterAclRestoreList", () => {
  it("selects ACL and DEFAULT ACL entries only", () => {
    assert.equal(
      filterAclRestoreList(list),
      [
        "5; 0 0 ACL - SCHEMA app source_owner",
        "6; 826 16398 DEFAULT ACL app DEFAULT PRIVILEGES FOR TABLES source_owner",
      ].join("\n"),
    );
  });
});

describe("remapAclRoles", () => {
  it("replaces whole role identifiers, bare or quoted, and nothing that only contains one", () => {
    assert.equal(
      remapAclRoles(
        'ALTER DEFAULT PRIVILEGES FOR ROLE source_owner GRANT SELECT ON TABLES TO "source_owner"; -- source_ownerish',
        "source_owner",
        "target_owner",
      ),
      'ALTER DEFAULT PRIVILEGES FOR ROLE "target_owner" GRANT SELECT ON TABLES TO "target_owner"; -- source_ownerish',
    );
  });
});
