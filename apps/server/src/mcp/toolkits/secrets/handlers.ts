import * as Effect from "effect/Effect";

import * as SecretShell from "../../../secrets/SecretShell.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SecretsToolkit } from "./tools.ts";

const handlers = {
  t3_secret_shell: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "t3_secret_shell");
      const service = yield* SecretShell.SecretShell;
      return yield* service.run(thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof SecretsToolkit.tools>;

export const layer = McpToolAccess.toLayer(SecretsToolkit, handlers);
