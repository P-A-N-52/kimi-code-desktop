import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfigToml: vi.fn(),
	getMcpConfig: vi.fn(),
	isTauri: vi.fn(),
	updateConfigToml: vi.fn(),
	updateMcpConfig: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
	getConfigToml: mocks.getConfigToml,
	getMcpConfig: mocks.getMcpConfig,
	isTauri: mocks.isTauri,
	updateConfigToml: mocks.updateConfigToml,
	updateMcpConfig: mocks.updateMcpConfig,
}));

vi.mock("@/lib/apiClient", () => ({
	apiClient: {
		config: {
			getConfigTomlApiConfigTomlGet: vi.fn(),
			updateConfigTomlApiConfigTomlPut: vi.fn(),
		},
	},
}));

vi.mock("@/lib/auth", () => ({
	getAuthHeader: vi.fn(() => ({})),
}));

vi.mock("@/hooks/utils", () => ({
	getApiBaseUrl: vi.fn(() => ""),
}));

import { updateConfigTomlFile, updateMcpConfigFile } from "./settings-api";

const restartDetail = {
	restartedSessionIds: ["idle"],
	skippedBusySessionIds: ["busy"],
	requiresRuntimeReadiness: true,
};

describe("text config update events", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isTauri.mockReturnValue(true);
		mocks.updateConfigToml.mockResolvedValue({
			success: true,
			restartedSessionIds: ["idle"],
			skippedBusySessionIds: ["busy"],
		});
		mocks.updateMcpConfig.mockResolvedValue({
			success: true,
			restartedSessionIds: ["idle"],
			skippedBusySessionIds: ["busy"],
		});
	});

	it("dispatches restart details after saving config.toml", async () => {
		const updates: CustomEvent[] = [];
		const listener = (event: Event) => updates.push(event as CustomEvent);
		window.addEventListener("kimi:config-update", listener);
		try {
			await updateConfigTomlFile('theme = "dark"\n');
		} finally {
			window.removeEventListener("kimi:config-update", listener);
		}

		expect(mocks.updateConfigToml).toHaveBeenCalledWith('theme = "dark"\n');
		expect(updates).toHaveLength(1);
		expect(updates[0].detail).toEqual(restartDetail);
	});

	it("dispatches restart details after saving mcp.json", async () => {
		const updates: CustomEvent[] = [];
		const listener = (event: Event) => updates.push(event as CustomEvent);
		window.addEventListener("kimi:config-update", listener);
		try {
			await updateMcpConfigFile('{"mcpServers":{}}\n');
		} finally {
			window.removeEventListener("kimi:config-update", listener);
		}

		expect(mocks.updateMcpConfig).toHaveBeenCalledWith('{"mcpServers":{}}\n');
		expect(updates).toHaveLength(1);
		expect(updates[0].detail).toEqual(restartDetail);
	});
});
