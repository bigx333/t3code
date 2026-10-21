import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AgentSecrets } from "@t3tools/shared/AgentSecrets";
import { makeSecretRedactor } from "@t3tools/shared/secretRedaction";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

it.effect("keeps thread secrets out of the shared OpenCode server process", () =>
  Effect.gen(function* () {
    const environments: Array<NodeJS.ProcessEnv | undefined> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) environments.push(command.options.env);
      return Effect.die("Stop at the process boundary without starting a server.");
    });
    const result = yield* Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
      return yield* runtime.startOpenCodeServerProcess({
        binaryPath: "/fake/opencode",
        directory: "/fake",
        port: 4096,
        environment: { BASE: "base-value" },
        serverPassword: "server-password",
      });
    }).pipe(
      Effect.provide(
        OpenCodeRuntime.layer.pipe(
          Layer.provide(OpenCodeServerLedger.layerTest),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(result));
    assert.deepEqual(environments, [
      {
        BASE: "base-value",
        OPENCODE_SERVER_PASSWORD: "server-password",
        OPENCODE_CONFIG_CONTENT: "{}",
      },
    ]);
  }).pipe(
    Effect.provideService(AgentSecrets, {
      snapshot: (threadId) =>
        Effect.succeed({
          revision: threadId === undefined ? 0 : 1,
          environment: threadId === undefined ? {} : { THREAD_SECRET: "thread-secret" },
          redactor: makeSecretRedactor(threadId === undefined ? [] : ["thread-secret"]),
        }),
      redactor: Effect.succeed(makeSecretRedactor(["thread-secret"])),
    }),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
