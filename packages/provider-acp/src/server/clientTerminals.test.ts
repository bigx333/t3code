import { AgentSecrets } from "@t3tools/shared/AgentSecrets";
import { ThreadId } from "@t3tools/contracts";
import { makeSecretRedactor } from "@t3tools/shared/secretRedaction";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  makeAcpClientTerminals,
  resolveEmbeddedTerminalContent,
  type AcpClientTerminals,
} from "./clientTerminals.ts";

const withTerminals = <A, E>(use: (terminals: AcpClientTerminals) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const terminals = yield* makeAcpClientTerminals({
      defaultCwd: process.cwd(),
      threadForSession: (sessionId) => ThreadId.make(sessionId),
    });
    return yield* use(terminals).pipe(Effect.ensuring(terminals.disposeAll));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("AcpClientTerminals", () => {
  it.effect("isolates terminal injection and redaction by the creating session's thread", () =>
    Effect.gen(function* () {
      const threadA = ThreadId.make("thread-a");
      const threadB = ThreadId.make("thread-b");
      const terminals = yield* makeAcpClientTerminals({
        defaultCwd: process.cwd(),
        threadForSession: (sessionId) =>
          sessionId === "a" ? threadA : sessionId === "b" ? threadB : undefined,
      });
      yield* Effect.gen(function* () {
        for (const [sessionId, expected] of [
          ["a", "[REDACTED]|missing|[REDACTED]|b-secret"],
          ["b", "missing|[REDACTED]|a-secret|[REDACTED]"],
          ["unknown", "missing|missing|a-secret|b-secret"],
        ] as const) {
          const { terminalId } = yield* terminals.create({
            sessionId,
            command: process.execPath,
            args: [
              "-e",
              'process.stdout.write([process.env.A_SECRET ?? "missing", process.env.B_SECRET ?? "missing", "a-secret", "b-secret"].join("|"))',
            ],
          });
          yield* terminals.waitForExit({ sessionId, terminalId });
          expect((yield* terminals.output({ sessionId, terminalId })).output).toBe(expected);
          expect(terminals.readOutputSnapshot(sessionId, terminalId)?.output).toBe(expected);
        }
      }).pipe(Effect.ensuring(terminals.disposeAll));
    }).pipe(
      Effect.provideService(AgentSecrets, {
        snapshot: (threadId) => {
          const environment: Record<string, string> =
            threadId === "thread-a"
              ? { A_SECRET: "a-secret" }
              : threadId === "thread-b"
                ? { B_SECRET: "b-secret" }
                : {};
          return Effect.succeed({
            revision: 1,
            environment,
            redactor: makeSecretRedactor(Object.values(environment)),
          });
        },
        redactor: Effect.succeed(makeSecretRedactor(["a-secret", "b-secret"])),
      }),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  );

  it.effect(
    "injects secrets after request env and redacts terminal output returned to the agent",
    () =>
      withTerminals((terminals) =>
        Effect.gen(function* () {
          const sessionId = "session-secrets";
          const created = yield* terminals.create({
            sessionId,
            command: process.execPath,
            args: ["-e", "process.stdout.write(process.env.TEST_SECRET ?? '')"],
            env: [{ name: "TEST_SECRET", value: "request" }],
          });
          yield* terminals.waitForExit({ sessionId, terminalId: created.terminalId });
          const result = yield* terminals.output({ sessionId, terminalId: created.terminalId });
          expect(result.output).toBe("[REDACTED]");
        }),
      ).pipe(
        Effect.provideService(AgentSecrets, {
          redactor: Effect.succeed(makeSecretRedactor([])),
          snapshot: () =>
            Effect.succeed({
              revision: 1,
              environment: { TEST_SECRET: "terminal-secret" },
              redactor: makeSecretRedactor(["terminal-secret"]),
            }),
        }),
      ),
  );

  it.effect("redacts terminal chunks before the output byte limit discards a secret prefix", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const sessionId = "trim-secret";
        const { terminalId } = yield* terminals.create({
          sessionId,
          command: process.execPath,
          args: ["-e", 'process.stdout.write("terminal-"); process.stdout.write("secret")'],
          outputByteLimit: 5,
        });
        yield* terminals.waitForExit({ sessionId, terminalId });
        const result = yield* terminals.output({ sessionId, terminalId });
        expect(result.output).toBe("CTED]");
        expect(result.truncated).toBe(true);
        expect(terminals.readOutputSnapshot(sessionId, terminalId)?.output).toBe("CTED]");
      }),
    ).pipe(
      Effect.provideService(AgentSecrets, {
        redactor: Effect.succeed(makeSecretRedactor([])),
        snapshot: () =>
          Effect.succeed({
            revision: 1,
            environment: {},
            redactor: makeSecretRedactor(["terminal-secret"]),
          }),
      }),
    ),
  );

  it.effect("runs a command, buffers output, and reports the exit status", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "console.log('hello from acp'); process.exit(3);"],
        });

        const exit = yield* terminals.waitForExit({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(exit.exitCode).toBe(3);

        const output = yield* terminals.output({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(output.output).toContain("hello from acp");
        expect(output.truncated).toBe(false);
        expect(output.exitStatus?.exitCode).toBe(3);
      }),
    ),
  );

  it.effect("resolves terminal environment from the requesting ACP session", () =>
    Effect.gen(function* () {
      const terminals = yield* makeAcpClientTerminals({
        defaultCwd: process.cwd(),
        environmentForSession: (sessionId) => ({
          T3_TEST_ACP_SESSION_TOKEN: sessionId === "session-a" ? "token-a" : "token-b",
        }),
      });
      yield* Effect.addFinalizer(() => terminals.disposeAll);

      for (const [sessionId, expected] of [
        ["session-a", "token-a"],
        ["session-b", "token-b"],
      ] as const) {
        const created = yield* terminals.create({
          sessionId,
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.env.T3_TEST_ACP_SESSION_TOKEN ?? '')"],
        });
        yield* terminals.waitForExit({ sessionId, terminalId: created.terminalId });
        const output = yield* terminals.output({ sessionId, terminalId: created.terminalId });
        expect(output.output).toBe(expected);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("runs Devin shell source with arguments, pipes, and session fallback variables", () =>
    Effect.gen(function* () {
      const terminals = yield* makeAcpClientTerminals({
        defaultCwd: process.cwd(),
        shellCommands: true,
        environmentForSession: () => ({ T3_ACP_MCP_NODE: "mailbox-probe" }),
      });
      yield* Effect.addFinalizer(() => terminals.disposeAll);
      const terminal = yield* terminals.create({
        sessionId: "devin",
        command: 'printf "%s\\n" "$T3_ACP_MCP_NODE" | tr a-z A-Z',
      });
      const exit = yield* terminals.waitForExit({ sessionId: "devin", ...terminal });
      const output = yield* terminals.output({ sessionId: "devin", ...terminal });
      expect(exit.exitCode).toBe(0);
      expect(output.output.trim()).toBe("MAILBOX-PROBE");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("truncates buffered output from the beginning at the byte limit", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "process.stdout.write('a'.repeat(64) + 'TAIL');"],
          outputByteLimit: 16,
        });
        yield* terminals.waitForExit({ sessionId: "session", terminalId: created.terminalId });

        const output = yield* terminals.output({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(output.truncated).toBe(true);
        expect(output.output.endsWith("TAIL")).toBe(true);
        expect(output.output.length).toBeLessThanOrEqual(16);
      }),
    ),
  );

  it.effect("kills long-running commands and rejects released terminal handles", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000);"],
        });
        yield* terminals.kill({ sessionId: "session", terminalId: created.terminalId });
        const exit = yield* terminals.waitForExit({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(exit.exitCode === 0 ? null : exit.exitCode).not.toBe(0);
        // Windows has no signals: a killed process only reports an exit code.
        if (yield* HostProcess.isWindows) {
          expect(exit.signal).toBeNull();
        } else {
          expect(exit.signal).toBe("SIGTERM");
        }

        yield* terminals.release({ sessionId: "session", terminalId: created.terminalId });
        const rejected = yield* Effect.flip(
          terminals.output({ sessionId: "session", terminalId: created.terminalId }),
        );
        expect(rejected.message).toContain("unknown terminal ID");

        expect(terminals.readOutputSnapshot("session", created.terminalId)).toBeDefined();
      }),
    ),
  );

  it.effect("reserves terminal capacity across concurrent creates", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          Array.from({ length: 17 }, () =>
            terminals
              .create({
                sessionId: "session",
                command: process.execPath,
                args: ["-e", "setInterval(() => {}, 1000);"],
              })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );

        expect(results.filter(Result.isSuccess)).toHaveLength(16);
        expect(results.filter(Result.isFailure)).toHaveLength(1);
      }),
    ),
  );

  it.effect("bounds unreleased terminal handles without invalidating existing ids", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const terminalIds: string[] = [];
        for (let index = 0; index < 64; index += 1) {
          const created = yield* terminals.create({
            sessionId: "session",
            command: process.execPath,
            args: ["-e", `process.stdout.write('${index}');`],
          });
          yield* terminals.waitForExit({
            sessionId: "session",
            terminalId: created.terminalId,
          });
          terminalIds.push(created.terminalId);
        }

        const rejected = yield* terminals
          .create({
            sessionId: "session",
            command: process.execPath,
            args: ["-e", ""],
          })
          .pipe(Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        expect(terminals.readOutputSnapshot("session", terminalIds[0]!)).toBeDefined();
        expect(terminals.readOutputSnapshot("session", terminalIds.at(-1)!)).toBeDefined();
      }),
    ),
  );

  it.effect("bounds aggregate output retained across unreleased terminals", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const terminalIds: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const created = yield* terminals.create({
            sessionId: "session",
            command: process.execPath,
            args: ["-e", "process.stdout.write('x'.repeat(8 * 1024 * 1024));"],
            outputByteLimit: 8 * 1024 * 1024,
          });
          yield* terminals.waitForExit({
            sessionId: "session",
            terminalId: created.terminalId,
          });
          terminalIds.push(created.terminalId);
        }

        const snapshots = terminalIds.map((terminalId) =>
          terminals.readOutputSnapshot("session", terminalId)!,
        );
        const retainedBytes = snapshots.reduce(
          (total, snapshot) => total + Buffer.byteLength(snapshot.output),
          0,
        );
        expect(retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
        expect(snapshots.some((snapshot) => snapshot.truncated)).toBe(true);
      }),
    ),
  );

  it.effect("rejects terminal handles from a different ACP session", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "owner-session",
          command: process.execPath,
          args: ["-e", "process.stdout.write('owned');"],
        });
        const foreignRequest = {
          sessionId: "foreign-session",
          terminalId: created.terminalId,
        };
        const results = yield* Effect.all(
          [
            terminals.output(foreignRequest),
            terminals.waitForExit(foreignRequest),
            terminals.kill(foreignRequest),
            terminals.release(foreignRequest),
          ].map((effect) => effect.pipe(Effect.result)),
          { concurrency: "unbounded" },
        );

        expect(results.every(Result.isFailure)).toBe(true);
        expect(terminals.readOutputSnapshot("foreign-session", created.terminalId)).toBeUndefined();
        expect(terminals.readOutputSnapshot("owner-session", created.terminalId)).toBeDefined();
      }),
    ),
  );
});

describe("resolveEmbeddedTerminalContent", () => {
  it("rewrites terminal content into text from the buffered snapshot", () => {
    const notification = {
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call_update" as const,
        toolCallId: "call-1",
        content: [
          { type: "content" as const, content: { type: "text" as const, text: "before" } },
          { type: "terminal" as const, terminalId: "t3-term-1" },
          { type: "terminal" as const, terminalId: "t3-term-unknown" },
        ],
      },
    };

    const resolved = resolveEmbeddedTerminalContent(notification, (sessionId, terminalId) =>
      sessionId === "session" && terminalId === "t3-term-1"
        ? { output: "compiled 3 files", truncated: false, exitStatus: undefined }
        : undefined,
    );

    expect(resolved.update).toMatchObject({
      content: [
        { type: "content", content: { type: "text", text: "before" } },
        { type: "content", content: { type: "text", text: "compiled 3 files" } },
        { type: "content", content: { type: "text", text: "[terminal t3-term-unknown]" } },
      ],
    });
  });
});
