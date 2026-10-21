import {
  ThreadSecretError,
  ThreadSecretSummary,
  TrimmedNonEmptyString,
  type ThreadId,
  type ThreadSecretName,
  type ThreadSecretSetInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";

const PREFIX = "thread-secret-";
const StoredSecret = Schema.Struct({ ...ThreadSecretSummary.fields, value: TrimmedNonEmptyString });
type Entry = typeof StoredSecret.Type;
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredSecret));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredSecret));

export class ThreadSecrets extends Context.Service<
  ThreadSecrets,
  {
    readonly list: (threadId?: ThreadId) => Effect.Effect<ReadonlyArray<ThreadSecretSummary>>;
    readonly get: (
      threadId: ThreadId,
      name: ThreadSecretName,
    ) => Effect.Effect<Option.Option<string>>;
    readonly set: (
      input: ThreadSecretSetInput,
      assertOwner?: Effect.Effect<void, ThreadSecretError>,
    ) => Effect.Effect<void, ThreadSecretError>;
    readonly remove: (
      threadId: ThreadId,
      name: ThreadSecretName,
    ) => Effect.Effect<void, ThreadSecretError>;
    readonly removeThread: (threadId: ThreadId) => Effect.Effect<void, ThreadSecretError>;
    readonly environment: (threadId: ThreadId) => Effect.Effect<Record<string, string>>;
    readonly revision: (threadId: ThreadId) => Effect.Effect<number>;
    readonly redactionValues: (threadId?: ThreadId) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/secrets/ThreadSecrets") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const storeName = Effect.fn("ThreadSecrets.storeName")(function* (
    threadId: ThreadId,
    name: ThreadSecretName,
  ) {
    const hash = Hex.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(threadId)).pipe(Effect.orDie),
    );
    return `${PREFIX}${hash}-${name}`;
  });
  const entries = new Map<ThreadId, Map<ThreadSecretName, Entry>>();
  const revisions = new Map<ThreadId, number>();
  if (store.directory !== undefined) {
    const files = yield* fs.readDirectory(store.directory);
    let removed = 0;
    let failed = 0;
    for (const file of files) {
      if (!file.endsWith(".bin")) continue;
      if (file.startsWith("environment-secret-")) {
        const deleted = yield* store.remove(file.slice(0, -4)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (deleted) removed += 1;
        else failed += 1;
        continue;
      }
      if (!file.startsWith(PREFIX)) continue;
      const stored = yield* store.get(file.slice(0, -4)).pipe(Effect.orElseSucceed(Option.none));
      const entry = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (
        Option.isSome(entry) &&
        `${yield* storeName(entry.value.threadId, entry.value.name)}.bin` === file
      ) {
        const thread = entries.get(entry.value.threadId) ?? new Map<ThreadSecretName, Entry>();
        thread.set(entry.value.name, entry.value);
        entries.set(entry.value.threadId, thread);
      } else {
        yield* Effect.logWarning("Skipping an unreadable thread secret");
      }
    }
    if (removed > 0) yield* Effect.logInfo("Removed environment-scoped secrets", { removed });
    if (failed > 0)
      yield* Effect.logWarning("Could not remove some environment-scoped secrets", { failed });
  }
  const lock = yield* Semaphore.make(1);
  const bumpRevision = (threadId: ThreadId) =>
    revisions.set(threadId, (revisions.get(threadId) ?? 0) + 1);
  const set: ThreadSecrets["Service"]["set"] = Effect.fn("ThreadSecrets.set")(
    function* (input, assertOwner) {
      // Serialize the ownership check with deletion cleanup so a stale client
      // cannot recreate a secret after that cleanup has finished.
      if (assertOwner !== undefined) yield* assertOwner;
      const { threadId, name } = input;
      const thread = entries.get(threadId) ?? new Map<ThreadSecretName, Entry>();
      const previous = thread.get(name);
      const now = DateTime.formatIso(yield* DateTime.now);
      const entry = { ...input, createdAt: previous?.createdAt ?? now, updatedAt: now };
      yield* store
        .set(yield* storeName(threadId, name), new TextEncoder().encode(encodeStored(entry)))
        .pipe(Effect.mapError((cause) => new ThreadSecretError({ operation: "set", name, cause })));
      thread.set(name, entry);
      entries.set(threadId, thread);
      bumpRevision(threadId);
      yield* Effect.logInfo("Set thread secret", { threadId, name });
      yield* Metrics.increment(Metrics.threadSecretsTotal, { operation: "set" });
    },
    lock.withPermits(1),
    Effect.uninterruptible,
  );
  const removeEntry = Effect.fn("ThreadSecrets.removeEntry")(function* (
    threadId: ThreadId,
    name: ThreadSecretName,
  ) {
    yield* store
      .remove(yield* storeName(threadId, name))
      .pipe(
        Effect.mapError((cause) => new ThreadSecretError({ operation: "remove", name, cause })),
      );
    const thread = entries.get(threadId);
    thread?.delete(name);
    if (thread?.size === 0) entries.delete(threadId);
    bumpRevision(threadId);
    yield* Effect.logInfo("Removed thread secret", { threadId, name });
    yield* Metrics.increment(Metrics.threadSecretsTotal, { operation: "remove" });
  });
  const remove = Effect.fn("ThreadSecrets.remove")(
    removeEntry,
    lock.withPermits(1),
    Effect.uninterruptible,
  );
  const removeThread = Effect.fn("ThreadSecrets.removeThread")(
    function* (threadId: ThreadId) {
      for (const name of Array.from(entries.get(threadId)?.keys() ?? [])) {
        yield* removeEntry(threadId, name);
      }
    },
    lock.withPermits(1),
    Effect.uninterruptible,
  );
  const selected = (threadId?: ThreadId) =>
    threadId === undefined
      ? Array.from(entries.values()).flatMap((thread) => Array.from(thread.values()))
      : Array.from(entries.get(threadId)?.values() ?? []);
  return ThreadSecrets.of({
    list: (threadId) =>
      Effect.sync(() => selected(threadId).map(({ value: _value, ...summary }) => summary)),
    get: (threadId, name) =>
      Effect.sync(() =>
        Option.map(Option.fromNullishOr(entries.get(threadId)?.get(name)), (entry) => entry.value),
      ),
    set,
    remove,
    removeThread,
    environment: (threadId) =>
      Effect.sync(() =>
        Object.fromEntries(selected(threadId).map((entry) => [entry.name, entry.value])),
      ),
    revision: (threadId) => Effect.sync(() => revisions.get(threadId) ?? 0),
    redactionValues: (threadId) =>
      Effect.sync(() => [...new Set(selected(threadId).map((entry) => entry.value))]),
  });
});

export const layer = Layer.effect(ThreadSecrets, make);
