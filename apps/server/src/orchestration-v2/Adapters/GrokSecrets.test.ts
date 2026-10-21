import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
  ThreadSecretName,
} from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import { makeGrokAdapterV2, GROK_PROVIDER } from "@t3tools/provider-grok/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpServer } from "effect/ai";
import { HttpServer } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../mcp/ThreadMetadataMcpService.ts";
import * as SecretsHandlers from "../../mcp/toolkits/secrets/handlers.ts";
import { SecretsToolkit } from "../../mcp/toolkits/secrets/tools.ts";
import * as OrchestratorHandlers from "../../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as AgentSecretsLive from "../../secrets/AgentSecretsLive.ts";
import * as ThreadSecrets from "../../secrets/ThreadSecrets.ts";
import * as SecretShell from "../../secrets/SecretShell.ts";
import * as ToolOutputHooks from "../../secrets/ToolOutputHooks.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as CommandOutputHub from "../CommandOutputHub.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("grok-secrets-test");
const modelSelection = { instanceId, model: "grok-build" };
const threadA = ThreadId.make("grok-secret-a");
const threadB = ThreadId.make("grok-secret-b");
const tokenName = ThreadSecretName.make("TEST_GROK_THREAD_TOKEN");
const otherName = ThreadSecretName.make("TEST_GROK_OTHER_TOKEN");
const launchSchema = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    args: Schema.Array(Schema.String),
    hookUrl: Schema.optional(Schema.String),
    token: Schema.optional(Schema.String),
    other: Schema.optional(Schema.String),
  }),
);
const decodeLaunch = Schema.decodeEffect(launchSchema);
const decodeGrokSettings = Schema.decodeEffect(GrokSettings);
const decodeMcpRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number, method: Schema.String })),
);

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerDatabase),
);
const layerSink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(layerStores, layerDatabase)));
const layerOutput = CommandOutputHub.layer.pipe(
  Layer.provide(Layer.mergeAll(layerSink, layerStores)),
);
const layerIngestor = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerSink,
      layerStores,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      Layer.mock(GitVcsDriver.GitVcsDriver)({ resolveBranchName: () => Effect.succeed(null) }),
    ),
  ),
);
const layerMcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(
    Layer.succeed(HttpServer.HttpServer, {
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
      serve: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("grok-secrets-test")),
    }),
  ),
);
const layerSecrets = AgentSecretsLive.layer.pipe(
  Layer.provideMerge(
    ThreadSecrets.layer.pipe(
      Layer.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-secrets-" })),
        ),
      ),
    ),
  ),
);

const makeGrokHarness = Effect.fnUntraced(function* (directory: string, launchPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sink = yield* EventSink.EventSinkV2;
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const runtimePolicy = {
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: directory,
  } as const;
  for (const threadId of [threadA, threadB]) {
    const thread = idleThreadProjection({
      ...liveThreadShell(threadId, { activeRunId: null }),
      providerInstanceId: instanceId,
      modelSelection,
      worktreePath: directory,
    }).thread;
    yield* sink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
  }
  const sessions = new Map<ThreadId, ProviderSessionId>();
  const open = (threadId: ThreadId) =>
    Effect.gen(function* () {
      let providerSessionId = sessions.get(threadId);
      if (providerSessionId === undefined) {
        providerSessionId = yield* ids.allocate.providerSession({
          providerInstanceId: instanceId,
          threadId,
        });
        sessions.set(threadId, providerSessionId);
      }
      return yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
    });
  const start = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime, threadId: ThreadId) =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      const toolCompleted = yield* Deferred.make<void>();
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const subscription = yield* runtime.subscribeEvents!;
      yield* subscription.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            yield* ingestor.ingestNormalized({
              providerSessionId: runtime.providerSessionId,
              providerInstanceId: instanceId,
              threadId,
              event,
            });
            if (event.type === "turn_item.updated" && event.turnItem.status === "completed")
              yield* Deferred.succeed(toolCompleted, undefined);
            if (event.type === "turn.terminal") yield* Deferred.succeed(completed, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const runId = ids.derive.run({ threadId, ordinal: 1 });
      yield* runtime.startTurn({
        appThread: (yield* projections.getThreadProjection(threadId)).thread,
        threadId,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: ids.derive.runAttempt({ runId, attemptOrdinal: 1 }),
        rootNodeId: ids.derive.rootNode({ runId }),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: yield* ids.allocate.message({ threadId, ordinal: 1 }),
          text: "Inspect the fixture",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      return { completed, toolCompleted, events };
    });
  return {
    launches: fs
      .readFileString(launchPath)
      .pipe(
        Effect.flatMap((text) =>
          Effect.forEach(text.trim().split("\n"), (line) => decodeLaunch(line)),
        ),
      ),
    open,
    start,
    close: manager.close,
  };
});

