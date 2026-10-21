import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { TOOL_OUTPUT_HOOK_PATH, ToolOutputHooks } from "./ToolOutputHooks.ts";

const HookInput = Schema.Struct({
  hook_event_name: Schema.Literal("PostToolUse"),
  tool_response: Schema.Unknown,
});

export const layer = HttpRouter.add(
  "POST",
  TOOL_OUTPUT_HOOK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const hooks = yield* ToolOutputHooks;
    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(HookInput)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (input === undefined) return HttpServerResponse.empty({ status: 400 });
    return yield* hooks.redactHookOutput(request.headers.authorization, input.tool_response).pipe(
      Effect.flatMap(HttpServerResponse.json),
      Effect.catchTags({
        ToolOutputHookUnauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
      }),
    );
  }),
);
