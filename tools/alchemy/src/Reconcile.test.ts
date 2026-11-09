import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, type FileSystem, Layer, Option, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { BuildStore } from "./BuildStore.ts";
import { Nomad, type AllocationSummary } from "./Nomad.ts";
import * as Policy from "./Policy.ts";
import {
  decide,
  fetchHead,
  ReleaseFailed,
  reconcileApp,
  remoteHead,
  type ReconcileDeps,
} from "./Reconcile.ts";
import { Registry } from "./Registry.ts";
import { layer as storeLayer, Store } from "./queue/Store.ts";

const digest = `sha256:${"d".repeat(64)}`;

describe("decide", () => {
  const base = {
    deploy: "auto" as Policy.Deploy,
    tree: "t2",
    triedTree: "t1" as string | null,
    signedOff: true,
    tokenValid: true,
  };
  const cases: ReadonlyArray<readonly [string, Partial<typeof base>, string]> = [
    ["a new, signed-off tree with a token releases", {}, "release"],
    ["the first tree ever releases", { triedTree: null }, "release"],
    ["the tree already tried waits for the next push", { tree: "t1" }, "tried"],
    ["a tried tree stays tried without a signoff", { tree: "t1", signedOff: false }, "tried"],
    ["a new tree with no signoff waits for one", { signedOff: false }, "signoff"],
    ["no signoff outranks no token", { signedOff: false, tokenValid: false }, "signoff"],
    ["a signed-off tree with no token waits for a login", { tokenValid: false }, "login"],
    ["manual never releases", { deploy: "manual" }, "manual"],
    [
      "manual outranks every other fact",
      { deploy: "manual", tree: "t1", signedOff: false },
      "manual",
    ],
  ];
  for (const [name, patch, expected] of cases) {
    it(name, () => assert.equal(decide({ ...base, ...patch }), expected));
  }
});

describe("Policy", () => {
  const decode = (apps: unknown) =>
    Effect.runPromise(Effect.result(Policy.decode(JSON.stringify({ apps }))));

  it("defaults deploy to auto and lists apps by name", async () => {
    const result = await decode({
      b: { repository: "git@github.com:me/b.git" },
      a: { repository: "ssh://git@github.com/me/a.git", deploy: "manual" },
    });
    if (result._tag !== "Success") return assert.fail("the policy should decode");
    const policy = result.success;
    assert.deepEqual(
      Policy.apps(policy).map((entry) => [entry.app, entry.deploy]),
      [
        ["a", "manual"],
        ["b", "auto"],
      ],
    );
    assert.deepEqual(
      Policy.autoApps(policy).map((entry) => entry.app),
      ["b"],
    );
  });

  it("refuses a repository that is not an ssh URL, a name that is a path, and a bad deploy", async () => {
    for (const apps of [
      { a: { repository: "https://github.com/me/a.git" } },
      { a: { repository: "file:///tmp/a" } },
      { a: { repository: "--upload-pack=x" } },
      { "../a": { repository: "git@github.com:me/a.git" } },
      { a: { repository: "git@github.com:me/a.git", deploy: "sometimes" } },
    ]) {
      assert.equal((await decode(apps))._tag, "Failure", JSON.stringify(apps));
    }
  });
});

/** A scratch folder with a git repository whose `main` a test advances, as a `file://` remote. */
const origin = () => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-"));
  const repo = join(root, "origin.git");
  const work = join(root, "work");
  const git = (cwd: string, ...args: Array<string>) => {
    const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  mkdirSync(work);
  git(root, "init", "--bare", "--quiet", "-b", "main", repo);
  git(work, "init", "--quiet", "-b", "main");
  git(work, "remote", "add", "origin", repo);
  const push = (message: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", message);
    git(work, "push", "--quiet", "origin", "main");
    return { commit: git(work, "rev-parse", "HEAD"), tree: git(work, "rev-parse", "HEAD^{tree}") };
  };
  return { root, url: `file://${repo}`, push, git: (...args: Array<string>) => git(work, ...args) };
};

const cartridge = (image: string, name = "shop") =>
  JSON.stringify({
    apiVersion: "server-ansible/v2",
    name,
    services: [
      {
        name,
        image,
        hostPort: "dynamic",
        containerPort: 8080,
        cpu: 100,
        memoryMB: 128,
        networkMode: "bridge",
        environment: [],
        connections: [],
        secrets: [],
      },
    ],
  });

