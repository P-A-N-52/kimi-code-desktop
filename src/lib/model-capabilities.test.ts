import { describe, expect, it } from "vitest";
import { ModelCapability, type ConfigModel } from "@/lib/api/models";
import {
	findConfigModel,
	modelForcesThinking,
	modelHasThinkingCapability,
	modelThinkingEfforts,
} from "./model-capabilities";

function model(
	name: string,
	capabilities?: Set<(typeof ModelCapability)[keyof typeof ModelCapability]> | null,
): ConfigModel {
	return {
		name,
		provider: "kimi",
		model: name,
		maxContextSize: 128000,
		providerType: "kimi" as ConfigModel["providerType"],
		capabilities,
	};
}

describe("model-capabilities", () => {
	it("finds a model by config key", () => {
		const models = [model("a"), model("b")];
		expect(findConfigModel(models, "b")?.name).toBe("b");
		expect(findConfigModel(models, "missing")).toBeUndefined();
	});

	it("detects optional thinking", () => {
		const withThinking = model(
			"kimi",
			new Set([ModelCapability.Thinking]),
		);
		expect(modelHasThinkingCapability(withThinking)).toBe(true);
		expect(modelForcesThinking(withThinking)).toBe(false);
	});

	it("detects always-on thinking", () => {
		const always = model(
			"reasoner",
			new Set([ModelCapability.AlwaysThinking]),
		);
		expect(modelHasThinkingCapability(always)).toBe(true);
		expect(modelForcesThinking(always)).toBe(true);
	});

	it("hides thinking when capabilities are absent", () => {
		expect(modelHasThinkingCapability(model("plain"))).toBe(false);
		expect(modelHasThinkingCapability(model("plain", null))).toBe(false);
		expect(modelHasThinkingCapability(undefined)).toBe(false);
	});

	it("returns only declared non-empty thinking efforts", () => {
		const configurable = model("configurable");
		configurable.supportEfforts = ["low", "", "high", "max"];
		expect(modelThinkingEfforts(configurable)).toEqual(["low", "high", "max"]);
		expect(modelThinkingEfforts(model("plain"))).toEqual([]);
	});
});
