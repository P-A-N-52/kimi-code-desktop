import { invoke, isTauri } from "@tauri-apps/api/core";
import type { FileMentionEntry } from "@/modules/composer/file-mentions";

function mapDirectoryEntries(raw: unknown[]): FileMentionEntry[] {
	return raw.map((item) => {
		const entry = item as Record<string, unknown>;
		return {
			name: String(entry.name ?? ""),
			type: entry.type === "directory" ? "directory" : "file",
			size: typeof entry.size === "number" ? entry.size : undefined,
		};
	});
}

/** List files under a work directory before a session exists (desktop only). */
export async function listWorkDirDirectory(
	workDir: string,
	path?: string,
): Promise<FileMentionEntry[]> {
	const dir = workDir.trim();
	if (!dir) {
		throw new Error("请先选择工作目录");
	}
	if (!isTauri()) {
		throw new Error("@ 文件引用需要在桌面应用中选择工作目录");
	}
	const raw = await invoke<unknown[]>("list_work_dir_directory", {
		workDir: dir,
		path: path ?? ".",
	});
	return mapDirectoryEntries(raw);
}
