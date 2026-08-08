import { describe, expect, it } from "vitest";
import {
	addModel,
	addProvider,
	getProviderModelTomlCompatibilityError,
	readProviderModelConfig,
	removeModel,
	removeProvider,
	renameModel,
	renameProvider,
	setModelOptionalStringValue,
	setModelProtocol,
	setModelStringValue,
	setModelSupportEfforts,
	setProviderStringValue,
	validateProviderModelToml,
} from "./provider-model-toml";

const baseConfig = `theme = "dark"
default_model = "demo/alpha"

[providers.demo]
type = "openai_legacy"
base_url = "https://api.example.com/v1"
api_key = "not-a-real-key"

[models."demo/alpha"]
provider = "demo"
model = "alpha"
max_context_size = 128000
capabilities = ["thinking"]

[models."demo/beta"]
provider = "demo"
model = "beta"
max_context_size = 64000
`;

describe("provider-model-toml", () => {
	it("adds a model to an existing provider and makes the first model default", () => {
		const result = addModel(
			`[providers.demo]
type = "openai_legacy"
`,
			"demo",
		);

		expect(result.error).toBeUndefined();
		expect(result.modelName).toBe("demo/model-name");
		expect(result.content).not.toContain("protocol");
		const config = readProviderModelConfig(result.content);
		expect(config.defaultModel).toBe("demo/model-name");
		expect(config.models).toEqual([
			expect.objectContaining({
				name: "demo/model-name",
				provider: "demo",
				upstreamModel: "model-name",
			}),
		]);
	});

	it("reads, updates, and clears model thinking-effort metadata", () => {
		const supported = setModelSupportEfforts(baseConfig, "demo/alpha", ["low", "high", "max"]);
		expect(supported.error).toBeUndefined();
		const defaulted = setModelOptionalStringValue(
			supported.content,
			"demo/alpha",
			"default_effort",
			"high",
		);
		expect(defaulted.error).toBeUndefined();
		expect(readProviderModelConfig(defaulted.content).models[0]).toEqual(
			expect.objectContaining({
				supportEfforts: ["low", "high", "max"],
				defaultEffort: "high",
			}),
		);

		const cleared = setModelOptionalStringValue(
			setModelSupportEfforts(defaulted.content, "demo/alpha", []).content,
			"demo/alpha",
			"default_effort",
			"",
		);
		expect(cleared.content).not.toContain("support_efforts");
		expect(cleared.content).not.toContain("default_effort");
	});

	it("renames quoted provider tables, nested settings, and model references without rewriting unrelated config", () => {
		const content = `theme = "dark"

[providers."open.ai"]
type = "openai_legacy"

[providers."open.ai".transport]
retry = 3

[models."open.ai/model"]
provider = "open.ai"
model = "gpt-test"
`;

		const result = renameProvider(content, "open.ai", "custom provider");

		expect(result.error).toBeUndefined();
		expect(result.content).toContain('theme = "dark"');
		expect(result.content).toContain('[providers."custom provider"]');
		expect(result.content).toContain('[providers."custom provider".transport]');
		expect(readProviderModelConfig(result.content).models).toEqual([
			expect.objectContaining({ provider: "custom provider" }),
		]);
	});

	it("falls back to another model when deleting the default model", () => {
		const result = removeModel(baseConfig, "demo/alpha");

		expect(result.error).toBeUndefined();
		expect(result.fallbackModelName).toBe("demo/beta");
		const config = readProviderModelConfig(result.content);
		expect(config.defaultModel).toBe("demo/beta");
		expect(config.models.map((model) => model.name)).toEqual(["demo/beta"]);
	});

	it("renames a model alias and keeps the default-model reference valid", () => {
			const result = renameModel(baseConfig, "demo/alpha", "demo/renamed");

			expect(result.error).toBeUndefined();
			const config = readProviderModelConfig(result.content);
			expect(config.defaultModel).toBe("demo/renamed");
			expect(config.models.map((model) => model.name)).toContain("demo/renamed");
		});

		it("deletes a provider with its models and falls back from its default model", () => {
			const content = `${baseConfig}
[providers.other]
type = "anthropic"

[models."other/gamma"]
provider = "other"
model = "gamma"
`;

			const result = removeProvider(content, "demo");

			expect(result.error).toBeUndefined();
			const config = readProviderModelConfig(result.content);
			expect(config.defaultModel).toBe("other/gamma");
			expect(config.providers.map((provider) => provider.name)).toEqual(["other"]);
			expect(config.models.map((model) => model.name)).toEqual(["other/gamma"]);
		});

		it("does not allow deleting the only model and reports invalid TOML", () => {
		const singleModel = baseConfig.replace(/\n\[models\."demo\/beta"\][\s\S]*$/, "\n");

		expect(removeModel(singleModel, "demo/alpha").error).toMatch(/至少保留一个模型/);
		expect(validateProviderModelToml('[providers."unterminated]')).toMatch(/TOML 格式错误/);
	});

	it("keeps the following Provider intact when deleting a Provider with nested tables", () => {
		const content = `[providers.demo]
			type = "openai_legacy"

			[providers.demo.transport]
			retry = 3

			[providers.other]
			type = "anthropic"
			base_url = "https://other.example.com"
			`;

		const result = removeProvider(content, "demo");

		expect(result.error).toBeUndefined();
		expect(result.content).not.toContain("[providers.demo]");
		expect(result.content).not.toContain("[providers.demo.transport]");
		expect(result.content).toContain("[providers.other]");
		expect(result.content).toContain('base_url = "https://other.example.com"');
		expect(readProviderModelConfig(result.content).providers).toEqual([
			expect.objectContaining({ name: "other", type: "anthropic" }),
		]);
	});

	it("keeps unrelated array tables safe and rejects array tables below providers or models", () => {
		const unrelatedArrayTable = `title = "keep"

[[plugins]]
name = "keep-me"

[providers.demo]
type = "openai_legacy"
`;
		const added = addModel(unrelatedArrayTable, "demo");

		expect(added.error).toBeUndefined();
		expect(added.content).toContain("[[plugins]]\nname = \"keep-me\"");
		expect(readProviderModelConfig(added.content).models).toHaveLength(1);

		const providerArrayTable = `[providers.demo]
type = "openai_legacy"

[[providers.demo.transport]]
name = "retry"
`;
		const modelArrayTable = `[models.demo]
provider = "demo"
model = "demo"

[[models.rules]]
name = "rule"
`;

		expect(getProviderModelTomlCompatibilityError(providerArrayTable)).toMatch(/array-of-tables/);
		expect(addProvider(providerArrayTable).error).toMatch(/array-of-tables/);
		expect(setProviderStringValue(providerArrayTable, "demo", "base_url", "https://example.com").error).toMatch(
			/array-of-tables/,
		);
		expect(addModel(modelArrayTable, "").error).toMatch(/array-of-tables/);
	});

	it("protects the built-in Kimi Provider while allowing a connection override", () => {
		const content = `[providers.kimi]
type = "kimi"
base_url = "https://api.kimi.com"
`;

		expect(renameProvider(content, "kimi", "custom-kimi").error).toMatch(/内置 Provider/);
		expect(removeProvider(content, "kimi").error).toMatch(/内置 Provider/);
		const override = setProviderStringValue(content, "kimi", "base_url", "https://proxy.example.com");
		expect(override.error).toBeUndefined();
		expect(override.content).toContain('base_url = "https://proxy.example.com"');
	});

	it("updates quoted controlled keys while preserving simple comments and table-header comments", () => {
		const content = `"default_model" = "demo/alpha" # keep default

[providers.demo] # keep provider header
type = "openai_legacy"

[models."demo/alpha"] # keep model header
provider = "demo"
"model" = "alpha" # keep upstream model
display_name = "Demo" # keep display name
`;

		const renamedModel = renameModel(content, "demo/alpha", "demo/renamed");
		expect(renamedModel.error).toBeUndefined();
		expect(renamedModel.content).toContain('"default_model" = "demo/renamed" # keep default');
		expect(renamedModel.content).toContain('[models."demo/renamed"] # keep model header');

		const updatedModel = setModelStringValue(renamedModel.content, "demo/renamed", "model", "beta");
		expect(updatedModel.error).toBeUndefined();
		expect(updatedModel.content).toContain('"model" = "beta" # keep upstream model');

		const renamedProvider = renameProvider(updatedModel.content, "demo", "renamed-provider");
		expect(renamedProvider.error).toBeUndefined();
		expect(renamedProvider.content).toContain("[providers.renamed-provider] # keep provider header");

		const updatedDisplayName = setModelStringValue(
			renamedProvider.content,
			"demo/renamed",
			"display_name",
			"Renamed Demo",
		);
		expect(updatedDisplayName.error).toBeUndefined();
		expect(updatedDisplayName.content).toContain('display_name = "Renamed Demo" # keep display name');
		expect(readProviderModelConfig(updatedDisplayName.content).models[0]).toEqual(
			expect.objectContaining({ displayName: "Renamed Demo" }),
		);
		const providerSection = updatedDisplayName.content.slice(
			updatedDisplayName.content.indexOf("[providers.renamed-provider]"),
			updatedDisplayName.content.indexOf('[models."demo/renamed"]'),
		);
		expect(providerSection).not.toContain("display_name");

		const clearedDisplayName = setModelOptionalStringValue(
			updatedDisplayName.content,
			"demo/renamed",
			"display_name",
			"",
		);
		expect(clearedDisplayName.error).toBeUndefined();
		expect(clearedDisplayName.content).not.toContain("display_name");
	});

	it("refuses a controlled multi-line value instead of rewriting it unsafely", () => {
		const content = `[providers.demo]
type = "openai_legacy"

[models.demo]
provider = "demo"
model = "demo"
capabilities = [
  "thinking",
]
`;

		expect(validateProviderModelToml(content)).toMatch(/多行 TOML 值/);
		expect(setModelStringValue(content, "demo", "model", "updated").error).toMatch(/多行 TOML 值/);
	});

	it("rejects aggregate provider/model tables and root assignments", () => {
		expect(getProviderModelTomlCompatibilityError("[providers]\n")).toMatch(/聚合表/);
		expect(getProviderModelTomlCompatibilityError("[models]\n")).toMatch(/聚合表/);
		expect(getProviderModelTomlCompatibilityError("providers = {}\n")).toMatch(/顶层 providers/);
		expect(getProviderModelTomlCompatibilityError("models = {}\n")).toMatch(/顶层 models/);
	});

	it("does not add display_name or a default type to new Provider sections", () => {
		const addedProvider = addProvider("");

		expect(addedProvider.error).toBeUndefined();
		expect(addedProvider.content).toContain("[providers.custom-provider]");
		expect(addedProvider.content).not.toContain("type");
		expect(addedProvider.content).not.toContain("display_name");
		expect(addedProvider.content).not.toContain("protocol");
		expect(readProviderModelConfig(addedProvider.content).providers).toEqual([
			expect.objectContaining({ name: "custom-provider", type: "" }),
		]);
	});

	it("sets and clears a model wire protocol", () => {
		const set = setModelProtocol(baseConfig, "demo/alpha", "openai_responses");

		expect(set.error).toBeUndefined();
		expect(set.content).toContain('protocol = "openai_responses"');
		expect(readProviderModelConfig(set.content).models).toEqual([
			expect.objectContaining({ name: "demo/alpha", protocol: "openai_responses" }),
			expect.objectContaining({ name: "demo/beta", protocol: "" }),
		]);

		const cleared = setModelProtocol(set.content, "demo/alpha", "");
		expect(cleared.error).toBeUndefined();
		expect(cleared.content).not.toContain("protocol");
		expect(readProviderModelConfig(cleared.content).models[0]).toEqual(
			expect.objectContaining({ name: "demo/alpha", protocol: "" }),
		);
	});

	it("reads the wire protocol of existing models and defaults to empty", () => {
		const content = `[providers.demo]
type = "openai_legacy"

[models."demo/alpha"]
provider = "demo"
model = "alpha"
protocol = "anthropic"

[models."demo/beta"]
provider = "demo"
model = "beta"
`;

		const models = readProviderModelConfig(content).models;
		expect(models).toHaveLength(2);
		expect(models[0]).toEqual(expect.objectContaining({ name: "demo/alpha", protocol: "anthropic" }));
		expect(models[1]).toEqual(expect.objectContaining({ name: "demo/beta", protocol: "" }));
	});
});
