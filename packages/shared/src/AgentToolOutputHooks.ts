import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface AgentToolOutputHooksShape {
  readonly register: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly url: string } | undefined, never, Scope.Scope>;
}

export const AgentToolOutputHooks = Context.Reference<AgentToolOutputHooksShape>(
  "@t3tools/shared/AgentToolOutputHooks",
  {
    defaultValue: () => ({ register: () => Effect.succeed(undefined) }),
  },
);
