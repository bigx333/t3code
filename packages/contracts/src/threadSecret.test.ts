import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadSecretName, ThreadSecretSetInput } from "./threadSecret.ts";

const decodeName = Schema.decodeUnknownSync(ThreadSecretName);
const isName = Schema.is(ThreadSecretName);

describe("thread secret names", () => {
  it.each(["GITHUB_TOKEN", "_KEY", "A", "TOKEN_123", "A".repeat(128)])("accepts %s", (name) => {
    expect(decodeName(name)).toBe(name);
  });
  it.each([
    "",
    "token",
    "1TOKEN",
    "A-B",
    "A".repeat(129),
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "PWD",
    "TMPDIR",
    "TERM",
    "LANG",
    "NODE_OPTIONS",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "GEMINI_HOME",
    "LC_ALL",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "XDG_CONFIG_HOME",
    "T3CODE_HOME",
    "T3_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_ENV_FILE",
    "ENABLE_CLAUDEAI_MCP_SERVERS",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "ACCESS_TOKEN",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_CONFIG_CONTENT",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "CURSOR_API_ENDPOINT",
    "AGENT_CLI_CREDENTIAL_STORE",
    "GROK_AUTH",
    "XAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "ANTIGRAVITY_HARNESS_PATH",
    "AGY_ACP_ENABLE_OAUTH",
    "AGENT_DEVICE_DAEMON_TOKEN",
    "PI_CODING_AGENT_DIR",
    "MUSE_CHANNEL",
    "META_API_KEY",
    "UV_TOOL_DIR",
    "UV_TOOL_BIN_DIR",
    "DEVIN_TOKEN",
    "BASH_ENV",
    "ENV",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_PORT",
    "PORT",
    "VITE_HTTP_URL",
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
  ])("rejects %s", (name) => {
    expect(isName(name)).toBe(false);
  });
  it("explains how to use a provider credential without changing provider behavior", () => {
    expect(() => decodeName("OPENAI_API_KEY")).toThrow(
      "Save it under a different name and export it inside the command",
    );
    expect(() => decodeName("OPENAI_API_KEY")).toThrow("OPENAI_API_KEY=$MY_OPENAI_KEY cmd");
  });
  it("preserves interior whitespace and rejects blank values", () => {
    const decode = Schema.decodeUnknownSync(ThreadSecretSetInput);
    expect(
      decode({ threadId: "thread-a", name: "TOKEN", label: "Token", value: "  a b\nc  " }).value,
    ).toBe("a b\nc");
    expect(() =>
      decode({ threadId: "thread-a", name: "TOKEN", label: "Token", value: "  " }),
    ).toThrow();
  });
});
