import { ThreadSecretName, ThreadId, type ThreadSecretSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { threadSecretInput, sortedThreadSecrets } from "./threadSecrets.ts";

const threadId = ThreadId.make("thread-1");
const draft = { threadId, name: "GITHUB_TOKEN", label: "GitHub", value: " token-value " };

describe("threadSecretInput", () => {
  it("validates names and rejects reserved variables or empty fields", () => {
    expect(threadSecretInput(draft)).toEqual({ ...draft, value: "token-value" });
    for (const name of ["PATH", "T3CODE_TOKEN", "LC_ALL", "lowercase", "A-B", ""]) {
      expect(threadSecretInput({ ...draft, name })).toBeNull();
    }
    expect(threadSecretInput({ ...draft, value: "  " })).toBeNull();
    expect(threadSecretInput({ ...draft, label: "  " })).toBeNull();
  });

  it("requires the owning thread", () => {
    const { threadId: _threadId, ...unscoped } = draft;
    // @ts-expect-error Every secret mutation needs its owning thread.
    expect(threadSecretInput(unscoped)).toBeNull();
  });
});

describe("sortedThreadSecrets", () => {
  it("lists summaries by name without changing the source list", () => {
    const summary = (name: string, owner = threadId): ThreadSecretSummary => ({
      threadId: owner,
      name: ThreadSecretName.make(name),
      label: name,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const secrets = [
      summary("Z_TOKEN"),
      summary("A_KEY", ThreadId.make("thread-2")),
      summary("A_KEY"),
    ];
    expect(sortedThreadSecrets(secrets)).toEqual([secrets[2], secrets[1], secrets[0]]);
    expect(secrets.map((secret) => secret.name)).toEqual(["Z_TOKEN", "A_KEY", "A_KEY"]);
  });
});
