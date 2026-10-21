import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const RESERVED_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TERM",
  "LANG",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_PORT",
  "PORT",
  "APPIMAGE",
  "APPDIR",
  "ARGV0",
  "OWD",
  "GSETTINGS_SCHEMA_DIR",
  "COLORTERM",
  "BROWSER",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ACCESS_TOKEN",
  "XAI_API_KEY",
  "META_API_KEY",
  "DEVIN_TOKEN",
  "GCLOUD_PROJECT",
  "ENABLE_CLAUDEAI_MCP_SERVERS",
  "AGENT_CLI_CREDENTIAL_STORE",
  "UV_TOOL_DIR",
  "UV_TOOL_BIN_DIR",
  "ANTHROPIC_*",
  "CLAUDE_*",
  "CODEX_*",
  "OPENCODE_*",
  "CURSOR_*",
  "GROK_*",
  "GEMINI_*",
  "GOOGLE_*",
  "CLOUDSDK_*",
  "ANTIGRAVITY_*",
  "AGY_*",
  "AGENT_DEVICE_*",
  "PI_*",
  "MUSE_*",
  "VITE_*",
  "LC_*",
  "LD_*",
  "DYLD_*",
  "XDG_*",
  "T3CODE_*",
  "T3_*",
];

export const ThreadSecretName = Schema.String.check(
  Schema.isPattern(/^[A-Z_][A-Z0-9_]{0,127}$/),
  Schema.makeFilter(
    (name) =>
      !RESERVED_NAMES.some((reserved) =>
        reserved.endsWith("*") ? name.startsWith(reserved.slice(0, -1)) : name === reserved,
      ) ||
      "This name controls provider authentication or process behavior. Save it under a different name and export it inside the command (e.g. OPENAI_API_KEY=$MY_OPENAI_KEY cmd).",
  ),
).pipe(Schema.brand("ThreadSecretName"));
export type ThreadSecretName = typeof ThreadSecretName.Type;

export const ThreadSecretSummary = Schema.Struct({
  threadId: ThreadId,
  name: ThreadSecretName,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadSecretSummary = typeof ThreadSecretSummary.Type;

export const ThreadSecretListResult = Schema.Struct({
  secrets: Schema.Array(ThreadSecretSummary),
});
export type ThreadSecretListResult = typeof ThreadSecretListResult.Type;

export const ThreadSecretSetInput = Schema.Struct({
  threadId: ThreadId,
  name: ThreadSecretName,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  value: TrimmedNonEmptyString,
});
export type ThreadSecretSetInput = typeof ThreadSecretSetInput.Type;

export const ThreadSecretRemoveInput = Schema.Struct({
  threadId: ThreadId,
  name: ThreadSecretName,
});

export class ThreadSecretError extends Schema.TaggedError<ThreadSecretError>()(
  "ThreadSecretError",
  {
    operation: Schema.Literals(["set", "remove"]),
    name: ThreadSecretName,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the thread secret ${this.name}.`;
  }
}
