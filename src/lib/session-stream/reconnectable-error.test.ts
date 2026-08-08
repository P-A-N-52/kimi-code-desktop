import { describe, expect, it } from "vitest";
import { isReconnectableStreamError } from "./reconnectable-error";

describe("isReconnectableStreamError", () => {
  it("recognizes disconnected transports and replaced runtime workers", () => {
    expect(
      isReconnectableStreamError({
        error: new Error("Connection closed"),
        connectionPhase: "disconnected",
        sessionStatus: null,
      }),
    ).toBe(true);
    expect(
      isReconnectableStreamError({
        error: new Error("ACP session shutting down: worker was already replaced or disconnected"),
        connectionPhase: "connected",
        sessionStatus: null,
      }),
    ).toBe(true);
  });

  it("does not offer runtime reconnect for an ordinary prompt failure on a live connection", () => {
    expect(
      isReconnectableStreamError({
        error: new Error("Prompt rejected: invalid argument"),
        connectionPhase: "connected",
        sessionStatus: null,
      }),
    ).toBe(false);
  });
});
