import { expect, it } from "@effect/vitest";
import { nextAvailablePort } from "./DeployMeta.ts";

it("reuses a port only after its stage row is removed", () => {
  const stageRows = new Set([3001, 3002]);
  expect(nextAvailablePort(stageRows)).toBe(3003);

  stageRows.delete(3001);
  expect(nextAvailablePort(stageRows)).toBe(3001);
});
