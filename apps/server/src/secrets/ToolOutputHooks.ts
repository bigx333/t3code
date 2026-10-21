import type { ThreadId } from "@t3tools/contracts";
import { AgentSecrets } from "@t3tools/shared/AgentSecrets";
import {
  AgentToolOutputHooks,
  type AgentToolOutputHooksShape,
} from "@t3tools/shared/AgentToolOutputHooks";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";

import * as ServerConfig from "../config.ts";
import { formatHostForUrl, isWildcardHost, loopbackUrlHostForAddress } from "../startupAccess.ts";

export const TOOL_OUTPUT_HOOK_PATH = "/api/internal/tool-output-hook";

export class ToolOutputHookUnauthorized extends Schema.TaggedError<ToolOutputHookUnauthorized>()(
  "ToolOutputHookUnauthorized",
  {},
) {}

export class ToolOutputHooks extends Context.Service<
  ToolOutputHooks,
  {
    readonly register: AgentToolOutputHooksShape["register"];
    readonly redactHookOutput: (
      authorization: string | undefined,
      toolResponse: unknown,
    ) => Effect.Effect<
      | { hookSpecificOutput: { hookEventName: "PostToolUse"; updatedToolOutput: unknown } }
      | Record<string, never>,
      ToolOutputHookUnauthorized
    >;
  }
>()("t3/secrets/ToolOutputHooks") {}

export const layerWithOrigin = (origin: string) =>
  Layer.effect(
    ToolOutputHooks,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const secrets = yield* AgentSecrets;
      const threadsByAuthorization = new Map<string, ThreadId>();
      const register = Effect.fn("ToolOutputHooks.register")(function* (threadId: ThreadId) {
        const token = Buffer.from(yield* crypto.randomBytes(32).pipe(Effect.orDie)).toString(
          "base64url",
        );
        const authorization = `Basic ${Buffer.from(`t3:${token}`).toString("base64")}`;
        const url = new URL(TOOL_OUTPUT_HOOK_PATH, origin);
        // Grok 1.0.62 ignores hook headers but translates URL credentials to Basic auth.
        url.username = "t3";
        url.password = token;
        yield* Effect.acquireRelease(
          Effect.sync(() => threadsByAuthorization.set(authorization, threadId)),
          () => Effect.sync(() => threadsByAuthorization.delete(authorization)),
        );
        return { url: url.href };
      });
      const redactHookOutput = Effect.fn("ToolOutputHooks.redactHookOutput")(function* (
        authorization: string | undefined,
        toolResponse: unknown,
      ) {
        const threadId =
          authorization === undefined ? undefined : threadsByAuthorization.get(authorization);
        if (threadId === undefined) return yield* new ToolOutputHookUnauthorized();
        const { redactor } = yield* secrets.snapshot(threadId);
        const updatedToolOutput = redactor.redactValue(toolResponse);
        return Object.is(updatedToolOutput, toolResponse)
          ? {}
          : { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput } };
      });
      return ToolOutputHooks.of({ register, redactHookOutput });
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    const config = yield* ServerConfig.ServerConfig;
    if (typeof address === "string" || !("port" in address)) {
      return yield* Effect.die(new Error("Tool output hooks require a TCP listener."));
    }
    const host =
      config.host && !isWildcardHost(config.host)
        ? formatHostForUrl(config.host)
        : loopbackUrlHostForAddress(address);
    return layerWithOrigin(`http://${host}:${address.port}`);
  }),
);

export const layerAgentHooks = Layer.effect(
  AgentToolOutputHooks,
  Effect.map(ToolOutputHooks, ({ register }) => ({ register })),
);
