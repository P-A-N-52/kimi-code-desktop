import { describe, expect, it } from "vitest";
import {
  isSecondaryModelExperimentEnabled,
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
  it("hides settings when experiment env is off", () => {
    expect(
      shouldShowSecondaryModelSettings({
        ...baseConfig,
        secondaryModelExperimentEnabled: false,
      }),
    ).toBe(false);
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
});
