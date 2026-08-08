import { describe, expect, it } from "vitest";
import {
  normalizeAgentRuntimeCapabilities,
  supportsSessionConfigOptions,
} from "./runtime-capabilities";

const V030_INIT = {
  protocolVersion: 1,
  agentName: "Kimi Code CLI",
  agentVersion: "0.30.0",
  loadSession: true,
  promptImage: true,
  sessionConfigOptions: false,
  authMethods: [{ id: "login", name: "Login" }],
};

const V031_INIT = {
  ...V030_INIT,
  agentVersion: "0.31.0",
  sessionConfigOptions: true,
};

describe("runtime-capabilities", () => {
  it("normalizes v0.30 initialize without session config capability", () => {
    const caps = normalizeAgentRuntimeCapabilities(V030_INIT);
    expect(caps.agentVersion).toBe("0.30.0");
    expect(supportsSessionConfigOptions(caps)).toBe(false);
  });

  it("normalizes v0.31 initialize with session config capability", () => {
    const caps = normalizeAgentRuntimeCapabilities(V031_INIT);
    expect(caps.agentVersion).toBe("0.31.0");
    expect(supportsSessionConfigOptions(caps)).toBe(true);
  });

  it("does not embed session option values in runtime capabilities", () => {
    const caps = normalizeAgentRuntimeCapabilities({
      ...V031_INIT,
      // malicious/extra fields must be ignored by normalizer
      configOptions: [{ id: "model", currentValue: "kimi-k2" }],
    } as Record<string, unknown>);
    expect(JSON.stringify(caps)).not.toContain("kimi-k2");
  });
});
