import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as HostProcess from "./HostProcess.ts";
import { emptySecretRedactor, type SecretRedactor } from "./secretRedaction.ts";

export interface AgentSecretsShape {
  readonly snapshot: (threadId: ThreadId | undefined) => Effect.Effect<{
    revision: number;
    environment: Readonly<Record<string, string>>;
    redactor: SecretRedactor;
  }>;
  readonly redactor: Effect.Effect<SecretRedactor>;
}

export const AgentSecrets = Context.Reference<AgentSecretsShape>("@t3tools/shared/AgentSecrets", {
  defaultValue: () => ({
    snapshot: () => Effect.succeed({ revision: 0, environment: {}, redactor: emptySecretRedactor }),
    redactor: Effect.succeed(emptySecretRedactor),
  }),
});

export const withAgentSecrets = Effect.fnUntraced(function* (
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
  threadId: ThreadId | undefined,
): Effect.fn.Return<Record<string, string | undefined>> {
  const secrets = yield* AgentSecrets;
  const { environment } = yield* secrets.snapshot(threadId);
  return { ...(env ?? (yield* HostProcess.Environment)), ...environment };
});
