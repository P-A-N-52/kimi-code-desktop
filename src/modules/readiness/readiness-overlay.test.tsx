import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadinessOverlay } from "./readiness-overlay";

describe("ReadinessOverlay", () => {
	it("checking 时显示检测中文案", () => {
		render(
			<ReadinessOverlay checking readiness={null} error={null} onRetry={() => {}} onContinue={() => {}} onOpenDownload={() => {}} />,
		);
		expect(screen.getByText(/正在检查运行环境/)).toBeTruthy();
	});
	it("error 时展示错误并可重试", () => {
		const onRetry = vi.fn();
		render(
			<ReadinessOverlay checking={false} readiness={null} error="boom" onRetry={onRetry} onContinue={() => {}} onOpenDownload={() => {}} />,
		);
		expect(screen.getByText("boom")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(onRetry).toHaveBeenCalled();
	});
});
