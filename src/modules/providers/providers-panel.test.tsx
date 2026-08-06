import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/ui/confirm-dialog";
import { ProvidersPanel } from "./providers-panel";

const mocks = vi.hoisted(() => ({
	getProvidersOverview: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
	getProvidersOverview: mocks.getProvidersOverview,
}));

function renderPanel(props: ComponentProps<typeof ProvidersPanel>) {
	render(
		<ConfirmDialogProvider>
			<ProvidersPanel {...props} />
		</ConfirmDialogProvider>,
	);
}

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
		renderPanel({
			enabled: true,
			advancedEditor: <div>advanced editor</div>,
		});

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "demo" })).toBeTruthy();
		});

		expect(screen.getByText("已配置")).toBeTruthy();
		expect(screen.getByText("上次 ACP 认证失败")).toBeTruthy();
		expect(screen.getByText("ACP authenticate failed")).toBeTruthy();
		expect(screen.getByText(/不等于当前会话一定可用/)).toBeTruthy();
	});

	it("keeps advanced config editor collapsed by default", async () => {
		renderPanel({
			enabled: true,
			advancedEditor: <div>advanced editor</div>,
		});

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "demo" })).toBeTruthy();
		});

		expect(screen.queryByText("advanced editor")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /展开高级 config.toml 编辑器/ }));
		expect(screen.getByText("advanced editor")).toBeTruthy();
	});

	it("opens the structured editor in the same config tab", async () => {
		renderPanel({
			enabled: true,
			advancedEditor: <div>advanced editor</div>,
			structuredEditor: <div>structured editor</div>,
		});

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "demo" })).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: "编辑模型配置" }));
		expect(screen.getByText("结构化 Provider / 模型配置")).toBeTruthy();
		expect(screen.getByText("structured editor")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "返回摘要" }));
		expect(screen.getByRole("heading", { name: "demo" })).toBeTruthy();
	});

	it("confirms before collapsing a dirty advanced editor", async () => {
		const onAdvancedEditorDiscard = vi.fn();
		renderPanel({
			enabled: true,
			advancedEditor: <div>advanced editor</div>,
			advancedEditorDirty: true,
			onAdvancedEditorDiscard,
		});

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "demo" })).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: /展开高级 config.toml 编辑器/ }));
		const collapseButton = screen.getByRole("button", { name: "收起高级 config.toml 编辑器" });

		fireEvent.click(collapseButton);
		await waitFor(() => {
			expect(
				screen.getByText("高级 config.toml 编辑器有未保存的更改，确定放弃并返回摘要吗？"),
			).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		await waitFor(() => {
			expect(screen.queryByText("高级 config.toml 编辑器有未保存的更改，确定放弃并返回摘要吗？")).toBeNull();
		});
		expect(screen.getByText("advanced editor")).toBeTruthy();
		expect(onAdvancedEditorDiscard).not.toHaveBeenCalled();

		fireEvent.click(collapseButton);
		await waitFor(() => {
			expect(
				screen.getByText("高级 config.toml 编辑器有未保存的更改，确定放弃并返回摘要吗？"),
			).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: "确定" }));
		await waitFor(() => {
			expect(screen.queryByText("advanced editor")).toBeNull();
		});
		expect(onAdvancedEditorDiscard).toHaveBeenCalledOnce();
	});
});
