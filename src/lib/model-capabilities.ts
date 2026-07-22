import { ModelCapability, type ConfigModel } from "@/lib/api/models";

export function findConfigModel(
	models: ConfigModel[] | undefined | null,
	name: string | undefined | null,
): ConfigModel | undefined {
	if (!models?.length || !name) return undefined;
	return models.find((model) => model.name === name);
}

/** Model advertises optional or forced thinking via config capabilities. */
export function modelHasThinkingCapability(
	model: ConfigModel | null | undefined,
): boolean {
	const caps = model?.capabilities;
	if (!caps) return false;
	return (
		caps.has(ModelCapability.Thinking) ||
		caps.has(ModelCapability.AlwaysThinking)
	);
}

/** Thinking cannot be turned off for this model. */
export function modelForcesThinking(
	model: ConfigModel | null | undefined,
): boolean {
	return model?.capabilities?.has(ModelCapability.AlwaysThinking) ?? false;
}
