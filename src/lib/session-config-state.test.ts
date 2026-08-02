import { describe, expect, it } from "vitest";
import {
  applyConfigOptionWirePayload,
  canUseSessionConfigOption,
  emptySessionConfigState,
  getSessionConfigOptionValue,
  invalidateSessionConfig,
  isValidSessionConfigValue,
  normalizeSessionConfigState,
  prefersSetConfigOptionRpc,
  runtimeModesFromSessionModeValue,
  sessionHasConfigOption,
} from "./session-config-state";
import { normalizeAgentRuntimeCapabilities } from "./acp-capabilities";

describe("session-config-state", () => {
  it("resume without options stays unknown", () => {
    const state = normalizeSessionConfigState(
      { sessionId: "s1", status: "unknown", options: [] },
      "s1",
    );
    expect(state.status).toBe("unknown");
    expect(state.options).toHaveLength(0);
  });

  it("parses v0.31 session/new options", () => {
    const state = normalizeSessionConfigState(
      {
        sessionId: "s1",
        status: "known",
        options: [
          {
            id: "model",
            optionType: "select",
            currentValue: "kimi-k2",
            options: [{ value: "kimi-k2", label: "Kimi K2" }],
          },
        ],
      },
      "s1",
    );
    expect(state.status).toBe("known");
    expect(sessionHasConfigOption(state, "model")).toBe(true);
    expect(sessionHasConfigOption(state, "thinking")).toBe(false);
  });

  it("invalidates config on session switch/close", () => {
    const map = {
      s1: emptySessionConfigState("s1"),
      s2: emptySessionConfigState("s2"),
    };
    const next = invalidateSessionConfig(map, "s1");
    expect(next.s1).toBeUndefined();
    expect(next.s2?.sessionId).toBe("s2");
  });

  it("merges config_option_update wire payload", () => {
    const map = applyConfigOptionWirePayload({}, {
      session_id: "s1",
      status: "known",
      options: [
        { id: "mode", optionType: "select", currentValue: "auto", options: [] },
      ],
    });
    expect(map.s1?.options[0]?.currentValue).toBe("auto");
  });

  it("gates by declared option not version string", () => {
    const runtime = normalizeAgentRuntimeCapabilities({
      agentVersion: "0.31.0",
      sessionConfigOptions: true,
    });
    const withModel = normalizeSessionConfigState(
      {
        sessionId: "s1",
        status: "known",
        options: [{ id: "model", optionType: "select", currentValue: "x" }],
      },
      "s1",
    );
    const withoutModel = emptySessionConfigState("s1");

    expect(canUseSessionConfigOption(runtime, withModel, "model")).toBe(true);
    expect(canUseSessionConfigOption(runtime, withoutModel, "model")).toBe(
      false,
    );
    expect(
      canUseSessionConfigOption(
        { ...runtime, sessionConfigOptions: false },
        withModel,
        "model",
      ),
    ).toBe(true);
  });

  it("prefers set_config_option RPC only when runtime advertises it", () => {
    const runtime = normalizeAgentRuntimeCapabilities({ sessionConfigOptions: true });
    const withModel = normalizeSessionConfigState(
      {
        sessionId: "s1",
        status: "known",
        options: [{ id: "model", optionType: "select", currentValue: "x" }],
      },
      "s1",
    );
    expect(prefersSetConfigOptionRpc(runtime, withModel, "model")).toBe(true);
    expect(
      prefersSetConfigOptionRpc(
        { ...runtime, sessionConfigOptions: false },
        withModel,
        "model",
      ),
    ).toBe(false);
  });

  it("validates declared config values and maps mode snapshots", () => {
    const state = normalizeSessionConfigState(
      {
        sessionId: "s1",
        status: "known",
        options: [
          {
            id: "model",
            optionType: "select",
            currentValue: "kimi-k2",
            options: [{ value: "kimi-k2" }, { value: "kimi-coder" }],
          },
        ],
      },
      "s1",
    );
    expect(isValidSessionConfigValue(state, "model", "kimi-k2")).toBe(true);
    expect(isValidSessionConfigValue(state, "model", "missing")).toBe(false);
    expect(getSessionConfigOptionValue(state, "model")).toBe("kimi-k2");
    expect(runtimeModesFromSessionModeValue("auto")).toEqual({
      planMode: false,
      permissionMode: "auto",
    });
  });
});
