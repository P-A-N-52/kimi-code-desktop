import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { ToolCard } from "./tool-card";

const baseToolCall: NonNullable<LiveMessage["toolCall"]> = {
	title: "Bash",
	type: "tool-Bash" as never,
	state: "output-available",
	input: { command: "npm test" },
	output: "✓ all passed",
};

describe("ToolCard", () => {
	it("默认折叠，点击展开显示输出，再点收起", () => {
		render(<ToolCard toolCall={baseToolCall} />);
		expect(document.querySelector("[data-slot=tool-body]")).toBeNull();
		fireEvent.click(screen.getByRole("button"));
		expect(document.querySelector("[data-slot=tool-body]")).not.toBeNull();
		expect(screen.getByText(/all passed/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button"));
		expect(document.querySelector("[data-slot=tool-body]")).toBeNull();
	});
	it("显示参数摘要", () => {
		render(<ToolCard toolCall={baseToolCall} />);
		expect(screen.getByText("npm test")).toBeTruthy();
	});
});
