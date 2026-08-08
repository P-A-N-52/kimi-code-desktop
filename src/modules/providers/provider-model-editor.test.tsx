import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "@/ui/confirm-dialog";
import { ProviderModelEditor } from "./provider-model-editor";
import { MODEL_PROTOCOL_OPTIONS } from "./provider-model-toml";

const mocks = vi.hoisted(() => ({
	getConfigTomlFile: vi.fn(),
	getProviderCatalogEntry: vi.fn(),
	importProviderFromCatalog: vi.fn(),
	importProviderRegistry: vi.fn(),
	listProviderCatalog: vi.fn(),
	updateConfigTomlFile: vi.fn(),
	notifyTextConfigSaved: vi.fn(),
}));

vi.mock("@/lib/settings-api", () => ({
	getConfigTomlFile: mocks.getConfigTomlFile,
	getProviderCatalogEntry: mocks.getProviderCatalogEntry,
	importProviderFromCatalog: mocks.importProviderFromCatalog,
	importProviderRegistry: mocks.importProviderRegistry,
	listProviderCatalog: mocks.listProviderCatalog,
	updateConfigTomlFile: mocks.updateConfigTomlFile,
}));

vi.mock("@/lib/config-update-toast", () => ({
	notifyTextConfigSaved: mocks.notifyTextConfigSaved,
}));

const configToml = `default_model = "demo/alpha"

[providers.demo]
type = "openai_legacy"
base_url = "https://api.example.com/v1"
api_key = "not-a-real-key"

[models."demo/alpha"]
provider = "demo"
model = "alpha"
display_name = "Demo Alpha"
max_context_size = 128000
capabilities = ["thinking"]
support_efforts = ["low", "high", "max"]
default_effort = "high"

[models."demo/beta"]
provider = "demo"
model = "beta"
max_context_size = 64000
`;

function renderEditor(onDirtyChange = vi.fn()) {
	render(
		<ConfirmDialogProvider>
			<ProviderModelEditor enabled onDirtyChange={onDirtyChange} />
		</ConfirmDialogProvider>,
	);
	return onDirtyChange;
}

