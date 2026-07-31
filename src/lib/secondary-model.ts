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
  if (!isSecondaryModelExperimentEnabled(config)) return false;
  return config.models.length > 0;
}

export function secondaryModelEffectHint(): string {
  return "写入全局 [secondary_model]；新派生的子代理将使用此模型。主会话 model 不变；空闲会话重连后生效，忙碌会话需稍后重连。";
}
