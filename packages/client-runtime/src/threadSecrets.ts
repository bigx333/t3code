import { ThreadSecretSetInput, type ThreadSecretSummary, type ThreadId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeSecretInput = Schema.decodeUnknownResult(ThreadSecretSetInput);

export function threadSecretInput(draft: {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}): ThreadSecretSetInput | null {
  const result = decodeSecretInput(draft);
  return Result.isSuccess(result) ? result.success : null;
}

export function sortedThreadSecrets(secrets: readonly ThreadSecretSummary[]) {
  return [...secrets].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.threadId.localeCompare(right.threadId),
  );
}

export const THREAD_SECRET_FAILURE_MESSAGE = "Could not update the secret. Try again.";
