import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./approval-card";

const approval = {
	id: "r1",
	action: "Bash",
	description: "$ npm run build",
	sender: "kimi",
};

describe("ApprovalCard", () => {
	it("三个操作分别回调对应决策", () => {
		const onRespond = vi.fn();
		render(<ApprovalCard approval={approval} onRespond={onRespond} />);
		fireEvent.click(screen.getByRole("button", { name: /允许/ }));
		expect(onRespond).toHaveBeenCalledWith("r1", "approve");
		fireEvent.click(screen.getByRole("button", { name: /^拒绝/ }));
		expect(onRespond).toHaveBeenCalledWith("r1", "reject");
		fireEvent.click(screen.getByRole("button", { name: "本会话不再询问" }));
		expect(onRespond).toHaveBeenCalledWith("r1", "approve_for_session");
	});
	it("已处理的审批显示终态", () => {
		render(
			<ApprovalCard
				approval={{ ...approval, resolved: true, approved: true }}
				onRespond={() => {}}
			/>,
		);
		expect(screen.getByText("已批准")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /允许/ })).toBeNull();
	});
});
