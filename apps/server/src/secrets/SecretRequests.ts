import {
  CommandId,
  SecretRequestError,
  ThreadSecretError,
  type SecretRequestAnswerInput,
  type ThreadId,
  type ThreadSecretName,
  type ThreadSecretSetInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadSecrets from "./ThreadSecrets.ts";

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    readonly saveForThread: (input: ThreadSecretSetInput) => Effect.Effect<void, ThreadSecretError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const secrets = yield* ThreadSecrets.ThreadSecrets;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const assertLiveThread = Effect.fn("SecretRequests.assertLiveThread")(function* (
    threadId: ThreadId,
    name: ThreadSecretName,
  ) {
    const records = yield* projections
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError((cause) => new ThreadSecretError({ operation: "set", name, cause })));
    if (records.thread.deletedAt !== null) {
      return yield* new ThreadSecretError({
        operation: "set",
        name,
        cause: new Error("The thread has been deleted."),
      });
    }
  });
  const saveForThread = Effect.fn("SecretRequests.saveForThread")(function* (
    input: ThreadSecretSetInput,
  ) {
    yield* secrets.set(input, assertLiveThread(input.threadId, input.name));
  });
  if (store.directory !== undefined) {
    yield* Effect.gen(function* () {
      const files = yield* fs.readDirectory(store.directory!);
      let removed = 0;
      let failed = 0;
      for (const file of files) {
        if (!file.startsWith("secret-request-") || !file.endsWith(".bin")) continue;
        const deleted = yield* store.remove(file.slice(0, -4)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (deleted) removed += 1;
        else failed += 1;
      }
      yield* Effect.logInfo("Removed legacy secret request entries", { removed, failed });
    }).pipe(
      Effect.catch(() => Effect.logWarning("Could not remove legacy secret request entries")),
    );
  }
  const lock = yield* Semaphore.make(1);
  // Retrying a failed record must finish the original answer without overwriting
  // a newer value saved through Settings or a different card.
  const unrecorded = new Map<string, "saved" | "declined">();
  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const records = yield* threads
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* new SecretRequestError({ reason: "not_found" });
      }
      if (item.name === undefined && input.answer.type === "save")
        return yield* new SecretRequestError({ reason: "legacy_request" });
      if (item.secretStatus !== "pending")
        return yield* new SecretRequestError({ reason: "already_answered" });
      const retry = unrecorded.get(item.id);
      const secretStatus = retry ?? (input.answer.type === "save" ? "saved" : "declined");
      if (retry === undefined) {
        if (input.answer.type === "save" && item.name !== undefined) {
          yield* saveForThread({
            threadId: input.threadId,
            name: item.name,
            label: item.label,
            description: item.reason,
            value: input.answer.secret,
          }).pipe(
            Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
          );
        }
        unrecorded.set(item.id, secretStatus);
      }
      // A named value can already have been replaced. Failed records retain it;
      // deterministic command IDs make a repeated record safe after a lost reply.
      yield* threads
        .dispatch({
          type: "secret_request.record",
          commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          ...(item.name === undefined ? {} : { name: item.name }),
          label: item.label,
          reason: item.reason,
          ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
          secretStatus,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        );
      unrecorded.delete(item.id);
      yield* Metrics.increment(Metrics.secretRequestsTotal, { status: secretStatus });
    },
    lock.withPermits(1),
    Effect.uninterruptible,
  );
  return SecretRequests.of({ answer, saveForThread });
});

export const layer = Layer.effect(SecretRequests, make);