describe("ProviderModelEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfigTomlFile.mockResolvedValue({
			content: configToml,
			path: "/tmp/config.toml",
		});
		mocks.updateConfigTomlFile.mockResolvedValue({
			success: true,
			restartedSessionIds: ["idle-session"],
			skippedBusySessionIds: ["busy-session"],
		});
		mocks.listProviderCatalog.mockResolvedValue([
			{ id: "anthropic", name: "Anthropic", modelCount: 2 },
		]);
		mocks.getProviderCatalogEntry.mockResolvedValue({
			providerId: "anthropic",
			name: "Anthropic",
			models: [
				{ id: "claude-sonnet", name: "Claude Sonnet", maxContextTokens: 200000 },
			],
		});
		mocks.importProviderFromCatalog.mockResolvedValue({ success: true });
		mocks.importProviderRegistry.mockResolvedValue({ success: true });
	});

	it("loads config.toml into the structured provider and model editor", async () => {
		renderEditor();

		expect(screen.getByText("加载 config.toml 中…")).toBeTruthy();
		await waitFor(() => {
			expect((screen.getByLabelText("Provider 名称") as HTMLInputElement).value).toBe("demo");
			expect(screen.getByDisplayValue("demo/alpha")).toBeTruthy();
		});

		expect(mocks.getConfigTomlFile).toHaveBeenCalledOnce();
		expect((screen.getByLabelText("API key") as HTMLInputElement).type).toBe("password");
	});

	it("edits supported and default thinking efforts in the local draft", async () => {
		renderEditor();
		await waitFor(() => {
			expect((screen.getByLabelText("支持的思考档位") as HTMLInputElement).value).toBe(
				"low, high, max",
			);
		});

		fireEvent.change(screen.getByLabelText("支持的思考档位"), {
			target: { value: "low, max, low" },
		});
		fireEvent.change(screen.getByLabelText("默认思考档位"), {
			target: { value: "max" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));

		await waitFor(() => {
			expect(mocks.updateConfigTomlFile).toHaveBeenCalledOnce();
		});
		const savedContent = mocks.updateConfigTomlFile.mock.calls[0]?.[0] as string;
		expect(savedContent).toContain('support_efforts = ["low", "max"]');
		expect(savedContent).toContain('default_effort = "max"');
	});

	it("adds, edits, and deletes a model in the local draft", async () => {
		renderEditor();
		await waitFor(() => {
			expect(screen.getByDisplayValue("demo/alpha")).toBeTruthy();
		});

		fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
		await waitFor(() => {
			expect(screen.getByDisplayValue("demo/model-name")).toBeTruthy();
		});
		fireEvent.change(screen.getByLabelText("上游模型"), {
			target: { value: "gpt-custom" },
		});
		expect(screen.getByDisplayValue("gpt-custom")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "删除模型" }));
		await waitFor(() => {
			expect(screen.getByText("确定删除模型 “demo/model-name”吗？")).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: "删除" }));
		await waitFor(() => {
			expect(screen.queryByDisplayValue("demo/model-name")).toBeNull();
		});
	});

	it("keeps a model when the delete confirmation is cancelled", async () => {
		renderEditor();
		await waitFor(() => {
			expect(screen.getByDisplayValue("demo/alpha")).toBeTruthy();
		});

		fireEvent.click(screen.getByRole("button", { name: "删除模型" }));
		await waitFor(() => {
			expect(screen.getByText("确定删除模型 “demo/alpha”吗？")).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		await waitFor(() => {
			expect(screen.queryByText("确定删除模型 “demo/alpha”吗？")).toBeNull();
		});
		expect(screen.getByDisplayValue("demo/alpha")).toBeTruthy();
	});

	it("saves a changed draft, persists display_name, and reports restart side effects", async () => {
		const onDirtyChange = renderEditor();
		await waitFor(() => {
			expect(screen.getByDisplayValue("alpha")).toBeTruthy();
		});

		fireEvent.change(screen.getByLabelText("上游模型"), {
			target: { value: "alpha-revised" },
		});
		fireEvent.change(screen.getByLabelText("显示名称"), {
			target: { value: "Demo Alpha Revised" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));

		await waitFor(() => {
			expect(mocks.updateConfigTomlFile).toHaveBeenCalledOnce();
		});
		const savedContent = mocks.updateConfigTomlFile.mock.calls[0]?.[0] as string;
		expect(savedContent).toContain('model = "alpha-revised"');
		const providerSection = savedContent.slice(
			savedContent.indexOf("[providers.demo]"),
			savedContent.indexOf('[models."demo/alpha"]'),
		);
		const alphaModelSection = savedContent.slice(
			savedContent.indexOf('[models."demo/alpha"]'),
			savedContent.indexOf('[models."demo/beta"]'),
		);
		expect(providerSection).not.toContain("display_name");
		expect(alphaModelSection).toContain('display_name = "Demo Alpha Revised"');
		expect(mocks.notifyTextConfigSaved).toHaveBeenCalledWith(
			expect.objectContaining({
			restartedSessionIds: ["idle-session"],
			skippedBusySessionIds: ["busy-session"],
		}),
		"模型配置已保存",
		);
		await waitFor(() => {
			expect(screen.getByText("没有未保存的更改")).toBeTruthy();
		});
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});

	it("keeps the changed draft visible when save fails", async () => {
		mocks.updateConfigTomlFile.mockRejectedValueOnce(new Error("native write failed"));
		renderEditor();
		await waitFor(() => {
			expect(screen.getByDisplayValue("alpha")).toBeTruthy();
		});

		fireEvent.change(screen.getByLabelText("上游模型"), {
			target: { value: "alpha-unsaved" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));

		await waitFor(() => {
			expect(screen.getByText("native write failed")).toBeTruthy();
		});
		expect(screen.getByDisplayValue("alpha-unsaved")).toBeTruthy();
		expect(screen.getByText("有未保存的更改")).toBeTruthy();
	});

	it("blocks saves after a config load failure and retries safely", async () => {
		mocks.getConfigTomlFile
			.mockRejectedValueOnce(new Error("native read failed"))
			.mockResolvedValueOnce({ content: configToml, path: "/tmp/config.toml" });
		renderEditor();

		await waitFor(() => {
			expect(screen.getByText("读取 config.toml 失败：native read failed")).toBeTruthy();
		});
		const saveButton = screen.getByRole("button", { name: "保存模型配置" }) as HTMLButtonElement;
		expect(saveButton.disabled).toBe(true);
		fireEvent.click(saveButton);
		expect(mocks.updateConfigTomlFile).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
		await waitFor(() => {
			expect(mocks.getConfigTomlFile).toHaveBeenCalledTimes(2);
			expect(screen.getByLabelText("Provider 名称")).toBeTruthy();
		});
	});

	it("opens the two Kimi CLI provider import choices from an empty config", async () => {
		mocks.getConfigTomlFile.mockResolvedValueOnce({
			content: "",
			path: "/tmp/config.toml",
		});
		renderEditor();

		const addProviderButton = await screen.findByRole("button", { name: "添加 Provider" });
		expect((addProviderButton as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(addProviderButton);
		await waitFor(() => {
			expect(screen.getByRole("button", { name: /已知平台/ })).toBeTruthy();
			expect(screen.getByRole("button", { name: /自定义 Registry/ })).toBeTruthy();
		});
	});

	it("imports a catalog provider and reloads config.toml", async () => {
		renderEditor();
		await screen.findByRole("button", { name: "添加 Provider" });
		fireEvent.click(screen.getByRole("button", { name: "添加 Provider" }));
		fireEvent.click(await screen.findByRole("button", { name: /已知平台/ }));
		fireEvent.click(await screen.findByRole("button", { name: /Anthropic/ }));

		await screen.findByLabelText("平台 API Key");
		fireEvent.change(screen.getByLabelText("平台 API Key"), {
			target: { value: "catalog-secret" },
		});
		fireEvent.click(screen.getByRole("button", { name: "导入平台" }));

		await waitFor(() => {
			expect(mocks.importProviderFromCatalog).toHaveBeenCalledWith({
				providerId: "anthropic",
				apiKey: "catalog-secret",
				defaultModel: "claude-sonnet",
				baseUrl: undefined,
			});
			expect(mocks.getConfigTomlFile).toHaveBeenCalledTimes(2);
		});
	});

	it("imports a custom registry through the GUI and reloads config.toml", async () => {
		renderEditor();
		await screen.findByRole("button", { name: "添加 Provider" });
		fireEvent.click(screen.getByRole("button", { name: "添加 Provider" }));
		fireEvent.click(await screen.findByRole("button", { name: /自定义 Registry/ }));
		fireEvent.change(screen.getByLabelText("Registry URL"), {
			target: { value: "https://registry.example.com/api.json" },
		});
		fireEvent.change(screen.getByLabelText("Registry Token"), {
			target: { value: "registry-secret" },
		});
		fireEvent.click(screen.getByRole("button", { name: "导入 Registry" }));

		await waitFor(() => {
			expect(mocks.importProviderRegistry).toHaveBeenCalledWith({
				registryUrl: "https://registry.example.com/api.json",
				apiKey: "registry-secret",
			});
			expect(mocks.getConfigTomlFile).toHaveBeenCalledTimes(2);
		});
	});

	it("protects the built-in Kimi Provider while retaining connection overrides", async () => {
		mocks.getConfigTomlFile.mockResolvedValueOnce({
			content: `[providers.kimi]
	type = "kimi"
	base_url = "https://api.kimi.com"

[models."kimi/default"]
provider = "kimi"
model = "kimi"
display_name = "Kimi Default"
	`,
			path: "/tmp/config.toml",
		});
		renderEditor();

		await waitFor(() => {
			expect((screen.getByLabelText("Provider 名称") as HTMLInputElement).value).toBe("kimi");
		});
		expect((screen.getByLabelText("Provider 名称") as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByLabelText("Provider 类型") as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "删除 Provider" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((screen.getByLabelText("Base URL") as HTMLInputElement).disabled).toBe(false);
		const modelDisplayName = screen.getByLabelText("显示名称") as HTMLInputElement;
		expect(modelDisplayName.value).toBe("Kimi Default");
		expect(modelDisplayName.disabled).toBe(false);
		fireEvent.change(modelDisplayName, { target: { value: "Kimi Override" } });
		expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("Kimi Override");
		expect(
			screen.getByText("这是 Kimi Code 内置 Provider；名称、类型和删除操作受到保护，但仍可覆盖连接配置。"),
		).toBeTruthy();
	});

	it("refuses an unsupported provider array table before exposing a writable draft", async () => {
		mocks.getConfigTomlFile.mockResolvedValueOnce({
			content: `[providers.demo]
	type = "openai_legacy"

	[[providers.demo.transport]]
	name = "retry"
	`,
			path: "/tmp/config.toml",
		});
		renderEditor();

		await waitFor(() => {
			expect(screen.getByText(/array-of-tables/)).toBeTruthy();
		});
		expect((screen.getByRole("button", { name: "添加 Provider" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		const saveButton = screen.getByRole("button", { name: "保存模型配置" }) as HTMLButtonElement;
		expect(saveButton.disabled).toBe(true);
		fireEvent.click(saveButton);
		expect(mocks.updateConfigTomlFile).not.toHaveBeenCalled();
	});

	it("removes a model display_name when cleared", async () => {
		renderEditor();
		await waitFor(() => {
			expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("Demo Alpha");
		});

		fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));

		await waitFor(() => {
			expect(mocks.updateConfigTomlFile).toHaveBeenCalledOnce();
		});
		const savedContent = mocks.updateConfigTomlFile.mock.calls[0]?.[0] as string;
		expect(savedContent).not.toContain("display_name");
	});

	it("renders the wire protocol selector with automatic inference and supported options", async () => {
		renderEditor();
		await waitFor(() => {
			expect((screen.getByLabelText("线路协议") as HTMLSelectElement).value).toBe("");
		});

		const protocolSelect = screen.getByLabelText("线路协议") as HTMLSelectElement;
		expect(protocolSelect.options[0]?.value).toBe("");
		expect(protocolSelect.options[0]?.text).toBe("（自动推断）");
		expect(Array.from(protocolSelect.options).map((option) => option.value)).toEqual([
			"",
			...MODEL_PROTOCOL_OPTIONS,
		]);
	});

	it("writes a model wire protocol into the saved config", async () => {
		renderEditor();
		await waitFor(() => {
			expect((screen.getByLabelText("线路协议") as HTMLSelectElement).value).toBe("");
		});

		fireEvent.change(screen.getByLabelText("线路协议"), {
			target: { value: "anthropic" },
		});
		expect((screen.getByLabelText("线路协议") as HTMLSelectElement).value).toBe("anthropic");
		fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));

		await waitFor(() => {
			expect(mocks.updateConfigTomlFile).toHaveBeenCalledOnce();
		});
		const savedContent = mocks.updateConfigTomlFile.mock.calls[0]?.[0] as string;
		const alphaModelSection = savedContent.slice(
			savedContent.indexOf('[models."demo/alpha"]'),
			savedContent.indexOf('[models."demo/beta"]'),
		);
		expect(alphaModelSection).toContain('protocol = "anthropic"');
	});

	it("removes a model wire protocol when reset to automatic inference", async () => {
		renderEditor();
		await waitFor(() => {
			expect((screen.getByLabelText("线路协议") as HTMLSelectElement).value).toBe("");
		});

		fireEvent.change(screen.getByLabelText("线路协议"), {
			target: { value: "openai" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
		await waitFor(() => {
			expect(mocks.updateConfigTomlFile).toHaveBeenCalledTimes(1);
		});

		fireEvent.change(screen.getByLabelText("线路协议"), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
		await waitFor(() => {
			expect(mocks.updateConfigTomlFile).toHaveBeenCalledTimes(2);
		});
		const savedContent = mocks.updateConfigTomlFile.mock.calls[1]?.[0] as string;
		expect(savedContent).not.toContain("protocol");
	});
});
