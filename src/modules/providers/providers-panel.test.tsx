import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersPanel } from "./providers-panel";

const mocks = vi.hoisted(() => ({
	getProvidersOverview: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
	getProvidersOverview: mocks.getProvidersOverview,
}));

describe("ProvidersPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getProvidersOverview.mockResolvedValue({
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
					models: [
						{
							alias: "demo",
							upstreamModel: "gpt-test",
							provider: "demo",
							isDefault: true,
							maxContextSize: 128000,
							capabilities: ["thinking"],
							issues: [],
						},
					],
					issues: [],
				},
			],
		});
	});

	it("shows configured credentials separately from ACP auth failure", async () => {
		render(
			<ProvidersPanel
				enabled
				advancedEditor={<div>advanced editor</div>}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "demo" })).toBeTruthy();
		});

		expect(screen.getByText("已配置")).toBeTruthy();
		expect(screen.getByText("上次 ACP 认证失败")).toBeTruthy();
		expect(screen.getByText("ACP authenticate failed")).toBeTruthy();
		expect(screen.getByText(/不等于当前会话一定可用/)).toBeTruthy();
	});

	it("keeps advanced config editor collapsed by default", async () => {
		render(
			<ProvidersPanel
				enabled
				advancedEditor={<div>advanced editor</div>}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "demo" })).toBeTruthy();
		});

		expect(screen.queryByText("advanced editor")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /展开高级 config.toml 编辑器/ }));
		expect(screen.getByText("advanced editor")).toBeTruthy();
	});
});
