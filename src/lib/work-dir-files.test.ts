import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: vi.fn(() => true),
	invoke: vi.fn(async (_cmd: string, args: { workDir: string; path: string }) => [
		{ name: "src", type: "directory" },
		{ name: "README.md", type: "file", size: 12 },
	]),
}));

import { invoke } from "@tauri-apps/api/core";
import { listWorkDirDirectory } from "./work-dir-files";

describe("listWorkDirDirectory", () => {
	it("lists entries for a work directory via Tauri invoke", async () => {
		const entries = await listWorkDirDirectory("C:\\projects\\demo", "src");
		expect(invoke).toHaveBeenCalledWith("list_work_dir_directory", {
			workDir: "C:\\projects\\demo",
			path: "src",
		});
		expect(entries).toEqual([
			{ name: "src", type: "directory", size: undefined },
			{ name: "README.md", type: "file", size: 12 },
		]);
	});

	it("rejects empty work directory", async () => {
		await expect(listWorkDirDirectory("  ")).rejects.toThrow("请先选择工作目录");
	});
});
