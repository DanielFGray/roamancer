import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { configPaths } from "../lib/config-values.ts";
import {
  deploymentNames,
  deploymentPaths,
  previewHost,
  previewUrl,
  worktreeParent,
} from "../lib/deployment.ts";
import { SshClient } from "../services/SshClient.ts";
import { makeTestServices, testLayers } from "./layers.ts";

it.effect("provides replaceable deployment boundaries", () => {
  const state = makeTestServices();
  return Effect.gen(function* () {
    const ssh = yield* SshClient;
    yield* ssh.exec("test-host", "true");
    expect(state.calls.ssh).toEqual([{ host: "test-host", command: "true" }]);
  }).pipe(Effect.provide(testLayers(state)));
});

it("builds isolated paths from explicit input", () => {
  expect(configPaths("/tmp/one").configHome).toBe("/tmp/one/.config/infra");
  expect(configPaths("/tmp/two").configHome).toBe("/tmp/two/.config/infra");
});

it("keeps worktrees separate from service artifacts", () => {
  const paths = deploymentPaths("demo", "main", {
    projects: "/tmp/projects",
    staticFiles: "/tmp/www",
  });

  expect(paths.worktree).toBe("/tmp/projects/demo/worktrees/main");
  expect(worktreeParent("demo", { projects: "/tmp/projects", staticFiles: "/tmp/www" })).toBe(
    "/tmp/projects/demo/worktrees",
  );
  expect(paths.service).toBe("/tmp/projects/demo/stages/main");
  expect(paths.serviceCandidate).toBe("/tmp/projects/demo/stages/main.new");
  expect(paths.worktree).not.toBe(paths.service);
});

it("derives deployment names and preview addresses from stage identity", () => {
  expect(deploymentNames("demo", "main")).toEqual({
    serviceUnit: "infra-demo-main",
    candidateUnit: "infra-demo-main-new",
    stageSnippet: "infra--demo--stage--main.caddyfile",
    productionSnippet: "infra--demo--production.caddyfile",
  });
  expect(previewHost("abc123", "demo.example")).toBe("abc123-preview.demo.example");
  expect(previewUrl("abc123", "demo.example")).toBe("https://abc123-preview.demo.example");
});
