import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretShell from "../../../secrets/SecretShell.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SecretShellTool = Tool.make("t3_secret_shell", {
  description:
    "Run a shell command with this thread's saved secrets available as environment variables ($NAME). Requires auto or full-access mode. Output is redacted before you see it. Prefer this tool for commands that need secrets; built-in shell output is not always redacted before the model sees it. Never print secret values. timeoutMs defaults to 120000 and may not exceed 600000. Output keeps the last 256 KiB.",
  parameters: SecretShell.SecretShellInput,
  success: SecretShell.SecretShellResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    SecretShell.SecretShell,
  ],
})
  .annotate(Tool.Title, "Run a command with thread secrets")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const SecretsToolkit = Toolkit.make(SecretShellTool);
