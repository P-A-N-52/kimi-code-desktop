import type { GlobalConfig } from "@/lib/api/models";

export function isSecondaryModelExperimentEnabled(
  config: Pick<GlobalConfig, "secondaryModelExperimentEnabled"> | null | undefined,
): boolean {
  return Boolean(config?.secondaryModelExperimentEnabled);
}

export function shouldShowSecondaryModelSettings(
  config: GlobalConfig | null | undefined,
): boolean {
  if (!config) return false;
  return config.models.length > 0;
}

/** Pick a valid configured model alias when enabling secondary-model routing. */
export function resolveSecondaryModelOnEnable(
  config: Pick<GlobalConfig, "defaultModel" | "models" | "secondaryModel">,
): string | null {
  const configuredModel = config.models.find((model) => model.name === config.secondaryModel);
  const defaultModel = config.models.find((model) => model.name === config.defaultModel);
  return configuredModel?.name ?? defaultModel?.name ?? config.models[0]?.name ?? null;
}

export function secondaryModelEffectHint(): string {
  return "The experiment flag and model alias are written to global config.toml; newly derived subagents use this model. The main session model is unchanged; idle sessions apply after reconnect, busy sessions need a later reconnect.";
}
