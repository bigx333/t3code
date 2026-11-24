import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { invite: vi.fn() },
}));

vi.mock("react-native", () => ({ View: Children, Alert: { alert: vi.fn() } }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  groupByProvider: () => [],
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    settings: { ...DEFAULT_SERVER_SETTINGS, groupConversationsEnabled: true },
  }),
  useQuietThreadShell: () => ({
    projectId: "project",
    runtimeMode: "full-access",
    lineage: { sideChat: false, relationshipToParent: null },
  }),
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { inviteToGroup: { permissionAtom: () => ({}) } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.invite }));
vi.mock("./ThreadSettingsSheet", () => ({
  ThreadSettingsPickerScreen: (props: {
    onSelectModel: (option: { selection: unknown }) => void;
  }) => (
    <button
      onClick={() => props.onSelectModel({ selection: { instanceId: "codex", model: "gpt-5" } })}
    >
      invite
    </button>
  ),
}));

import { ThreadGroupInviteScreen } from "./ThreadGroupInviteScreen";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.invite.mockReset();
  mocks.invite.mockResolvedValue(AsyncResult.success(undefined));
});
afterEach(() => act(() => root.unmount()));

it("records a mobile group invite as created on mobile", async () => {
  const environmentId = EnvironmentId.make("environment");
  const threadId = ThreadId.make("thread");
  act(() =>
    root.render(<ThreadGroupInviteScreen route={{ params: { environmentId, threadId } }} />),
  );

  await act(async () => container.querySelector("button")!.click());

  expect(mocks.invite).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId,
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      creationSource: "mobile",
    },
  });
});
