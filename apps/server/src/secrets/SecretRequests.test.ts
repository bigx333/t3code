import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ThreadSecretName,
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadSecrets from "./ThreadSecrets.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const name = ThreadSecretName.make("GITHUB_TOKEN");
const projectId = ProjectId.make("project-1");
const save = { threadId, turnItemId, answer: { type: "save", secret: "ghp_private" } } as const;
const decline = { threadId, turnItemId, answer: { type: "decline" } } as const;

const withService = <A, E>(
  body: (input: {
    service: SecretRequests.SecretRequests["Service"];
    secrets: ThreadSecrets.ThreadSecrets["Service"];
    store: ServerSecretStore.ServerSecretStore["Service"];
    dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E>,
  options: {
    legacy?: boolean;
    failedRecords?: number;
    runStatus?: string;
    owner?: "deleted" | "missing";
  } = {},
) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let status = "pending";
    let failedRecords = options.failedRecords ?? 0;
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: { projectId },
          runs: [{ id: "run-1", status: options.runStatus ?? "running" }],
          turnItems: [
            {
              id: turnItemId,
              threadId,
              runId: "run-1",
              nodeId: "root",
              type: "secret_request",
              ...(options.legacy ? {} : { name }),
              label: "GitHub",
              reason: "For GitHub access",
              secretStatus: status,
            },
          ],
        } as never),
      dispatch: (command) =>
        Effect.suspend(() => {
          if (failedRecords-- > 0)
            return Effect.fail(new Error("orchestrator unavailable") as never);
          dispatched.push(command);
          if (command.type === "secret_request.record" && status === "pending")
            status = command.secretStatus;
          return Effect.succeed({} as never);
        }),
    });
    const store = yield* ServerSecretStore.ServerSecretStore;
    yield* store.set("secret-request-salt", new Uint8Array([7]));
    yield* store.set("secret-request-legacy", new Uint8Array([8]));
    const secretsLayer = ThreadSecrets.layer;
    const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: () =>
        options.owner === "missing"
          ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
          : Effect.succeed({
              thread: { deletedAt: options.owner === "deleted" ? "2026-01-01T00:00:00Z" : null },
            } as never),
    });
    return yield* Effect.gen(function* () {
      return yield* body({
        service: yield* SecretRequests.SecretRequests,
        secrets: yield* ThreadSecrets.ThreadSecrets,
        store,
        dispatched,
      });
    }).pipe(
      Effect.provide(
        SecretRequests.layer.pipe(
          Layer.provide(threads),
          Layer.provide(projections),
          Layer.provideMerge(secretsLayer),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-request-test-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it.effect("save installs the named secret and only records metadata", () =>
  withService(({ service, secrets, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer(save);
      assert.equal(Option.getOrThrow(yield* secrets.get(threadId, name)), "ghp_private");
      assert.deepEqual((yield* secrets.list(threadId))[0]?.threadId, threadId);
      assert.equal(dispatched.length, 1);
      assert.include(dispatched[0], { type: "secret_request.record", secretStatus: "saved", name });
      assert.notInclude(JSON.stringify(dispatched), "ghp_private");
      assert.notInclude(JSON.stringify(yield* secrets.list(threadId)), "ghp_private");
    }),
  ),
);
it.effect.each(["deleted", "missing"] as const)(
  "rejects Settings replacements and card saves for a %s thread",
  (owner) =>
    withService(
      ({ service, secrets, dispatched }) =>
        Effect.gen(function* () {
          yield* service
            .saveForThread({ threadId, name, label: "Settings", value: "orphan" })
            .pipe(Effect.flip);
          assert.equal((yield* service.answer(save).pipe(Effect.flip)).reason, "store_failed");
          assert.deepEqual(yield* secrets.list(), []);
          assert.deepEqual(yield* secrets.environment(threadId), {});
          assert.equal(yield* secrets.revision(threadId), 0);
          assert.deepEqual(dispatched, []);
        }),
      { owner },
    ),
);
it.effect("a pending card remains answerable after its run completes", () =>
  withService(
    ({ service, secrets }) =>
      Effect.gen(function* () {
        yield* service.answer(save);
        assert.equal(Option.getOrThrow(yield* secrets.get(threadId, name)), "ghp_private");
      }),
    { runStatus: "completed" },
  ),
);
it.effect("decline stores no value and answers only once", () =>
  withService(({ service, secrets, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer(decline);
      assert.deepEqual(yield* secrets.list(threadId), []);
      assert.equal((yield* service.answer(save).pipe(Effect.flip)).reason, "already_answered");
      assert.equal(dispatched.length, 1);
      assert.include(dispatched[0], { secretStatus: "declined" });
    }),
  ),
);
it.effect("concurrent answers install only the first answer", () =>
  withService(({ service, secrets, dispatched }) =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [save, { ...save, answer: { type: "save", secret: "second" } } as const].map((input) =>
          service.answer(input).pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(dispatched.length, 1);
      assert.equal(yield* secrets.revision(threadId), 1);
    }),
  ),
);
it.effect("saving nameless legacy cards is rejected", () =>
  withService(
    ({ service, secrets }) =>
      Effect.gen(function* () {
        assert.equal((yield* service.answer(save).pipe(Effect.flip)).reason, "legacy_request");
        assert.deepEqual(yield* secrets.list(threadId), []);
      }),
    { legacy: true },
  ),
);
it.effect("record retries preserve a newer replacement and the original answer", () =>
  withService(
    ({ service, secrets, dispatched }) =>
      Effect.gen(function* () {
        assert.equal((yield* service.answer(save).pipe(Effect.flip)).reason, "record_failed");
        assert.equal(Option.getOrThrow(yield* secrets.get(threadId, name)), "ghp_private");
        yield* secrets.set({
          threadId,
          name,
          label: "Settings replacement",
          value: "newer-private",
        });
        yield* service.answer(decline);
        assert.equal(Option.getOrThrow(yield* secrets.get(threadId, name)), "newer-private");
        assert.equal(yield* secrets.revision(threadId), 2);
        assert.include(dispatched[0], { secretStatus: "saved" });
      }),
    { failedRecords: 1 },
  ),
);
it.effect("startup removes legacy values and salt without removing named secrets", () =>
  withService(({ store }) =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* store.get("secret-request-salt")));
      assert.isTrue(Option.isNone(yield* store.get("secret-request-legacy")));
    }),
  ),
);

it.effect("unnamed legacy cards can be declined without storing a value or a name", () =>
  withService(
    ({ service, secrets, dispatched }) =>
      Effect.gen(function* () {
        yield* service.answer(decline);
        assert.deepEqual(yield* secrets.list(threadId), []);
        assert.include(dispatched[0], { secretStatus: "declined" });
        assert.notProperty(dispatched[0], "name");
        assert.equal((yield* service.answer(decline).pipe(Effect.flip)).reason, "already_answered");
      }),
    { legacy: true },
  ),
);
