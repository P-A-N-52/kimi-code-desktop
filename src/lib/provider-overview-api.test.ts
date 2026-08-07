import { describe, expect, it } from "vitest";
import { normalizeProvidersOverview } from "./provider-overview-api";

describe("normalizeProvidersOverview", () => {
	it("normalizes snake_case IPC payloads without secret fields", () => {
		const overview = normalizeProvidersOverview({
			config_path: "/tmp/config.toml",
			default_model: "demo",
			structure_valid: false,
			structure_issues: ["missing provider"],
			kimi_account_credentials_present: true,
			acp_auth: {
				status: "failed",
				last_failure_at_ms: 42,
				last_failure_message: "ACP authenticate failed",
			},
			providers: [
				{
					name: "demo",
					provider_type: "openai",
					base_url: "https://api.example.com/v1",
					credential_status: "configured",
					credential_hint: "api_key is set in config.toml.",
					models: [
						{
							alias: "demo",
							upstream_model: "gpt-test",
							provider: "demo",
							is_default: true,
							max_context_size: 128000,
							capabilities: ["thinking"],
							issues: [],
						},
					],
					issues: [],
				},
			],
		});

		expect(overview.configPath).toBe("/tmp/config.toml");
		expect(overview.defaultModel).toBe("demo");
		expect(overview.kimiAccountCredentialsPresent).toBe(true);
		expect(overview.acpAuth.status).toBe("failed");
		expect(overview.providers[0]?.credentialStatus).toBe("configured");
		expect(overview.providers[0]?.models[0]?.capabilities).toEqual(["thinking"]);
	});
});
