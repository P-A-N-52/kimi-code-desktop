import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadinessOverlay } from "./readiness-overlay";

describe("ReadinessOverlay", () => {
	it("checking 时显示检测中文案", () => {
		render(
			<ReadinessOverlay
				checking
				readiness={null}
				error={null}
				onRetry={() => {}}
				onContinue={() => {}}
				onOpenDownload={() => {}}
				onOpenSettings={() => {}}
			/>,
		);
		expect(screen.getByText(/正在检查运行环境/)).toBeTruthy();
	});
	it("error 时展示错误并可重试", () => {
		const onRetry = vi.fn();
		render(
			<ReadinessOverlay
				checking={false}
				readiness={null}
				error="boom"
				onRetry={onRetry}
				onContinue={() => {}}
				onOpenDownload={() => {}}
				onOpenSettings={() => {}}
			/>,
		);
		expect(screen.getByText("boom")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(onRetry).toHaveBeenCalled();
	});

	it("does not turn a credential warning into a login requirement", () => {
		render(
			<ReadinessOverlay
				checking={false}
				readiness={{
					ok: false,
					hasBlockingIssues: false,
					checks: [
						{
							id: "credentials",
							label: "Optional account credentials",
							status: "warning",
							detail: "Not configured",
						},
					],
					issues: [],
					warnings: ["Not configured"],
					bundledRuntime: { available: false },
					externalCli: { available: true, program: "kimi", version: "0.29.1" },
					config: {
						exists: true,
						ready: true,
						hasDefaultModel: true,
						hasProviderSection: true,
						hasModelSection: true,
						hasCredentialSource: true,
						credentialSources: ["config api_key"],
					},
				}}
				error={null}
				onRetry={() => {}}
				onContinue={() => {}}
				onOpenDownload={() => {}}
				onOpenSettings={() => {}}
			/>,
		);

		expect(screen.getByText("Optional account credentials")).toBeTruthy();
		expect(screen.queryByText("Kimi Code auth")).toBeNull();
	});

	it("guides incomplete config to settings without allowing continue", () => {
		const onContinue = vi.fn();
		const onOpenSettings = vi.fn();
		render(
			<ReadinessOverlay
				checking={false}
				readiness={{
					ok: false,
					hasBlockingIssues: false,
					checks: [
						{
							id: "kimiCodeConfig",
							label: "Kimi Code config.toml",
							status: "warning",
							detail: "Config file not found",
						},
					],
					issues: [],
					warnings: ["Config file not found"],
					bundledRuntime: { available: false },
					externalCli: { available: true, program: "kimi", version: "0.29.1" },
					config: {
						exists: false,
						ready: false,
						hasDefaultModel: false,
						hasProviderSection: false,
						hasModelSection: false,
						hasCredentialSource: false,
						credentialSources: [],
					},
				}}
				error={null}
				onRetry={() => {}}
				onContinue={onContinue}
				onOpenDownload={() => {}}
				onOpenSettings={onOpenSettings}
			/>,
		);

		expect(screen.getByText("需要完成 Kimi Code 配置")).toBeTruthy();
		expect(screen.getByText(/尚未找到配置文件/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "仍要继续" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "打开配置设置" }));
		expect(onOpenSettings).toHaveBeenCalledOnce();
		expect(onContinue).not.toHaveBeenCalled();
	});

	it("uses incomplete guidance for a readable but incomplete config", () => {
		render(
			<ReadinessOverlay
				checking={false}
				readiness={{
					ok: false,
					hasBlockingIssues: false,
					checks: [],
					issues: [],
					warnings: [],
					bundledRuntime: { available: false },
					externalCli: { available: true, program: "kimi", version: "0.29.1" },
					config: {
						exists: true,
						ready: false,
						hasDefaultModel: false,
						hasProviderSection: false,
						hasModelSection: false,
						hasCredentialSource: false,
						credentialSources: [],
						error: null,
					},
				}}
				error={null}
				onRetry={() => {}}
				onContinue={() => {}}
				onOpenDownload={() => {}}
				onOpenSettings={() => {}}
			/>,
		);

		expect(screen.getByText("配置尚未完成。请在设置的 Providers 中完成 Provider、模型和凭据来源。")).toBeTruthy();
		expect(screen.queryByText(/配置文件无法读取或解析/)).toBeNull();
	});
});
