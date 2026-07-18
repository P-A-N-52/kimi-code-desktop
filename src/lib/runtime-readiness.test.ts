import { describe, expect, it } from "vitest";
import type { RuntimeReadiness } from "@/lib/tauri-api";
import {
	getRuntimeReadinessKind,
	shouldPauseForRuntimeReadiness,
} from "./runtime-readiness";

function readiness(overrides: Partial<RuntimeReadiness>): RuntimeReadiness {
	return {
		ok: true,
		hasBlockingIssues: false,
		checks: [],
		issues: [],
		warnings: [],
		bundledRuntime: { available: false },
		externalCli: { available: true, program: "kimi", version: "0.18.0" },
		config: {
			exists: true,
			ready: true,
			hasDefaultModel: true,
			hasProviderSection: true,
			hasModelSection: true,
			hasCredentialSource: true,
			credentialSources: ["config api_key"],
		},
		...overrides,
	};
}

describe("runtime readiness", () => {
	it("treats clean readiness as ready", () => {
		const state = readiness({});
		expect(getRuntimeReadinessKind(state)).toBe("ready");
		expect(shouldPauseForRuntimeReadiness(state, false)).toBe(false);
	});

	it("pauses on warnings until acknowledged", () => {
		const state = readiness({ warnings: ["Kimi Code config not present yet"] });
		expect(getRuntimeReadinessKind(state)).toBe("warning");
		expect(shouldPauseForRuntimeReadiness(state, false)).toBe(true);
		expect(shouldPauseForRuntimeReadiness(state, true)).toBe(false);
	});

	it("treats blocking issues as blocked", () => {
		const state = readiness({
			ok: false,
			hasBlockingIssues: true,
			issues: ["Config missing"],
		});
		expect(getRuntimeReadinessKind(state)).toBe("blocked");
		expect(shouldPauseForRuntimeReadiness(state, false)).toBe(true);
	});

	it("allows continuing after a failed readiness command is acknowledged", () => {
		expect(shouldPauseForRuntimeReadiness(null, false)).toBe(true);
		expect(shouldPauseForRuntimeReadiness(null, true)).toBe(false);
	});
});
