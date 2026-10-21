import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, ThreadSecretName } from "@t3tools/contracts";
import { AgentSecrets, withAgentSecrets } from "@t3tools/shared/AgentSecrets";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AgentSecretsLive from "./AgentSecretsLive.ts";
import * as ThreadSecrets from "./ThreadSecrets.ts";

const secretsLayer = ThreadSecrets.layer.pipe(
  Layer.provide(
    ServerSecretStore.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-secrets-test-" })),
    ),
  ),
);

it.effect("isolates thread snapshots and immediately unmasks deleted and replaced values", () =>
  Effect.gen(function* () {
    const secrets = yield* ThreadSecrets.ThreadSecrets;
    const agentSecrets = yield* AgentSecrets;
    const threadId = ThreadId.make("a");
    const otherThread = ThreadId.make("b");
    const empty = yield* agentSecrets.snapshot(threadId);
    assert.isTrue(empty.redactor.isEmpty);
    const name = ThreadSecretName.make("TEST_TOKEN");
    yield* secrets.set({ threadId, name, label: "test", value: "initial-secret" });
    const first = yield* agentSecrets.snapshot(threadId);
    assert.strictEqual(yield* agentSecrets.snapshot(threadId), first);
    assert.deepEqual(yield* withAgentSecrets({ TEST_TOKEN: "instance" }, threadId), {
      TEST_TOKEN: "initial-secret",
    });
    const other = yield* agentSecrets.snapshot(otherThread);
    assert.deepEqual(other.environment, {});
    assert.equal(other.redactor.redactText("initial-secret"), "initial-secret");
    assert.deepEqual((yield* agentSecrets.snapshot(undefined)).environment, {});
    yield* secrets.set({ threadId: otherThread, name, label: "other", value: "other-secret" });
    const nativeRedactor = yield* agentSecrets.redactor;
    assert.strictEqual(yield* agentSecrets.redactor, nativeRedactor);
    assert.equal(
      (yield* agentSecrets.redactor).redactText("initial-secret other-secret"),
      "[REDACTED] [REDACTED]",
    );
    yield* secrets.set({ threadId, name, label: "test", value: "rotated-secret" });
    assert.notStrictEqual(yield* agentSecrets.redactor, nativeRedactor);
    const second = yield* agentSecrets.snapshot(threadId);
    assert.notStrictEqual(first.redactor, second.redactor);
    assert.equal(
      second.redactor.redactText("initial-secret rotated-secret"),
      "initial-secret [REDACTED]",
    );
    yield* secrets.remove(threadId, name);
    const removed = yield* agentSecrets.snapshot(threadId);
    assert.deepEqual(removed.environment, {});
    assert.deepEqual((yield* agentSecrets.snapshot(otherThread)).environment, {
      TEST_TOKEN: "other-secret",
    });
    assert.equal(
      (yield* agentSecrets.redactor).redactText("initial-secret rotated-secret other-secret"),
      "initial-secret rotated-secret [REDACTED]",
    );
    assert.equal(
      removed.redactor.redactText("initial-secret rotated-secret"),
      "initial-secret rotated-secret",
    );
  }).pipe(
    Effect.provide(
      AgentSecretsLive.layer.pipe(
        Layer.provideMerge(secretsLayer),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
