import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusPill } from "./status-pill";

describe("StatusPill", () => {
	it("on 态显示指示点并高亮", () => {
		render(<StatusPill on>swarm</StatusPill>);
		const pill = screen.getByText("swarm").closest("button");
		expect(pill).not.toBeNull();
		expect(pill?.className).toContain("bg-active");
	});
	it("tone=red 使用危险色", () => {
		render(<StatusPill tone="red">yolo</StatusPill>);
		const pill = screen.getByText("yolo").closest("button");
		expect(pill?.className).toContain("text-danger");
	});
});
