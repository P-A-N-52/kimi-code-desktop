import { describe, expect, it } from "vitest";
import {
	acpAuthStatusLabel,
	formatCapabilities,
	overviewHasConfiguredProviders,
	providerCredentialLabel,
	type ProvidersOverview,
} from "./provider-overview";

describe("provider overview helpers", () => {
	it("labels credential and auth states without mixing semantics", () => {
		expect(providerCredentialLabel("configured")).toBe("已配置");
		expect(providerCredentialLabel("not_configured")).toBe("未配置");
		expect(acpAuthStatusLabel("failed")).toBe("上次 ACP 认证失败");
		expect(acpAuthStatusLabel("unknown")).toBe("ACP 认证状态未知");
	});

	it("formats capability lists for display", () => {
		expect(formatCapabilities(["thinking", "vision"])).toBe("thinking · vision");
		expect(formatCapabilities([])).toBe("（无）");
	});

	it("detects configured providers independently from ACP auth", () => {
		const overview: ProvidersOverview = {
			configPath: "/tmp/config.toml",
			defaultModel: "demo",
			structureValid: true,
			structureIssues: [],
			kimiAccountCredentialsPresent: false,
			acpAuth: {
				status: "failed",
				lastFailureAtMs: 1,
				lastFailureMessage: "ACP authenticate failed",
			},
			providers: [
				{
					name: "demo",
					providerType: "openai",
					baseUrl: "https://api.example.com/v1",
					credentialStatus: "configured",
					credentialHint: "api_key is set in config.toml.",
					models: [],
					issues: [],
				},
			],
		};
		expect(overviewHasConfiguredProviders(overview)).toBe(true);
		expect(overview.acpAuth.status).toBe("failed");
	});
});
