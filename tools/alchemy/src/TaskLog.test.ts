import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as Result from "effect/Result";
import { parse } from "./TaskLog.ts";

describe("task log lines", () => {
  it("reads the time and text, and names the task", () => {
    assert.deepEqual(
      parse("server")('2026-10-24T02:52:58.036611316+00:00 stdout F   "http.status": 200,'),
      Result.succeed({
        timestamp: new Date("2026-10-24T02:52:58.036Z"),
        message: 'server:   "http.status": 200,',
      }),
    );
  });

  it("marks standard error", () => {
    assert.deepEqual(
      parse("migrate")("2026-10-24T02:52:58Z stderr P relation exists"),
      Result.succeed({
        timestamp: new Date("2026-10-24T02:52:58Z"),
        message: "migrate stderr: relation exists",
      }),
    );
  });

  it("rejects a line cut off before its prefix", () => {
    assert.deepEqual(
      parse("server")("611316+00:00 stdout F x"),
      Result.fail("611316+00:00 stdout F x"),
    );
  });
});
