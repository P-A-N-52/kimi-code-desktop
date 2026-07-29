import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workDirBasename, WorkDirPicker } from "./work-dir-picker";

vi.mock("@/lib/tauri-api", () => ({
	isTauri: vi.fn(() => true),
	pickFolder: vi.fn(),
}));

import { pickFolder } from "@/lib/tauri-api";

describe("WorkDirPicker", () => {
	beforeEach(() => {
		vi.mocked(pickFolder).mockReset();
	});

	it("shows basename of the current work directory", () => {
		render(
			<WorkDirPicker
				workDir="C:\\projects\\my-app"
				onWorkDirChange={vi.fn()}
				recentDirs={[]}
			/>,
		);
		expect(screen.getByRole("button", { name: /my-app/i })).toBeTruthy();
	});

	it("opens recent directories and selects one", () => {
		const onWorkDirChange = vi.fn();
		render(
			<WorkDirPicker
				workDir="C:\\projects\\alpha"
				onWorkDirChange={onWorkDirChange}
				recentDirs={["C:\\projects\\alpha", "C:\\projects\\beta"]}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
		fireEvent.click(screen.getByRole("button", { name: /beta/i }));
		expect(onWorkDirChange).toHaveBeenCalledWith("C:\\projects\\beta");
	});

	it("fills the path input from the native folder picker", async () => {
		vi.mocked(pickFolder).mockResolvedValue("C:\\projects\\from-dialog");
		const onWorkDirChange = vi.fn();
		render(
			<WorkDirPicker
				workDir="C:\\projects\\alpha"
				onWorkDirChange={onWorkDirChange}
				recentDirs={[]}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
		fireEvent.click(screen.getByRole("button", { name: /浏览/i }));
		await waitFor(() => {
			expect(screen.getByDisplayValue("C:\\projects\\from-dialog")).toBeTruthy();
		});
		expect(onWorkDirChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: /确定/i }));
		expect(onWorkDirChange).toHaveBeenCalledWith("C:\\projects\\from-dialog");
	});

	it("renders a fixed label without a selectable button when readOnly", () => {
		render(<WorkDirPicker workDir="C:\\projects\\my-app" readOnly />);
		expect(screen.getByLabelText(/工作目录 my-app/i)).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("workDirBasename", () => {
	it("returns the last path segment", () => {
		expect(workDirBasename("C:\\projects\\foo")).toBe("foo");
		expect(workDirBasename("/home/user/repo/")).toBe("repo");
	});
});
