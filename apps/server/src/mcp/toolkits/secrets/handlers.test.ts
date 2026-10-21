import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  RunId,
  ThreadId,
  ThreadSecretName,
  type RuntimeMode,
} from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as RuntimePolicy from "../../../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentSecretsLive from "../../../secrets/AgentSecretsLive.ts";
import * as SecretShell from "../../../secrets/SecretShell.ts";
import * as ThreadSecrets from "../../../secrets/ThreadSecrets.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { SecretsToolkit } from "./tools.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const threadId = ThreadId.make("secret-shell-owner");
const otherThreadId = ThreadId.make("secret-shell-other");
const name = ThreadSecretName.make("TEST_SECRET_SHELL_TOKEN");
const otherName = ThreadSecretName.make("TEST_SECRET_SHELL_OTHER_TOKEN");
const value = 'private-"value\\with\nnewlines';
const quotePosix = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const quote = (text: string) =>
  hostPlatform === "win32" ? `"${text.replaceAll('"', '\\"')}"` : quotePosix(text);
const nodeCommand = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`;

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "secret-shell-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "secret-shell-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const withHarness = <A, E, R>(
  test: (harness: {
    readonly call: (
      input: typeof SecretShell.SecretShellInput.Type,
      caller?: ThreadId | null | undefined,
      readOnlyClient?: boolean,
    ) => Effect.Effect<McpSchema.CallToolResult, McpSchema.InternalError | McpSchema.InvalidParams>;
    readonly setMode: (mode: RuntimeMode) => void;
    readonly directory: string;
    readonly ready: Deferred.Deferred<string>;
    readonly spawned: Array<number>;
    readonly stop: (status: "interrupted" | "cancelled", target?: ThreadId) => Effect.Effect<void>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-secret-shell-" });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ready = yield* Deferred.make<string>();
    const spawned: Array<number> = [];
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let mode: RuntimeMode = "full-access";
    const shellFor = (id: ThreadId) =>
      liveThreadShell(id, { runtimeMode: mode, activeRunId: RunId.make(`run:${id}`) });
    const projectionFor = (id: ThreadId) => idleThreadProjection(shellFor(id));
    const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.sync(() => shellFor(id)),
      getThreadRecords: (id) => Effect.sync(() => projectionFor(id)),
      getThreadEventSequence: () => Effect.succeed(0),
      streamStoredEventsFrom: (input) =>
        Stream.fromQueue(events).pipe(
          Stream.filter(({ event }) => event.threadId === input?.threadId),
        ),
    });
    const observedSpawner = ChildProcessSpawner.make((command) =>
      spawner.spawn(command).pipe(
        Effect.map((handle) => {
          spawned.push(handle.pid);
          return {
            ...handle,
            all: handle.all.pipe(
              Stream.tap((chunk) => {
                const text = Buffer.from(chunk).toString();
                return text.includes("READY:")
                  ? Deferred.succeed(ready, text).pipe(Effect.asVoid)
                  : Effect.void;
              }),
            ),
          };
        }),
      ),
    );
    const secretsLayer = ThreadSecrets.layer.pipe(
      Layer.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(directory, { prefix: "secret-shell-store-" })),
        ),
      ),
    );
    const stop = (status: "interrupted" | "cancelled", target = threadId) => {
      const shell = shellFor(target);
      const run = OrchestrationV2Run.make({
        id: RunId.make(`run:${target}`),
        threadId: target,
        ordinal: 1,
        providerInstanceId: shell.providerInstanceId,
        modelSelection: shell.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message"),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: shell.createdAt,
        startedAt: shell.createdAt,
        completedAt: shell.createdAt,
        checkpointId: null,
        contextHandoffId: null,
      });
      return Queue.offer(events, {
        sequence: 1,
        commandId: null,
        event: {
          id: EventId.make("stop"),
          threadId: target,
          type: "run.updated",
          payload: run,
          occurredAt: shell.createdAt,
        },
      }).pipe(Effect.asVoid);
    };
    return yield* Effect.gen(function* () {
      const secrets = yield* ThreadSecrets.ThreadSecrets;
      yield* secrets.set({ threadId, name, label: "test", value });
      yield* secrets.set({
        threadId: otherThreadId,
        name: otherName,
        label: "other",
        value: "other-thread-private-value",
      });
      const server = yield* McpServer.McpServer;
      const call = (
        input: typeof SecretShell.SecretShellInput.Type,
        caller: ThreadId | null = threadId,
        readOnlyClient = false,
      ) =>
        server.callTool({ name: "t3_secret_shell", arguments: { ...input } }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("test-environment"),
            capabilities: new Set<never>(),
            issuedAt: 0,
            requestNamespace: "test",
            client: readOnlyClient
              ? { sessionId: "read-only-client", label: "test", access: "read-only" }
              : undefined,
            thread:
              caller === null
                ? undefined
                : {
                    threadId: caller,
                    providerSessionId: "test-session",
                    providerInstanceId: shellFor(caller).providerInstanceId,
                  },
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      return yield* test({
        call,
        setMode: (next) => {
          mode = next;
        },
        directory,
        ready,
        spawned,
        stop,
      });
    }).pipe(
      Effect.provide(
        McpHttpServer.toolkitRegistration(SecretsToolkit, Handlers.layer).pipe(
          Layer.provideMerge(SecretShell.layer),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(threadsLayer),
          Layer.provide(
            Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
              resolve: ({ thread }) =>
                Effect.succeed({
                  cwd: directory,
                  runtimeMode: thread.runtimeMode,
                  interactionMode: thread.interactionMode,
                }),
            }),
          ),
          Layer.provide(
            Layer.succeed(AgentScope, {
              wrap: ({ command, args, threadId: wrappedThreadId }) => {
                assert.isUndefined(wrappedThreadId);
                return Effect.succeed(
                  hostPlatform === "win32"
                    ? { command, args }
                    : {
                        command: "/bin/sh",
                        args: [
                          "-c",
                          'export TEST_SCOPE_WRAPPED=1; exec "$@"',
                          "secret-shell-scope",
                          command,
                          ...args,
                        ],
                      },
                );
              },
              oomKilled: () => Effect.succeed(false),
              clear: () => Effect.void,
            }),
          ),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, observedSpawner)),
          Layer.provideMerge(AgentSecretsLive.layer.pipe(Layer.provideMerge(secretsLayer))),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Platform, hostPlatform),
    Effect.provide(NodeServices.layer),
  );

const textResult = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(SecretShell.SecretShellResult));

it.effect(
  "runs the MCP tool with only the calling thread's secrets in the resolved cwd and redacts output",
  () =>
    withHarness(({ call, directory }) =>
      Effect.gen(function* () {
        const result = yield* call({
          command: nodeCommand(
            `console.log(process.cwd()); console.log('wrapped=' + process.env.TEST_SCOPE_WRAPPED); console.log(process.env.${name}); console.error(JSON.stringify(process.env.${name})); console.log('other=' + (process.env.${otherName} ?? 'missing'));`,
          ),
        });
        assert.notStrictEqual(result.isError, true);
        const text = textResult(result);
        assert.notInclude(text, value);
        assert.notInclude(text, JSON.stringify(value).slice(1, -1));
        const decoded = decodeResult(text);
        assert.strictEqual(decoded.exitCode, 0);
        assert.isFalse(decoded.timedOut);
        assert.isFalse(decoded.truncated);
        assert.include(decoded.output, directory);
        if (hostPlatform !== "win32") assert.include(decoded.output, "wrapped=1");
        assert.include(decoded.output, "[REDACTED]");
        assert.include(decoded.output, "other=missing");
        const other = decodeResult(
          textResult(
            yield* call(
              {
                command: nodeCommand(
                  `console.log('owner=' + (process.env.${name} ?? 'missing')); console.log(process.env.${otherName});`,
                ),
              },
              otherThreadId,
            ),
          ),
        );
        assert.include(other.output, "owner=missing");
        assert.include(other.output, "[REDACTED]");
        assert.notInclude(other.output, "other-thread-private-value");
      }),
    ),
);

it.effect.each(["full-access", "auto", "approval-required", "auto-accept-edits"] as const)(
  "enforces runtime mode %s through MCP",
  (mode) =>
    withHarness(({ call, setMode, spawned }) =>
      Effect.gen(function* () {
        setMode(mode);
        const result = yield* call({ command: nodeCommand("process.stdout.write('ran')") });
        if (mode === "auto" || mode === "full-access") {
          assert.notStrictEqual(result.isError, true);
          assert.equal(decodeResult(textResult(result)).output, "ran");
        } else {
          assert.isTrue(result.isError);
          assert.include(textResult(result), "requires auto or full-access");
          assert.lengthOf(spawned, 0);
        }
      }),
    ),
);

it.effect.skipIf(hostPlatform === "win32")(
  "redacts secret literals in MCP inputs before executing them",
  () =>
    withHarness(({ call }) =>
      Effect.gen(function* () {
        const result = yield* call({
          command: `if [ ${quote(value)} = '[REDACTED]' ]; then printf 'input redacted'; else printf 'raw input'; fi`,
        });
        assert.equal(decodeResult(textResult(result)).output, "input redacted");
      }),
    ),
);

it.effect("keeps the last 256 KiB and reports truncation", () =>
  withHarness(({ call }) =>
    Effect.gen(function* () {
      const result = decodeResult(
        textResult(
          yield* call({
            command: nodeCommand(
              "process.stdout.write('discarded-start' + 'x'.repeat(300000) + 'kept-end')",
            ),
          }),
        ),
      );
      assert.isTrue(result.truncated);
      assert.include(result.output, "[Output truncated to the last 256 KiB.]\n");
      assert.notInclude(result.output, "discarded-start");
      assert.isTrue(result.output.endsWith("kept-end"));
      assert.equal(Buffer.byteLength(result.output.split("\n").slice(1).join("\n")), 256 * 1024);
    }),
  ),
);

const longCommand = nodeCommand(
  "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('READY:'+child.pid); setInterval(()=>{},1000)",
);
const assertTerminated = (pid: number) =>
  Effect.gen(function* () {
    assert.isTrue(Number.isInteger(pid) && pid > 0, "a captured process id is required");
    if (hostPlatform !== "linux") {
      assert.throws(() => process.kill(pid, 0));
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option);
    if (stat._tag === "Some") assert.match(stat.value, /\) [ZX] /);
  });

it.effect("rejects unscoped and read-only MCP clients", () =>
  withHarness(({ call, spawned }) =>
    Effect.gen(function* () {
      for (const readOnly of [false, true]) {
        const result = yield* call(
          { command: nodeCommand("process.stdout.write('ran')") },
          null,
          readOnly,
        );
        assert.isTrue(result.isError);
      }
      assert.lengthOf(spawned, 0);
    }),
  ),
);

it.effect("rejects timeouts above ten minutes before spawning", () =>
  withHarness(({ call, spawned }) =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(call({ command: "exit 0", timeoutMs: 600_001 }));
      assert.isTrue(Exit.isFailure(result));
      assert.lengthOf(spawned, 0);
    }),
  ),
);

it.effect("redacts with the current thread snapshot when secrets change during a command", () =>
  withHarness(({ call, ready, directory }) =>
    Effect.gen(function* () {
      const secrets = yield* ThreadSecrets.ThreadSecrets;
      const fs = yield* FileSystem.FileSystem;
      const rotated = 'rotated-"private\\value';
      const running = yield* call({
        command: nodeCommand(
          "const fs=require('node:fs'); fs.watch('.',(_,file)=>{if(file==='release'){process.stdout.write(fs.readFileSync(file));process.exit(0)}}); console.log('READY:1')",
        ),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      yield* secrets.set({ threadId, name, label: "rotated", value: rotated });
      yield* fs.writeFileString(
        `${directory}/release.next`,
        rotated + "\n" + JSON.stringify(rotated),
      );
      yield* fs.rename(`${directory}/release.next`, `${directory}/release`);
      const result = decodeResult(textResult(yield* Fiber.join(running)));
      assert.notInclude(result.output, rotated);
      assert.notInclude(result.output, JSON.stringify(rotated).slice(1, -1));
      assert.include(result.output, "[REDACTED]");
    }),
  ),
);

it.effect("uses a two minute default timeout", () =>
  withHarness(({ call, ready }) =>
    Effect.gen(function* () {
      const running = yield* call({ command: longCommand }).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      yield* TestClock.adjust(119_999);
      assert.isUndefined(running.pollUnsafe());
      yield* TestClock.adjust(1);
      assert.isTrue(decodeResult(textResult(yield* Fiber.join(running))).timedOut);
    }),
  ),
);

it.effect("times out and kills the shell process group", () =>
  withHarness(({ call, ready, spawned }) =>
    Effect.gen(function* () {
      const running = yield* call({ command: longCommand, timeoutMs: 2000 }).pipe(Effect.forkChild);
      const started = yield* Deferred.await(ready);
      yield* TestClock.adjust(2000);
      const result = decodeResult(textResult(yield* Fiber.join(running)));
      assert.isTrue(result.timedOut);
      assert.strictEqual(result.exitCode, null);
      assert.equal(result.signal, "SIGKILL");
      for (const pid of [...spawned, Number(started.split("READY:")[1]?.trim())])
        yield* assertTerminated(pid);
    }),
  ),
);

it.effect.each(["interrupted", "cancelled"] as const)(
  "kills running commands when the calling run is %s",
  (status) =>
    withHarness(({ call, ready, spawned, stop }) =>
      Effect.gen(function* () {
        const running = yield* call({ command: longCommand }).pipe(Effect.forkChild);
        const started = yield* Deferred.await(ready);
        yield* stop(status);
        const result = decodeResult(textResult(yield* Fiber.join(running)));
        assert.isFalse(result.timedOut);
        assert.equal(result.signal, "SIGKILL");
        for (const pid of [...spawned, Number(started.split("READY:")[1]?.trim())])
          yield* assertTerminated(pid);
      }),
    ),
);

it.effect("kills the process group when the MCP call is cancelled", () =>
  withHarness(({ call, ready, spawned }) =>
    Effect.gen(function* () {
      const running = yield* call({ command: longCommand }).pipe(Effect.forkChild);
      const started = yield* Deferred.await(ready);
      yield* Fiber.interrupt(running);
      for (const pid of [...spawned, Number(started.split("READY:")[1]?.trim())])
        yield* assertTerminated(pid);
    }),
  ),
);
