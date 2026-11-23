import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { matchComposerModelItems } from "./composerModelMentions";

function model(slug: string, name: string, extra: Partial<ServerProviderModel> = {}) {
  return { slug, name, isCustom: false, capabilities: {}, ...extra } satisfies ServerProviderModel;
}

function provider(
  instanceId: string,
  driver: string,
  displayName: string,
  models: ReadonlyArray<ServerProviderModel>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [...models],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const traex = provider("traex", "codex", "Traex", [
  model("gpt-6.1", "GPT-6.1"),
  model("gpt-5", "GPT-5", { isLegacy: true }),
]);
const opencode = provider("opencode", "opencode", "OpenCode", [
  model("traex/gpt-6.1", "GPT-6.1", { subProvider: "Traex" }),
  model("anthropic/opus", "Claude Opus 5.5", { subProvider: "Anthropic" }),
]);
const claude = provider("claudeAgent", "claudeAgent", "Claude", [
  model("claude-opus-5-5", "Claude Opus 5.5"),
]);

function match(query: string, providers: ReadonlyArray<ServerProvider>): string[] {
  const instanceEntries = deriveProviderInstanceEntries(providers);
  return matchComposerModelItems({
    instanceEntries,
    modelOptionsByInstance: new Map(
      instanceEntries.map((entry) => [entry.instanceId, entry.models]),
    ),
    query,
  }).map((item) => `${item.instanceId}:${item.model}`);
}

describe("matchComposerModelItems", () => {
  it("finds a current model under every provider that serves it, skipping legacy ones", () => {
    expect(match("gpt", [traex, opencode, claude]).toSorted()).toEqual([
      "opencode:traex/gpt-6.1",
      "traex:gpt-6.1",
    ]);
  });

  it.each([
    ["errored", { status: "error" as const }],
    ["disabled", { enabled: false }],
    ["unavailable", { availability: "unavailable" as const }],
  ])("leaves out a provider that is %s", (_state, overrides) => {
    expect(match("gpt", [{ ...traex, ...overrides }, opencode])).toEqual([
      "opencode:traex/gpt-6.1",
    ]);
  });

  it("keeps a provider whose health check only warns before sign-in is confirmed", () => {
    expect(match("opus", [{ ...claude, status: "warning", auth: { status: "unknown" } }])).toEqual([
      "claudeAgent:claude-opus-5-5",
    ]);
  });
});