const runtime = BunServices.layer;

describe("fetching main", () => {
  it("reads the head of main, fetches it into a bare cache, and fetches only what is new later", async () => {
    const repo = origin();
    try {
      const cache = join(repo.root, "cache", "shop.git");
      assert.equal(
        Option.isNone(
          await Effect.runPromise(remoteHead(repo.url, {}).pipe(Effect.provide(runtime))),
        ),
        true,
        "an empty repository has no main",
      );

      const first = repo.push("one", { "a.txt": "1" });
      const head = await Effect.runPromise(remoteHead(repo.url, {}).pipe(Effect.provide(runtime)));
      assert.equal(Option.getOrNull(head), first.commit);
      const fetched = await Effect.runPromise(
        fetchHead(cache, repo.url, {}).pipe(Effect.provide(runtime)),
      );
      assert.deepEqual(fetched, first);

      const second = repo.push("two", { "a.txt": "2" });
      const again = await Effect.runPromise(
        fetchHead(cache, repo.url, {}).pipe(Effect.provide(runtime)),
      );
      assert.deepEqual(again, second);
      assert.notEqual(second.tree, first.tree);
      // The cache holds the history, so the repository's root commit is known.
      const roots = spawnSync("git", ["-C", cache, "rev-list", "--max-parents=0", second.commit], {
        encoding: "utf8",
      }).stdout.trim();
      assert.equal(roots, first.commit);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});

/** Methods a reconcile never calls fail the test loudly instead of returning a stand-in. */
const unused =
  <Args extends ReadonlyArray<unknown>>(name: string) =>
  (..._args: Args) =>
    Effect.die(`Nomad.${name} is not part of reconcile`);

const unusedNomad = {
  jobs: unused("jobs"),
  job: unused("job"),
  plan: unused("plan"),
  planRelease: unused("planRelease"),
  register: unused("register"),
  registerRelease: unused("registerRelease"),
  deployment: unused("deployment"),
  service: unused("service"),
  allocation: unused("allocation"),
  allocationChecks: unused("allocationChecks"),
  evaluate: unused("evaluate"),
  placedAllocations: unused("placedAllocations"),
  nodes: unused("nodes"),
  nodeStats: unused("nodeStats"),
};

/** A harness for `reconcileApp` over a real queue store and fakes for Nomad, Garage and the registry. */
const harness = () => {
  const repo = origin();
  const root = repo.root;
  const calls = {
    uploaded: [] as Array<string>,
    planned: [] as Array<string>,
    deployed: [] as Array<{ app: string; env: Record<string, string>; cartridge: string }>,
    registered: 0,
  };
  const knobs = { token: true, deployFails: false, buildDigest: digest };
  const allocation: AllocationSummary = {
    ID: "alloc-1",
    TaskGroup: "build",
    DesiredStatus: "run",
    ClientStatus: "complete",
    JobVersion: 0,
    CreateTime: 0,
    TaskStates: { buildah: { State: "dead", Failed: false, Restarts: 0, Events: [] } },
  };
  const nomad = Nomad.of({
    ...unusedNomad,
    followLogs: () => Stream.die("Nomad.followLogs is not part of reconcile"),
    registerBatch: () =>
      Effect.sync(() => (calls.registered += 1)).pipe(
        Effect.as({ EvalID: "e", JobModifyIndex: 1 }),
      ),
    allocations: () => Effect.succeed([allocation]),
    evaluations: () => Effect.succeed([]),
    logs: (_id, _task, stream) =>
      Effect.succeed(
        stream === "stdout"
          ? `2026-11-09T19:20:41.834870449+00:00 stdout P ${knobs.buildDigest}`
          : "",
      ),
    stop: () => Effect.void,
  });
  const garage = BuildStore.of({
    put: (object) => Effect.sync(() => void calls.uploaded.push(object)),
    getUrl: (object) => Effect.succeed(`http://garage/${object}`),
    remove: () => Effect.void,
  });
  const registry = Registry.of({ has: () => Effect.succeed(true) });

  const policy: Policy.Policy = { apps: { shop: { repository: repo.url } } };
  const deps = (patch: Partial<ReconcileDeps> = {}): ReconcileDeps => ({
    policy,
    jobId: 11,
    cacheDir: join(root, "cache"),
    site: { registry: "registry.cluster:5000", registryCaDir: "/var/lib/registry-ca" },
    gitEnvironment: () => ({}),
    tokenValid: Effect.sync(() => knobs.token),
    stage: (command, app, env) =>
      command === "plan"
        ? Effect.sync(() => void calls.planned.push(app))
        : knobs.deployFails
          ? Effect.fail(new ReleaseFailed({ message: "alchemy deploy failed" }))
          : Effect.sync(
              () =>
                // The pinned cartridge is a temporary file that ends with the release.
                void calls.deployed.push({
                  app,
                  env,
                  cartridge: readFileSync(env["CARTRIDGE_FILE"], "utf8"),
                }),
            ),
    ...patch,
  });

  const services = Layer.mergeAll(
    Layer.succeed(Nomad, nomad),
    Layer.succeed(BuildStore, garage),
    Layer.succeed(Registry, registry),
    storeLayer(join(root, "queue.sqlite")),
  ).pipe(Layer.provideMerge(runtime));

  /** Run effects that share one store; reconcile and the store read the same database. */
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Store | BuildStore | Nomad | Registry | FileSystem.FileSystem | ChildProcessSpawner
    >,
  ) => Effect.runPromise(effect.pipe(Effect.provide(services)));
  const reconcile = (patch?: Partial<ReconcileDeps>) =>
    run(reconcileApp("shop", deps(patch)).pipe(Effect.result));
  const status = () =>
    run(
      Effect.gen(function* () {
        const row = Option.getOrThrow(yield* (yield* Store).getReconcile("shop"));
        return row;
      }),
    );
  const signOff = (tree: string, commit: string) =>
    run(
      Effect.gen(function* () {
        return (yield* (yield* Store).recordSignoff({
          app: "shop",
          tree,
          commit,
          summary: "ok",
          logSha256: "0".repeat(64),
        })).id;
      }),
    );
  return {
    repo,
    calls,
    knobs,
    reconcile,
    status,
    signOff,
    deps,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

describe("reconcileApp", () => {
  it("waits for a signoff, then for a login, then releases; none of the waits is a try", async () => {
    const h = harness();
    try {
      const main = h.repo.push("one", {
        "cartridge.json": cartridge("registry.cluster:5000/shop"),
      });

      assert.equal((await h.reconcile())._tag, "Success");
      assert.equal((await h.status()).status, "waiting-signoff");
      assert.equal((await h.status()).triedTree, null);

      const signoff = await h.signOff(main.tree, main.commit);
      h.knobs.token = false;
      assert.equal((await h.reconcile())._tag, "Success");
      assert.equal((await h.status()).status, "waiting-login");
      assert.equal((await h.status()).triedTree, null);
      assert.deepEqual(h.calls.deployed, []);

      h.knobs.token = true;
      assert.equal((await h.reconcile())._tag, "Success");
      const row = await h.status();
      assert.equal(row.status, "released");
      assert.equal(row.triedTree, main.tree);
      assert.equal(row.triedCommit, main.commit);
      assert.equal(row.triedResult, "released");
      assert.equal(row.triedJob, 11);

      // The runner's build ran, and the deploy got the pinned cartridge, its commit and signoff.
      assert.equal(h.calls.registered, 1);
      assert.deepEqual(h.calls.planned, ["shop"], "the plan runs before the deploy");
      assert.equal(h.calls.deployed.length, 1);
      const { app, env, cartridge: sent } = h.calls.deployed[0];
      assert.equal(app, "shop");
      assert.equal(env["REVISION"], main.commit);
      assert.equal(env["ORIGIN"], main.commit, "the root commit of a one-commit history");
      assert.equal(env["SIGNOFF"], String(signoff));
      const pinned = JSON.parse(sent);
      assert.equal(pinned.services[0].image, `registry.cluster:5000/shop@${digest}`);
    } finally {
      h.cleanup();
    }
  });

  it("does nothing more for the tree it released, and releases the next signed-off tree without a rebuild of the old one", async () => {
    const h = harness();
    try {
      const one = h.repo.push("one", { "cartridge.json": cartridge("registry.cluster:5000/shop") });
      await h.signOff(one.tree, one.commit);
      await h.reconcile();
      await h.reconcile();
      await h.reconcile();
      assert.equal(h.calls.deployed.length, 1, "a quiet main releases once");
      assert.equal((await h.status()).status, "released");

      const two = h.repo.push("two", { "a.txt": "x" });
      await h.reconcile();
      assert.equal((await h.status()).status, "waiting-signoff");
      await h.signOff(two.tree, two.commit);
      await h.reconcile();
      assert.equal(h.calls.deployed.length, 2);
      assert.equal(h.calls.deployed[1].env["REVISION"], two.commit);
      assert.equal(h.calls.deployed[1].env["ORIGIN"], one.commit, "origin stays the root commit");
    } finally {
      h.cleanup();
    }
  });

  it("reuses an image already recorded for the tree instead of building it", async () => {
    const h = harness();
    try {
      const main = h.repo.push("one", {
        "cartridge.json": cartridge("registry.cluster:5000/shop"),
      });
      await h.signOff(main.tree, main.commit);
      await h.run(
        Effect.gen(function* () {
          yield* (yield* Store).recordImage({
            repository: "registry.cluster:5000/shop",
            key: main.tree,
            digest,
          });
        }),
      );
      await h.reconcile();
      assert.equal(h.calls.registered, 0);
      assert.equal(h.calls.deployed.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it("records a failed deploy as a try, fails the job, and does not try that tree again", async () => {
    const h = harness();
    try {
      const main = h.repo.push("one", {
        "cartridge.json": cartridge("registry.cluster:5000/shop"),
      });
      await h.signOff(main.tree, main.commit);
      h.knobs.deployFails = true;
      const failed = await h.reconcile();
      assert.equal(failed._tag, "Failure");
      const row = await h.status();
      assert.equal(row.status, "failed");
      assert.equal(row.triedResult, "failed");
      assert.equal(row.triedTree, main.tree);
      assert.match(row.detail, /alchemy deploy failed/);

      // The next timer run finds the same tree already tried.
      h.knobs.deployFails = false;
      assert.equal((await h.reconcile())._tag, "Success");
      assert.deepEqual(h.calls.deployed, []);
      assert.equal((await h.status()).status, "failed");

      // The next push tries again.
      const next = h.repo.push("fix", { "a.txt": "fix" });
      await h.signOff(next.tree, next.commit);
      await h.reconcile();
      assert.equal(h.calls.deployed.length, 1);
      assert.equal((await h.status()).status, "released");
    } finally {
      h.cleanup();
    }
  });

  it("records a failed build as a try", async () => {
    const h = harness();
    try {
      const main = h.repo.push("one", {
        "cartridge.json": cartridge("registry.cluster:5000/shop"),
      });
      await h.signOff(main.tree, main.commit);
      h.knobs.buildDigest = "no digest here";
      const failed = await h.reconcile();
      assert.equal(failed._tag, "Failure");
      assert.equal((await h.status()).triedResult, "failed");
      assert.deepEqual(h.calls.deployed, []);
    } finally {
      h.cleanup();
    }
  });

  it("never reads a manual app's repository", async () => {
    const h = harness();
    try {
      const policy: Policy.Policy = {
        apps: { shop: { repository: "file:///does/not/exist", deploy: "manual" } },
      };
      assert.equal((await h.reconcile({ policy }))._tag, "Success");
      assert.equal((await h.status()).status, "manual");
    } finally {
      h.cleanup();
    }
  });

  it("reports an unreadable repository as an outcome, not a failed job", async () => {
    const h = harness();
    try {
      const policy: Policy.Policy = { apps: { shop: { repository: "file:///does/not/exist" } } };
      assert.equal((await h.reconcile({ policy }))._tag, "Success");
      assert.equal((await h.status()).status, "unreachable");
    } finally {
      h.cleanup();
    }
  });

  it("reports an empty repository, and refuses an app outside the policy", async () => {
    const h = harness();
    try {
      assert.equal((await h.reconcile())._tag, "Success");
      assert.equal((await h.status()).status, "no-main");
      const other = await h.run(reconcileApp("blog", h.deps()).pipe(Effect.result));
      assert.equal(other._tag, "Failure");
    } finally {
      h.cleanup();
    }
  });

  it("refuses a repository whose cartridge has another name, and records the try", async () => {
    const h = harness();
    try {
      const main = h.repo.push("one", {
        "cartridge.json": cartridge("registry.cluster:5000/shop", "blog"),
      });
      await h.signOff(main.tree, main.commit);
      const result = await h.reconcile();
      assert.equal(result._tag, "Failure");
      assert.match((await h.status()).detail, /cartridge is 'blog', not 'shop'/);
    } finally {
      h.cleanup();
    }
  });
});
