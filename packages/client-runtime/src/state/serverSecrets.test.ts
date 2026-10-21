import { expect, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  ThreadSecretName,
  TurnItemId,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentRpcInput } from "../rpc/client.ts";
import * as Persistence from "../platform/persistence.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

const NAME = ThreadSecretName.make("MY_KEY");
const THREAD_ID = ThreadId.make("thread-1");
const summary = {
  threadId: THREAD_ID,
  name: NAME,
  label: "My key",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

it.effect.each(["set", "remove", "answer-save"] as const)(
  "refreshes secrets after %s without joining a list started before the write",
  (mutation) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let receivedInput: unknown;
      let written = false;
      let listCalls = 0;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: { environmentId: ENVIRONMENT_ID },
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.secretsList]: () =>
                Effect.gen(function* () {
                  const first = ++listCalls === 1;
                  const secrets = written === (mutation !== "remove") ? [summary] : [];
                  if (first) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                  }
                  return { secrets };
                }),
              [WS_METHODS.secretsSet]: (input: EnvironmentRpcInput<typeof WS_METHODS.secretsSet>) =>
                Effect.sync(() => {
                  receivedInput = input;
                  written = true;
                  return summary;
                }),
              [WS_METHODS.secretsRemove]: (
                input: EnvironmentRpcInput<typeof WS_METHODS.secretsRemove>,
              ) =>
                Effect.sync(() => {
                  receivedInput = input;
                  written = true;
                  return {};
                }),
              [WS_METHODS.secretsAnswerRequest]: (
                input: EnvironmentRpcInput<typeof WS_METHODS.secretsAnswerRequest>,
              ) =>
                Effect.sync(() => {
                  receivedInput = input;
                  written = true;
                  return {};
                }),
            },
          } as unknown as RpcSession),
        ),
        state: yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
      } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
            run: (_id, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
            followStream: (_id, stream) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          Layer.succeed(
            Persistence.EnvironmentCacheStore,
            Persistence.EnvironmentCacheStore.of({
              loadShell: () => Effect.succeedNone,
              saveShell: () => Effect.void,
              loadThread: () => Effect.succeedNone,
              saveThread: () => Effect.void,
              removeThread: () => Effect.void,
              loadServerConfig: () => Effect.succeedNone,
              saveServerConfig: () => Effect.void,
              loadVcsRefs: () => Effect.succeedNone,
              saveVcsRefs: () => Effect.void,
              removeVcsRefs: () => Effect.void,
              clearVcsRefs: () => Effect.void,
              clear: () => Effect.void,
            }),
          ),
        ),
      );
      const commands = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(null),
      });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      registry.set(
        sessions(ENVIRONMENT_ID),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [
            AuthOrchestrationReadScope,
            AuthSettingsWriteScope,
            AuthOrchestrationOperateScope,
          ],
          permissions: [
            AuthOrchestrationReadScope,
            AuthSettingsWriteScope,
            AuthOrchestrationOperateScope,
          ],
        }),
      );
      const atom = commands.secretsAtom(ENVIRONMENT_ID);
      registry.mount(atom);
      yield* Deferred.await(started);
      const target = { environmentId: ENVIRONMENT_ID };
      const runWrite = async () =>
        mutation === "set"
          ? commands.setSecret.run(registry, {
              ...target,
              input: { threadId: THREAD_ID, name: NAME, label: "My key", value: "new-value" },
            })
          : mutation === "remove"
            ? commands.removeSecret.run(registry, {
                ...target,
                input: { threadId: THREAD_ID, name: NAME },
              })
            : commands.answerSecretRequest.run(registry, {
                ...target,
                input: {
                  threadId: THREAD_ID,
                  turnItemId: TurnItemId.make("card"),
                  answer: { type: "save", secret: "new-value" },
                },
              });
      const command =
        mutation === "set"
          ? commands.setSecret
          : mutation === "remove"
            ? commands.removeSecret
            : commands.answerSecretRequest;
      const session = registry.get(sessions(ENVIRONMENT_ID));
      if (session._tag !== "Success") throw new Error("Session did not load");
      registry.set(
        sessions(ENVIRONMENT_ID),
        AsyncResult.success({
          ...session.value,
          permissions: [AuthOrchestrationReadScope],
        }),
      );
      expect(registry.get(command.permissionAtom(ENVIRONMENT_ID))).toBe(false);
      const denied = yield* Effect.promise(runWrite);
      expect(denied._tag).toBe("Failure");
      expect(receivedInput).toBeUndefined();
      expect(written).toBe(false);
      registry.set(sessions(ENVIRONMENT_ID), session);
      expect(registry.get(command.permissionAtom(ENVIRONMENT_ID))).toBe(true);
      const write = yield* Effect.promise(runWrite);
      expect(write._tag).toBe("Success");
      expect(receivedInput).toEqual(
        mutation === "set"
          ? { threadId: THREAD_ID, name: NAME, label: "My key", value: "new-value" }
          : mutation === "remove"
            ? { threadId: THREAD_ID, name: NAME }
            : {
                threadId: THREAD_ID,
                turnItemId: TurnItemId.make("card"),
                answer: { type: "save", secret: "new-value" },
              },
      );
      registry.get(atom);
      yield* Deferred.succeed(release, undefined);
      const result = yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
      expect(result.secrets).toEqual(mutation === "remove" ? [] : [summary]);
      expect(listCalls).toBe(2);
    }).pipe(Effect.scoped),
);
