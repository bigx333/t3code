import { ThreadSecretName } from "@t3tools/contracts";
import { SecretRequestError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { secretRequestDisplay, secretRequestFailureMessage } from "./secretRequest.ts";

describe("secretRequestDisplay", () => {
  it("identifies the saved environment variable and keeps named requests answerable", () => {
    const name = ThreadSecretName.make("GITHUB_TOKEN");
    expect(secretRequestDisplay({ secretStatus: "pending", name }, "local")).toEqual({
      kind: "pending",
    });
    expect(secretRequestDisplay({ secretStatus: "saved", name }, "local")).toEqual({
      kind: "answered",
      outcome: "saved",
      label: "Saved. Available to this thread as $GITHUB_TOKEN.",
    });
  });

  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
    expect(
      secretRequestDisplay(
        { secretStatus: "saved", name: ThreadSecretName.make("GITHUB_TOKEN") },
        "inherited",
      ),
    ).toMatchObject({ label: "Saved in the original thread as $GITHUB_TOKEN." });
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
