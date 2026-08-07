import { describe, expect, it } from "vitest";
import {
  isSecondaryModelExperimentEnabled,
  resolveSecondaryModelOnEnable,
  shouldShowSecondaryModelSettings,
} from "./secondary-model";
import type { GlobalConfig } from "@/lib/api/models";

const baseConfig: GlobalConfig = {
  defaultModel: "kimi",
  defaultThinking: true,
  thinkingEffort: "high",
  defaultPlanMode: false,
  defaultPermissionMode: "manual",
  models: [
    {
      name: "kimi",
      provider: "kimi",
      model: "kimi-k2",
      maxContextSize: 128000,
      providerType: "kimi",
    },
  ],
};

describe("secondary model settings gate", () => {
  it("shows settings while experiment is off so it can be enabled", () => {
    expect(
      shouldShowSecondaryModelSettings({
        ...baseConfig,
        secondaryModelExperimentEnabled: false,
      }),
    ).toBe(true);
  });

  it("shows settings when experiment is on and models exist", () => {
    expect(
      shouldShowSecondaryModelSettings({
        ...baseConfig,
        secondaryModelExperimentEnabled: true,
      }),
    ).toBe(true);
  });

  it("detects experiment flag from config snapshot", () => {
    expect(
      isSecondaryModelExperimentEnabled({
        secondaryModelExperimentEnabled: true,
      }),
    ).toBe(true);
  });

  it("hides settings when there are no configured models", () => {
    expect(
      shouldShowSecondaryModelSettings({
        ...baseConfig,
        models: [],
      }),
    ).toBe(false);
  });
});

describe("resolveSecondaryModelOnEnable", () => {
  it("uses the configured default model without requiring a Luna model", () => {
    expect(resolveSecondaryModelOnEnable(baseConfig)).toBe("kimi");
  });

  it("preserves an existing valid secondary model when re-enabling", () => {
    expect(
      resolveSecondaryModelOnEnable({
        ...baseConfig,
        secondaryModel: "cheap",
        models: [
          ...baseConfig.models,
          { ...baseConfig.models[0], name: "cheap", model: "cheap-model" },
        ],
      }),
    ).toBe("cheap");
  });

  it("falls back to the first configured model when the default alias is stale", () => {
    expect(
      resolveSecondaryModelOnEnable({
        ...baseConfig,
        defaultModel: "missing",
      }),
    ).toBe("kimi");
  });

  it("returns null when no model can be configured", () => {
    expect(resolveSecondaryModelOnEnable({ ...baseConfig, models: [] })).toBeNull();
  });
});
