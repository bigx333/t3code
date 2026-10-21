import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, ThreadSecretName } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NetAddress from "effect/net/NetAddress";
import { HttpServer, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AgentSecretsLive from "./AgentSecretsLive.ts";
import * as ThreadSecrets from "./ThreadSecrets.ts";
import * as ToolOutputHooks from "./ToolOutputHooks.ts";
import * as HookHttp from "./http.ts";

const origin = "http://127.0.0.1:43123";
const threadA = ThreadId.make("hook-thread-a");
const threadB = ThreadId.make("hook-thread-b");
const secret = 'private-"quoted"\nvalue';
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layerSecrets = AgentSecretsLive.layer.pipe(
  Layer.provideMerge(
    ThreadSecrets.layer.pipe(
      Layer.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "tool-output-hook-" })),
        ),
      ),
    ),
  ),
);
const layerTest = ToolOutputHooks.layerWithOrigin(origin).pipe(
  Layer.provideMerge(layerSecrets),
  Layer.provideMerge(NodeServices.layer),
);

const authorizationFor = (url: string) => {
  const parsed = new URL(url);
  return `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64")}`;
};

const setup = Effect.gen(function* () {
  const hooks = yield* ToolOutputHooks.ToolOutputHooks;
  const secrets = yield* ThreadSecrets.ThreadSecrets;
  yield* secrets.set({
    threadId: threadA,
    name: ThreadSecretName.make("TOKEN"),
    label: "A",
    value: secret,
  });
  yield* secrets.set({
    threadId: threadB,
    name: ThreadSecretName.make("TOKEN"),
    label: "B",
    value: "other-private",
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    HookHttp.layer.pipe(Layer.provide(Layer.succeed(ToolOutputHooks.ToolOutputHooks, hooks))),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const post = (authorization: string | undefined, toolResponse: unknown) =>
    Effect.promise(() =>
      handler(
        new Request(`${origin}${ToolOutputHooks.TOOL_OUTPUT_HOOK_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: encodeJson({ hook_event_name: "PostToolUse", tool_response: toolResponse }),
        }),
        Context.make(ToolOutputHooks.ToolOutputHooks, hooks),
      ),
    );
  const a = yield* hooks.register(threadA);
  const b = yield* hooks.register(threadB);
  assert(a !== undefined);
  assert(b !== undefined);
  return {
    hooks,
    post,
    authorizationA: authorizationFor(a.url),
    authorizationB: authorizationFor(b.url),
  };
});

it.effect("redacts nested and JSON-escaped tool output while preserving its tagged shape", () =>
  Effect.gen(function* () {
    const { post, authorizationA } = yield* setup;
    const toolResponse = {
      type: "Bash",
      exit_code: 0,
      output_for_prompt: `${secret} other-private`,
      nested: [{ text: secret }, { json: encodeJson({ credential: secret }) }],
    };
    const response = yield* post(authorizationA, toolResponse);
    assert.equal(response.status, 200);
    assert.deepEqual(yield* Effect.promise(() => response.json()), {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          type: "Bash",
          exit_code: 0,
          output_for_prompt: "[REDACTED] other-private",
          nested: [{ text: "[REDACTED]" }, { json: '{"credential":"[REDACTED]"}' }],
        },
      },
    });
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("returns an empty object for clean output and secrets owned by another thread", () =>
  Effect.gen(function* () {
    const { post, authorizationA, authorizationB } = yield* setup;
    for (const [authorization, output] of [
      [authorizationA, "clean output"],
      [authorizationB, secret],
      [authorizationA, "other-private"],
    ]) {
      const response = yield* post(authorization, { type: "Bash", output_for_prompt: output });
      assert.equal(response.status, 200);
      assert.deepEqual(yield* Effect.promise(() => response.json()), {});
    }
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("rejects missing, wrong and revoked credentials without revoking another spawn", () =>
  Effect.gen(function* () {
    const { hooks, post, authorizationA } = yield* setup;
    const scope = yield* Scope.make();
    const revoked = yield* hooks.register(threadA).pipe(Effect.provideService(Scope.Scope, scope));
    assert(revoked !== undefined);
    const revokedAuthorization = authorizationFor(revoked.url);
    assert.notEqual(revokedAuthorization, authorizationA);
    assert.equal((yield* post(revokedAuthorization, secret)).status, 200);
    yield* Scope.close(scope, Exit.void);
    for (const credential of [undefined, "Basic incorrect", revokedAuthorization]) {
      assert.equal((yield* post(credential, secret)).status, 401);
    }
    assert.equal((yield* post(authorizationA, secret)).status, 200);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("registers against the actual bound port when the configured port is zero", () =>
  Effect.gen(function* () {
    const hooks = yield* ToolOutputHooks.ToolOutputHooks;
    const binding = yield* hooks.register(threadA);
    assert(binding !== undefined);
    const url = new URL(binding.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "43124");
    assert.equal(url.pathname, ToolOutputHooks.TOOL_OUTPUT_HOOK_PATH);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ToolOutputHooks.layer.pipe(
        Layer.provide(
          Layer.succeed(HttpServer.HttpServer, {
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
            serve: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              return { ...config, port: 0, host: "0.0.0.0" };
            }),
          ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "hook-origin-" }))),
        ),
        Layer.provide(layerSecrets),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
