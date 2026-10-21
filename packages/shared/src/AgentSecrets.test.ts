import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { AgentSecrets, withAgentSecrets } from "./AgentSecrets.ts";
import * as HostProcess from "./HostProcess.ts";
import { emptySecretRedactor } from "./secretRedaction.ts";

it.effect("merges secrets at each call and gives them precedence", () => {
  let value = "initial";
  return Effect.gen(function* () {
    expect(
      yield* withAgentSecrets({ TOKEN: "instance", EXTRA: "kept" }, ThreadId.make("a")),
    ).toEqual({
      TOKEN: "initial",
      EXTRA: "kept",
    });
    value = "rotated";
    expect(yield* withAgentSecrets(undefined, ThreadId.make("a"))).toEqual({
      TOKEN: "rotated",
      HOST: "kept",
    });
  }).pipe(
    Effect.provideService(HostProcess.Environment, { TOKEN: "host", HOST: "kept" }),
    Effect.provideService(AgentSecrets, {
      redactor: Effect.succeed(emptySecretRedactor),
      snapshot: () =>
        Effect.sync(() => ({
          revision: 1,
          environment: { TOKEN: value },
          redactor: emptySecretRedactor,
        })),
    }),
  );
});
