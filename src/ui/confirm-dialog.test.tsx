import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider, useConfirm, type ConfirmFn } from "./confirm-dialog";

function Harness({
	onResult,
	options,
}: {
	onResult: (value: boolean) => void;
	options: Parameters<ConfirmFn>[0];
}) {
	const confirm = useConfirm();
	return (
		<button type="button" onClick={() => void confirm(options).then(onResult)}>
			触发确认
		</button>
	);
}

function renderHarness(options: Parameters<ConfirmFn>[0], onResult = vi.fn()) {
	render(
		<ConfirmDialogProvider>
			<Harness onResult={onResult} options={options} />
		</ConfirmDialogProvider>,
	);
	return onResult;
}

describe("ConfirmDialogProvider / useConfirm", () => {
	it("resolves true when the confirm button is clicked", async () => {
		const onResult = renderHarness({
			message: "确定要删除吗？",
			confirmLabel: "删除",
			danger: true,
		});

		fireEvent.click(screen.getByRole("button", { name: "触发确认" }));
		expect(screen.getByText("确定要删除吗？")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "删除" }));

		await waitFor(() => {
			expect(onResult).toHaveBeenCalledWith(true);
		});
		expect(screen.queryByText("确定要删除吗？")).toBeNull();
	});

	it("resolves false when cancelled", async () => {
		const onResult = renderHarness("直接字符串消息");

		fireEvent.click(screen.getByRole("button", { name: "触发确认" }));
		expect(screen.getByText("直接字符串消息")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "取消" }));

		await waitFor(() => {
			expect(onResult).toHaveBeenCalledWith(false);
		});
	});
});
