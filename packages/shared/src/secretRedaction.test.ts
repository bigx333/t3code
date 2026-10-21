import { describe, expect, it } from "vite-plus/test";

import {
  emptySecretRedactor,
  makeSecretRedactor,
  makeSecretStreamRedactor,
  REDACTED,
} from "./secretRedaction.ts";

describe("secret redaction", () => {
  it("redacts literal, escaped and encoded values longest first", () => {
    const secret = 'token/"line\n';
    const redactor = makeSecretRedactor(["abc", "token", secret, "a.b[c]$^"]);
    expect(
      redactor.redactText(
        [
          secret,
          JSON.stringify(secret).slice(1, -1),
          encodeURIComponent(secret),
          "token",
          "a.b[c]$^",
          "abc",
        ].join("|"),
      ),
    ).toBe(`${REDACTED}|${REDACTED}|${REDACTED}|${REDACTED}|${REDACTED}|abc`);
  });

  it("copies only ancestors of changed string leaves", () => {
    const redactor = makeSecretRedactor(["my-secret"]);
    const untouched = { text: "ordinary", count: 2, nonFinite: Number.NaN };
    const unchangedArray = [Number.NaN, untouched];
    expect(redactor.redactValue(unchangedArray)).toBe(unchangedArray);
    const input = {
      unchanged: untouched,
      nested: [untouched, { text: "my-secret" }],
      date: new Map([["text", "my-secret"]]),
    };
    expect(redactor.redactValue(untouched)).toBe(untouched);
    const result = redactor.redactValue(input);
    expect(result).toEqual({ ...input, nested: [untouched, { text: REDACTED }] });
    expect(result.unchanged).toBe(untouched);
    expect(result.nested[0]).toBe(untouched);
    expect(result.date).toBe(input.date);
    expect(input.nested[1]).toEqual({ text: "my-secret" });
  });

  it("returns the original reference without walking when empty", () => {
    const value = {
      get text(): string {
        throw new Error("must not walk");
      },
    };
    expect(emptySecretRedactor.redactValue(value)).toBe(value);
    expect(makeSecretRedactor(["abc", ""]).isEmpty).toBe(true);
  });

  it.each([
    ["my-", "secret"],
    ["my", "-sec", "ret"],
  ])("redacts a secret split into chunks %j", (...chunks) => {
    const stream = makeSecretStreamRedactor(makeSecretRedactor(["my-secret"]));
    expect(chunks.map((chunk) => stream.push(chunk)).join("") + stream.flush()).toBe(REDACTED);
    expect(stream.flush()).toBe("");
  });

  it("passes non-secret text immediately and flushes a partial prefix", () => {
    const stream = makeSecretStreamRedactor(makeSecretRedactor(["my-secret"]));
    expect(stream.push("ordinary output\n")).toBe("ordinary output\n");
    expect(stream.push("next my-")).toBe("next ");
    expect(stream.flush()).toBe("my-");
  });

  it("handles every split of escaped and encoded needles", () => {
    const value = 'my/"secret\n';
    const redactor = makeSecretRedactor([value]);
    for (const needle of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
      for (let first = 1; first < needle.length; first++) {
        for (let second = first; second < needle.length; second++) {
          const stream = makeSecretStreamRedactor(redactor);
          const output =
            stream.push(needle.slice(0, first)) +
            stream.push(needle.slice(first, second)) +
            stream.push(needle.slice(second)) +
            stream.flush();
          expect(output).toBe(REDACTED);
        }
      }
    }
  });
  it("preserves structural fields while redacting arbitrary object keys without collisions", () => {
    const redactor = makeSecretRedactor(["turn", "postgres", "1234"]);
    const structural = {
      type: "turn.terminal",
      kind: "turn",
      status: "turn",
      role: "turn",
      driver: "turn",
      id: "1234",
      cwd: "/postgres",
      path: "/postgres",
      hookEventName: "turn",
      threadId: "1234",
      threadIds: ["1234"],
      nativeThreadRef: { id: "1234" },
      worktreePath: "/postgres",
    };
    expect(redactor.redactValue(structural)).toBe(structural);
    const untouched = { valid: true };
    const value = {
      ...structural,
      output: {
        "[REDACTED]": "existing",
        "[REDACTED]_1": "also existing",
        turn: untouched,
        "1234": "postgres",
        text: "turn postgres 1234",
      },
    };
    expect(redactor.redactValue(value)).toEqual({
      ...structural,
      output: {
        "[REDACTED]": "existing",
        "[REDACTED]_1": "also existing",
        "[REDACTED]_2": "[REDACTED]",
        "[REDACTED]_3": untouched,
        text: "[REDACTED] [REDACTED] [REDACTED]",
      },
    });
    expect(Object.values(redactor.redactValue({ output: { turn: untouched } }).output)[0]).toBe(
      untouched,
    );
    expect(value.output.turn).toBe(untouched);
  });
  it("holds raw prefixes when a secret extends another needle", () => {
    const stream = makeSecretStreamRedactor(makeSecretRedactor(["abcd", "abcdefgh"]));
    expect(stream.push("xxabcde")).toBe("xx");
    expect(stream.push("fgh") + stream.flush()).toBe(REDACTED);
  });
  it("flushes held output using the current secrets after deletion or replacement", () => {
    const original = makeSecretRedactor(["abcd", "abcdefgh"]);
    const deleted = makeSecretStreamRedactor(original);
    expect(deleted.push("xxabcde")).toBe("xx");
    expect(deleted.flush(emptySecretRedactor)).toBe("abcde");
    expect(deleted.hasPending).toBe(false);
    expect(deleted.flush()).toBe("");

    const replaced = makeSecretStreamRedactor(original);
    expect(replaced.push("xxabcde")).toBe("xx");
    expect(replaced.flush(makeSecretRedactor(["bcde"]))).toBe(`a${REDACTED}`);
  });
  it("withholds proper prefixes only in streaming content snapshots", () => {
    const redactor = makeSecretRedactor(["abcdefgh"]);
    const snapshot = {
      type: "reasoning",
      status: "running",
      text: "token abcdefg",
      id: "abcdefgh",
    };
    expect(redactor.redactValue(snapshot, { holdback: true })).toEqual({
      ...snapshot,
      text: "token ",
    });
    expect(redactor.redactValue(snapshot)).toBe(snapshot);
    expect(redactor.redactValue({ ...snapshot, text: "abcdefgh" }, { holdback: true })).toEqual({
      ...snapshot,
      text: REDACTED,
    });
  });
  it.each(["terminal-secret", "aaaa", "abcab"])(
    "does not cut a complete match when holding an overlapping prefix of %s",
    (value) => {
      for (let split = 0; split <= value.length; split++) {
        const stream = makeSecretStreamRedactor(makeSecretRedactor([value]));
        expect(
          stream.push(value.slice(0, split)) + stream.push(value.slice(split)) + stream.flush(),
        ).toBe(REDACTED);
      }
    },
  );
});
