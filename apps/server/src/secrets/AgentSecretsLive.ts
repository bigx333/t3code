import { AgentSecrets, type AgentSecretsShape } from "@t3tools/shared/AgentSecrets";
import { emptySecretRedactor, makeSecretRedactor } from "@t3tools/shared/secretRedaction";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadSecrets from "./ThreadSecrets.ts";

const make = Effect.gen(function* () {
  const secrets = yield* ThreadSecrets.ThreadSecrets;
  const empty = { revision: 0, environment: {}, redactor: emptySecretRedactor };
  let currentValues: ReadonlyArray<string> = [];
  let currentRedactor = emptySecretRedactor;
  const cache = new Map<ThreadId, Effect.Success<ReturnType<AgentSecretsShape["snapshot"]>>>();
  // Snapshots run on each output chunk, under the caller's existing span.
  const snapshot: AgentSecretsShape["snapshot"] = Effect.fnUntraced(function* (threadId) {
    if (threadId === undefined) return empty;
    while (true) {
      const revision = yield* secrets.revision(threadId);
      const cached = cache.get(threadId);
      if (cached?.revision === revision) return cached;
      const environment = yield* secrets.environment(threadId);
      if ((yield* secrets.revision(threadId)) !== revision) continue;
      const current = {
        revision,
        environment,
        redactor: makeSecretRedactor(Object.values(environment)),
      };
      cache.set(threadId, current);
      return current;
    }
  });
  const redactor = secrets.redactionValues().pipe(
    Effect.map((values) => {
      if (
        values.length !== currentValues.length ||
        values.some((value, index) => value !== currentValues[index])
      ) {
        currentValues = values;
        currentRedactor = makeSecretRedactor(values);
      }
      return currentRedactor;
    }),
  );
  return { snapshot, redactor };
});

export const layer = Layer.effect(AgentSecrets, make);