const withGrok = <A, E, R>(
  test: (harness: Effect.Success<ReturnType<typeof makeGrokHarness>>) => Effect.Effect<A, E, R>,
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "grok-secret-process-" });
    const launchPath = path.join(directory, "launches.jsonl");
    const mockPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const binaryPath = writeFakeCli({
      directory,
      name: "grok",
      source: [
        `import { appendFileSync as recordLaunch } from "node:fs";`,
        `recordLaunch(${JSON.stringify(launchPath)}, JSON.stringify({pid: process.pid, token: process.env.TEST_GROK_THREAD_TOKEN, other: process.env.TEST_GROK_OTHER_TOKEN, args: process.argv.slice(2), hookUrl: process.env.T3_GROK_TOOL_OUTPUT_HOOK_URL}) + "\\n");`,
        execScriptSource({ scriptPath: mockPath }),
      ].join("\n"),
    });
    const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
      Effect.gen(function* () {
        return [
          yield* makeGrokAdapterV2({
            instanceId,
            settings: yield* decodeGrokSettings({ binaryPath }),
            environment: { ...environment },
            hostPlatform: yield* HostProcess.Platform,
            selfInvocation: yield* resolveSelfInvocation(),
          }),
        ];
      }),
    ).pipe(
      Layer.provide(TestProviderHost.layer()),
      Layer.provide(IdAllocator.layer),
      Layer.provide(McpProviderSessions.layer),
    );
    const layerTest = Layer.mergeAll(
      layerStores,
      layerSink,
      layerIngestor,
      IdAllocator.layer,
      McpProviderSessions.layer,
      layerMcpRegistry,
      ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
        Layer.provide(
          Layer.mergeAll(
            layerRegistry,
            layerStores,
            layerSink,
            layerOutput,
            layerIngestor,
            IdAllocator.layer,
            McpProviderSessions.layer,
            layerMcpRegistry,
          ),
        ),
      ),
    );
    return yield* makeGrokHarness(directory, launchPath).pipe(
      Effect.flatMap(test),
      Effect.provide(layerTest),
    );
  }).pipe(
    Effect.provide(
      ToolOutputHooks.layerAgentHooks.pipe(
        Layer.provideMerge(ToolOutputHooks.layerWithOrigin("http://127.0.0.1:43123")),
        Layer.provideMerge(layerSecrets),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

it.live("Grok subprocesses receive only their own thread's secret environment", () =>
  withGrok(({ open, launches }) =>
    Effect.gen(function* () {
      const secrets = yield* ThreadSecrets.ThreadSecrets;
      yield* secrets.set({
        threadId: threadA,
        name: tokenName,
        label: "A",
        value: "thread-a-private",
      });
      yield* secrets.set({
        threadId: threadB,
        name: tokenName,
        label: "B",
        value: "thread-b-private",
      });
      yield* secrets.set({
        threadId: threadB,
        name: otherName,
        label: "B only",
        value: "thread-b-only",
      });
      const a = yield* open(threadA);
      const b = yield* open(threadB);
      assert.equal(a.driver, GROK_PROVIDER);
      assert.equal(b.driver, GROK_PROVIDER);
      const processes = yield* launches;
      assert.lengthOf(processes, 2);
      assert.equal(processes[0]?.token, "thread-a-private");
      assert.isUndefined(processes[0]?.other);
      assert.equal(processes[1]?.token, "thread-b-private");
      assert.equal(processes[1]?.other, "thread-b-only");
      assert.notEqual(processes[0]?.pid, processes[1]?.pid);
    }),
  ),
);

it.live(
  "Grok recycles an idle process before the next turn after saving, rotating and deleting a secret",
  () =>
    withGrok(({ open, start, launches }) =>
      Effect.gen(function* () {
        const secrets = yield* ThreadSecrets.ThreadSecrets;
        let previous = yield* open(threadA);
        yield* secrets.set({
          threadId: threadB,
          name: tokenName,
          label: "B",
          value: "unrelated-private",
        });
        assert.strictEqual(yield* open(threadA), previous);
        for (const value of ["saved-private", "rotated-private", undefined]) {
          if (value === undefined) yield* secrets.remove(threadA, tokenName);
          else yield* secrets.set({ threadId: threadA, name: tokenName, label: "A", value });
          const current = yield* open(threadA);
          assert.notStrictEqual(current, previous);
          const turn = yield* start(current, threadA);
          yield* Deferred.await(turn.completed);
          assert.equal((yield* launches).at(-1)?.token, value);
          previous = current;
        }
        const processes = yield* launches;
        assert.lengthOf(processes, 4);
        assert.equal(new Set(processes.map((process) => process.pid)).size, 4);
      }),
    ),
);

it.live("Grok keeps a busy process alive when its thread's secrets change", () =>
  withGrok(
    ({ open, start, launches }) =>
      Effect.gen(function* () {
        const secrets = yield* ThreadSecrets.ThreadSecrets;
        yield* secrets.set({
          threadId: threadA,
          name: tokenName,
          label: "A",
          value: "busy-original",
        });
        const first = yield* open(threadA);
        const turn = yield* start(first, threadA);
        yield* Deferred.await(turn.toolCompleted);
        yield* secrets.set({
          threadId: threadA,
          name: tokenName,
          label: "A",
          value: "busy-rotated",
        });
        assert.strictEqual(yield* open(threadA), first);
        const processes = yield* launches;
        assert.lengthOf(processes, 1);
        for (const launch of processes) assert.doesNotThrow(() => process.kill(launch.pid, 0));
        assert.isFalse(yield* Deferred.isDone(turn.completed));
      }),
    { T3_ACP_TOOL_OUTPUT_ENV: tokenName, T3_ACP_HANG_PROMPT_FOREVER: "1" },
  ),
);

it.live(
  "Grok execute and read output is redacted in T3 events and persisted turn items only for the owning thread",
  () =>
    withGrok(
      ({ open, start }) =>
        Effect.gen(function* () {
          const secrets = yield* ThreadSecrets.ThreadSecrets;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* secrets.set({
            threadId: threadA,
            name: tokenName,
            label: "A",
            value: "grok-output-private",
          });
          const own = yield* start(yield* open(threadA), threadA);
          yield* Deferred.await(own.completed);
          const ownItems = (yield* projections.getThreadProjection(threadA)).turnItems;
          const command = ownItems.find((item) => item.type === "command_execution");
          const read = ownItems.find((item) => item.type === "dynamic_tool");
          assert.equal(
            command?.type === "command_execution" ? command.output : undefined,
            "[REDACTED]",
          );
          assert.include(JSON.stringify(read), "[REDACTED]");
          assert.notInclude(JSON.stringify(own.events), "grok-output-private");
          assert.notInclude(JSON.stringify(ownItems), "grok-output-private");
          const other = yield* start(yield* open(threadB), threadB);
          yield* Deferred.await(other.completed);
          const otherItems = (yield* projections.getThreadProjection(threadB)).turnItems;
          assert.include(JSON.stringify(otherItems), "grok-output-private");
        }),
      { T3_ACP_TOOL_OUTPUT_ENV: tokenName, [tokenName]: "grok-output-private" },
    ),
);

it.live(
  "Grok discovers t3_secret_shell and list_secrets through the authenticated T3 MCP bridge",
  () =>
    withGrok(
      ({ open, start }) =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const methods: Array<string> = [];
          let config: McpProviderSessionConfig | undefined;
          using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            if (config === undefined) throw new Error("Grok has no T3 MCP configuration");
            assert.equal(String(url), config.endpoint);
            assert.equal(
              new Headers(init?.headers).get("authorization"),
              config.authorizationHeader,
            );
            if (init?.method === "DELETE") return new Response(null, { status: 204 });
            const request = decodeMcpRequest(String(init?.body));
            methods.push(request.method);
            assert.equal(request.method, "tools/list");
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: { tools: server.tools.map(({ tool }) => tool) },
            });
          });
          const runtime = yield* open(threadA);
          config = yield* sessions.read(threadA);
          if (config === undefined) throw new Error("Grok has no T3 MCP configuration");
          const scope = yield* registry.resolve(config.authorizationHeader.replace(/^Bearer /, ""));
          assert.equal(scope?.thread?.threadId, threadA);
          assert.equal(scope?.thread?.providerInstanceId, instanceId);
          const turn = yield* start(runtime, threadA);
          yield* Deferred.await(turn.completed);
          const text = turn.events
            .flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
                ? [event.turnItem.text]
                : [],
            )
            .join("\n");
          assert.deepEqual(methods, ["tools/list"]);
          assert.include(text, '"name":"t3_secret_shell"');
          assert.include(text, '"name":"list_secrets"');
        }),
      { T3_ACP_PROBE_MCP_TOOLS: "1", T3_ACP_MCP_ACP: "1" },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpHttpServer.toolkitRegistration(SecretsToolkit, SecretsHandlers.layer),
          McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer),
        ).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(SecretShell.SecretShell)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
              Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.live(
  "Grok spawns with an isolated HTTP hook and revokes it and removes its config on close",
  () =>
    withGrok(({ open, launches, close }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const hooks = yield* ToolOutputHooks.ToolOutputHooks;
        const secrets = yield* ThreadSecrets.ThreadSecrets;
        yield* secrets.set({
          threadId: threadA,
          name: tokenName,
          label: "A",
          value: "hook-process-private",
        });
        const runtime = yield* open(threadA);
        const launch = (yield* launches)[0];
        assert(launch !== undefined);
        assert.include(launch.args, "--no-leader");
        const plugin = launch.args[launch.args.indexOf("--plugin-dir") + 1];
        assert(plugin !== undefined);
        assert(launch.hookUrl !== undefined);
        assert.notInclude(launch.args.join(" "), launch.hookUrl);
        assert.include(plugin, "grok-tool-hooks");
        if ((yield* HostProcess.Platform) !== "win32") {
          assert.equal(
            (yield* fs.stat(path.join(plugin, "hooks", "hooks.json"))).mode & 0o777,
            0o600,
          );
        }
        const configPath = path.join(plugin, "hooks", "hooks.json");
        const config = yield* fs.readFileString(configPath);
        assert.include(config, '"PostToolUse"');
        assert.include(config, '"type":"http"');
        assert.include(config, "${T3_GROK_TOOL_OUTPUT_HOOK_URL}");
        assert.notInclude(config, launch.hookUrl);
        const url = new URL(launch.hookUrl);
        assert.equal(url.hostname, "127.0.0.1");
        assert.equal(url.port, "43123");
        const authorization = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`;
        assert.deepEqual(
          yield* hooks.redactHookOutput(authorization, {
            type: "Bash",
            output_for_prompt: "hook-process-private",
          }),
          {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              updatedToolOutput: { type: "Bash", output_for_prompt: "[REDACTED]" },
            },
          },
        );
        yield* close(runtime.providerSessionId);
        assert.isFalse(yield* fs.exists(plugin));
        const result = yield* hooks
          .redactHookOutput(authorization, "hook-process-private")
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }),
    ),
);
