import { OrchestratorMcpFailure, type RuntimeMode, type ThreadId } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { AgentSecrets, withAgentSecrets } from "@t3tools/shared/AgentSecrets";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const ALLOWED_RUNTIME_MODES: ReadonlySet<RuntimeMode> = new Set(["auto", "full-access"]);
const MAX_OUTPUT_BYTES = 256 * 1024;

export const SecretShellInput = Schema.Struct({
  command: Schema.String,
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 }))),
});

export const SecretShellResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.optional(Schema.String),
  timedOut: Schema.Boolean,
  truncated: Schema.Boolean,
  output: Schema.String,
});

export class SecretShell extends Context.Service<
  SecretShell,
  {
    readonly run: (
      threadId: ThreadId,
      input: typeof SecretShellInput.Type,
    ) => Effect.Effect<typeof SecretShellResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/secrets/SecretShell") {}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The secret shell command could not be completed.",
  });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
  const agentScope = yield* AgentScope;
  const agentSecrets = yield* AgentSecrets;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const hostEnv = yield* HostProcess.Environment;

  const run = Effect.fn("SecretShell.run")(function* (
    threadId: ThreadId,
    input: typeof SecretShellInput.Type,
  ) {
    const afterSequence = yield* threads
      .getThreadEventSequence(threadId)
      .pipe(Effect.mapError(unavailable));
    const { thread } = yield* threads
      .getThreadRecords(threadId, [])
      .pipe(Effect.mapError(unavailable));
    if (thread.deletedAt !== null || thread.archivedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The calling thread is unavailable.",
      });
    }
    if (!ALLOWED_RUNTIME_MODES.has(thread.runtimeMode)) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "t3_secret_shell requires auto or full-access mode. This thread's mode requires command approval or forbids commands.",
      });
    }
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    const runId = shell?.activeRunId;
    if (runId === undefined || runId === null) {
      return yield* new OrchestratorMcpFailure({
        code: "parent_not_active",
        message: "t3_secret_shell requires an active calling run.",
      });
    }
    const policy = yield* runtimePolicy
      .resolve({ thread, modelSelection: thread.modelSelection })
      .pipe(Effect.mapError(unavailable));
    if (policy.cwd === null) return yield* unavailable();
    const env = yield* withAgentSecrets(hostEnv, threadId);
    const command = platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-c", input.command];
    // Tool commands must not replace the provider runtime's per-thread OOM scope.
    const wrapped = yield* agentScope.wrap({ command, args, name: "secret-shell", env });
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(wrapped.command, wrapped.args, {
          cwd: policy.cwd,
          env,
          extendEnv: false,
          detached: true,
          stdin: "ignore",
          killSignal: "SIGKILL",
        }),
      )
      .pipe(Effect.mapError(unavailable));

    let output = Buffer.alloc(0);
    let truncated = false;
    const collect = handle.all.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          truncated ||= output.length + chunk.length > MAX_OUTPUT_BYTES;
          output =
            chunk.length >= MAX_OUTPUT_BYTES
              ? Buffer.from(chunk.subarray(chunk.length - MAX_OUTPUT_BYTES))
              : Buffer.concat([
                  output.subarray(Math.max(0, output.length + chunk.length - MAX_OUTPUT_BYTES)),
                  chunk,
                ]);
        }),
      ),
    );
    // Replay from before reading the caller so a stop during setup cannot be missed.
    const stopped = threads.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
      Stream.filter(
        ({ event }) =>
          (event.type === "run.updated" &&
            event.payload.id === runId &&
            !ThreadManagement.isActiveRun(event.payload)) ||
          (event.type === "run.background-work-cancelled" && event.payload.runId === runId) ||
          event.type === "thread.deleted" ||
          event.type === "thread.archived" ||
          (event.type === "thread.runtime-mode-updated" &&
            !ALLOWED_RUNTIME_MODES.has(event.payload.runtimeMode)),
      ),
      Stream.runHead,
      Effect.as({ kind: "stopped" as const }),
    );
    const completion = Effect.all(
      [collect, handle.exitCode.pipe(Effect.orElseSucceed(() => null))],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([, exitCode]) => ({ kind: "exited" as const, exitCode })));
    const outcome = yield* Effect.raceFirst(
      completion,
      Effect.raceFirst(
        stopped,
        Effect.sleep(input.timeoutMs ?? 120_000).pipe(Effect.as({ kind: "timedOut" as const })),
      ),
    ).pipe(Effect.mapError(unavailable));
    if (outcome.kind !== "exited") {
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.mapError(unavailable));
    }
    const { redactor } = yield* agentSecrets.snapshot(threadId);
    return {
      exitCode: outcome.kind !== "exited" ? null : outcome.exitCode,
      ...(outcome.kind !== "exited" ? { signal: "SIGKILL" } : {}),
      timedOut: outcome.kind === "timedOut",
      truncated,
      output: redactor.redactText(
        `${truncated ? "[Output truncated to the last 256 KiB.]\n" : ""}${output.toString("utf8")}`,
      ),
    };
  }, Effect.scoped);
  return SecretShell.of({ run });
});

export const layer = Layer.effect(SecretShell, make);
