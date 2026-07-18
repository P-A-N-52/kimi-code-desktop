import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
	it("primary 变体使用反转色", () => {
		render(<Button variant="primary">允许</Button>);
		const btn = screen.getByRole("button", { name: "允许" });
		expect(btn.className).toContain("bg-bright");
		expect(btn.className).toContain("text-background");
	});
	it("ghost 变体带发丝边框", () => {
		render(<Button variant="ghost">拒绝</Button>);
		expect(screen.getByRole("button", { name: "拒绝" }).className).toContain(
			"border-line-strong",
		);
	});
});
