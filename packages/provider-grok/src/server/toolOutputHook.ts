import { ThreadId } from "@t3tools/contracts";
import { AgentScopeThreadId } from "@t3tools/shared/AgentScope";
import { AgentToolOutputHooks } from "@t3tools/shared/AgentToolOutputHooks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const GROK_TOOL_OUTPUT_HOOK_URL_ENV = "T3_GROK_TOOL_OUTPUT_HOOK_URL";

const hookConfig = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
  hooks: {
    PostToolUse: [
      { hooks: [{ type: "http", url: "${T3_GROK_TOOL_OUTPUT_HOOK_URL}", timeout: 5 }] },
    ],
  },
});

export const makeGrokToolOutputHook = Effect.fn("GrokToolOutputHook.make")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hooks = yield* AgentToolOutputHooks;
  return Effect.fn("GrokToolOutputHook.acquire")(function* () {
    const threadId = yield* AgentScopeThreadId;
    if (threadId === undefined) return undefined;
    const binding = yield* hooks.register(ThreadId.make(threadId));
    if (binding === undefined) return undefined;
    const parent = path.join(stateDir, "grok-tool-hooks");
    yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
    const pluginDirectory = yield* fs.makeTempDirectoryScoped({
      directory: parent,
      prefix: "spawn-",
    });
    const hookDirectory = path.join(pluginDirectory, "hooks");
    yield* fs.makeDirectory(hookDirectory, { mode: 0o700 });
    yield* fs.writeFileString(path.join(hookDirectory, "hooks.json"), hookConfig, { mode: 0o600 });
    return { pluginDirectory, url: binding.url };
  });
});

export type GrokToolOutputHook = Effect.Success<ReturnType<typeof makeGrokToolOutputHook>>;
