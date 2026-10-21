import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, ThreadSecretError, ThreadSecretName } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadSecrets from "./ThreadSecrets.ts";

const threadId = ThreadId.make("thread-a");
const otherThreadId = ThreadId.make("thread-b");
const name = ThreadSecretName.make("GITHUB_TOKEN");
const layerStore = ServerSecretStore.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-env-secrets-test-" })),
);

it.effect("a rejected owner check leaves no file, environment value or revision", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const fs = yield* FileSystem.FileSystem;
    const before = yield* fs.readDirectory(store.directory!);
    yield* Effect.gen(function* () {
      const secrets = yield* ThreadSecrets.ThreadSecrets;
      yield* secrets
        .set(
          { threadId, name, label: "Stale", value: "orphan-secret" },
          Effect.fail(new ThreadSecretError({ operation: "set", name, cause: "deleted thread" })),
        )
        .pipe(Effect.flip);
      assert.deepEqual(yield* secrets.list(), []);
      assert.deepEqual(yield* secrets.environment(threadId), {});
      assert.equal(yield* secrets.revision(threadId), 0);
      assert.deepEqual(yield* fs.readDirectory(store.directory!), before);
    }).pipe(Effect.provide(ThreadSecrets.layer));
  }).pipe(Effect.provide(layerStore.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("startup ignores an old environment entry even when its removal fails", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const legacy = "environment-secret-GITHUB_TOKEN";
    yield* store.set(legacy, new TextEncoder().encode("old-secret"));
    const blockedStore = Layer.succeed(ServerSecretStore.ServerSecretStore, {
      ...store,
      remove: (entry) =>
        entry === legacy
          ? Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({
                resource: entry,
                cause: new Error("access denied"),
              }),
            )
          : store.remove(entry),
    });
    yield* Effect.gen(function* () {
      const secrets = yield* ThreadSecrets.ThreadSecrets;
      assert.deepEqual(yield* secrets.list(), []);
      assert.deepEqual(yield* secrets.environment(threadId), {});
      assert.deepEqual(yield* secrets.redactionValues(), []);
      yield* secrets.set({ threadId, name, label: "Current", value: "new-secret" });
      assert.deepEqual(yield* secrets.environment(threadId), { GITHUB_TOKEN: "new-secret" });
      assert.isTrue(Option.isSome(yield* store.get(legacy)));
    }).pipe(Effect.provide(ThreadSecrets.layer.pipe(Layer.provide(blockedStore))));
  }).pipe(Effect.provide(layerStore.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "persists thread secrets, isolates same names, and drops retired values immediately",
  () =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const serviceLayer = () =>
        ThreadSecrets.layer.pipe(
          Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, store)),
        );
      yield* Effect.gen(function* () {
        const secrets = yield* ThreadSecrets.ThreadSecrets;
        assert.equal(yield* secrets.revision(threadId), 0);
        yield* secrets.set({ threadId, name, label: "GitHub", value: "first-secret" });
        const [first] = yield* secrets.list(threadId);
        assert.isDefined(first);
        assert.notInclude(JSON.stringify(first), "first-secret");
        assert.deepEqual(yield* secrets.environment(threadId), { GITHUB_TOKEN: "first-secret" });
        yield* TestClock.adjust("1 second");
        yield* secrets.set({ threadId, name, label: "Rotated", value: "second-secret" });
        const [second] = yield* secrets.list(threadId);
        assert.equal(second?.createdAt, first?.createdAt);
        assert.notEqual(second?.updatedAt, first?.updatedAt);
        assert.equal(Option.getOrThrow(yield* secrets.get(threadId, name)), "second-secret");
        assert.sameMembers(Array.from(yield* secrets.redactionValues(threadId)), ["second-secret"]);
        yield* secrets.remove(threadId, name);
        assert.deepEqual(yield* secrets.list(threadId), []);
        assert.isTrue(Option.isNone(yield* secrets.get(threadId, name)));
        assert.deepEqual(yield* secrets.environment(threadId), {});
        assert.equal(yield* secrets.revision(threadId), 3);
        assert.deepEqual(yield* secrets.redactionValues(threadId), []);
        yield* secrets.set({ threadId, name, label: "Persisted", value: "third-secret" });
        yield* secrets.set({
          threadId: otherThreadId,
          name,
          label: "Other",
          value: "other-secret",
        });
        assert.equal(Option.getOrThrow(yield* secrets.get(threadId, name)), "third-secret");
        assert.equal(Option.getOrThrow(yield* secrets.get(otherThreadId, name)), "other-secret");
        assert.equal((yield* secrets.list()).length, 2);
        const longThreadId = ThreadId.make("long-" + "x".repeat(1000));
        const longName = ThreadSecretName.make("X".repeat(128));
        yield* secrets.set({
          threadId: longThreadId,
          name: longName,
          label: "Long",
          value: "long-secret",
        });
        assert.equal(Option.getOrThrow(yield* secrets.get(longThreadId, longName)), "long-secret");
        yield* secrets.removeThread(longThreadId);
      }).pipe(Effect.provide(serviceLayer()));
      yield* store.set("environment-secret-BROKEN", new TextEncoder().encode("invalid JSON"));
      yield* store.set("environment-secret-PATH", new TextEncoder().encode("{}"));
      yield* store.set(
        "environment-secret-OPENAI_API_KEY",
        new TextEncoder().encode(
          JSON.stringify({
            name: "OPENAI_API_KEY",
            label: "Old credential",
            value: "reserved-private",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const secrets = yield* ThreadSecrets.ThreadSecrets;
        assert.equal(Option.getOrThrow(yield* secrets.get(threadId, name)), "third-secret");
        assert.deepEqual(
          (yield* secrets.list(threadId)).map((entry) => entry.name),
          [name],
        );
        assert.deepEqual(yield* secrets.redactionValues(threadId), ["third-secret"]);
        assert.equal(yield* secrets.revision(threadId), 0);
        yield* secrets.removeThread(threadId);
        assert.deepEqual(yield* secrets.list(threadId), []);
        assert.isTrue(Option.isNone(yield* secrets.get(threadId, name)));
        assert.equal(Option.getOrThrow(yield* secrets.get(otherThreadId, name)), "other-secret");
        for (const legacy of ["BROKEN", "PATH", "OPENAI_API_KEY"]) {
          assert.isTrue(Option.isNone(yield* store.get(`environment-secret-${legacy}`)));
        }
      }).pipe(Effect.provide(serviceLayer()));
    }).pipe(Effect.provide(layerStore.pipe(Layer.provideMerge(NodeServices.layer)))),
);
