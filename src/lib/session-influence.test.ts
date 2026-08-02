import { describe, expect, it } from "vitest";
import type { SlashCommandDef } from "./slash-command-catalog";
import {
	applyRuntimeInfluenceSignals,
	collectRuntimePluginIds,
	normalizeSessionInfluenceSnapshot,
} from "./session-influence";

describe("session-influence", () => {
	it("normalizes disk snapshot without implying session load", () => {
		const snapshot = normalizeSessionInfluenceSnapshot({
			plugins: [
				{
					id: "demo",
					installedOnDisk: true,
					enabledInConfig: true,
					skillCount: 1,
				},
			],
			agents: [
				{
					name: "reviewer",
					sourceScope: "project",
					sourceLabel: "project:.kimi-code/agents",
					overrideBuiltin: true,
					riskFlags: ["override"],
				},
			],
			hasSystemMd: true,
		});

		expect(snapshot.plugins[0]?.sessionStatus).toBe("unknown");
		expect(snapshot.agents[0]?.sessionStatus).toBe("unknown");
		expect(snapshot.hasSystemMd).toBe(true);
	});

	it("marks plugin loaded only when runtime commands prove it", () => {
		const disk = normalizeSessionInfluenceSnapshot({
			plugins: [
				{
					id: "kimi-finance",
					installedOnDisk: true,
					enabledInConfig: true,
				},
			],
		});
		const runtimeCommands: SlashCommandDef[] = [
			{
				name: "kimi-finance:report",
				description: "Report",
				aliases: [],
				source: "runtime:plugin:kimi-finance",
			},
		];

		const merged = applyRuntimeInfluenceSignals(disk, runtimeCommands, true);
		expect(merged.plugins[0]?.sessionStatus).toBe("loaded_in_current_session");

		const withoutUpdate = applyRuntimeInfluenceSignals(disk, runtimeCommands, false);
		expect(withoutUpdate.plugins[0]?.sessionStatus).toBe("unknown");
	});

	it("collects runtime plugin ids from namespaced commands", () => {
		const ids = collectRuntimePluginIds([
			{
				name: "plugin.review",
				description: "",
				aliases: [],
				source: "runtime:plugin",
			},
			{
				name: "demo:run",
				description: "",
				aliases: [],
				source: "runtime:plugin:demo",
			},
		]);
		expect(ids.has("demo")).toBe(true);
	});
});
