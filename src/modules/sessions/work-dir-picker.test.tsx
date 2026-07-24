import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { workDirBasename, WorkDirPicker } from "./work-dir-picker";

describe("WorkDirPicker", () => {
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
});

describe("workDirBasename", () => {
	it("returns the last path segment", () => {
		expect(workDirBasename("C:\\projects\\foo")).toBe("foo");
		expect(workDirBasename("/home/user/repo/")).toBe("repo");
	});
});
