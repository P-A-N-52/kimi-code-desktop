import { describe, expect, it } from "vitest";
import {
	GlobalConfigFromJSON,
	GlobalConfigToJSON,
	UpdateGlobalConfigRequestToJSON,
} from "./index";

describe("global config API models", () => {
	it("maps default runtime modes between API JSON and TypeScript config", () => {
		const config = GlobalConfigFromJSON({
			default_model: "kimi",
			default_thinking: true,
			default_plan_mode: true,
			default_permission_mode: "auto",
			models: [],
		});

		expect(config.defaultPlanMode).toBe(true);
		expect(config.defaultPermissionMode).toBe("auto");
		expect(GlobalConfigToJSON(config)).toMatchObject({
			default_plan_mode: true,
			default_permission_mode: "auto",
		});
	});

	it("serializes defaultPlanMode in update requests", () => {
		expect(
			UpdateGlobalConfigRequestToJSON({
				defaultPlanMode: false,
			}),
		).toMatchObject({
			default_plan_mode: false,
		});
	});
});
