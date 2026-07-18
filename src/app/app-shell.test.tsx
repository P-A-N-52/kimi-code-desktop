import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

describe("AppShell", () => {
	it("渲染主内容区", () => {
		render(
			<AppShell
				rail={<div />}
				sidebar={<div />}
				sidebarOpen
				topbar={<div />}
				panel={<div />}
				panelOpen
			>
				<div>content</div>
			</AppShell>,
		);
		expect(screen.getByText("content")).toBeTruthy();
	});
	it("panelOpen=false 时面板宽度为 0", () => {
		const { container } = render(
			<AppShell
				rail={<div />}
				sidebar={<div />}
				sidebarOpen
				topbar={<div />}
				panel={<div>P</div>}
				panelOpen={false}
			>
				<div />
			</AppShell>,
		);
		const panel = container.querySelector("[data-slot=workspace-panel]");
		expect(panel).not.toBeNull();
		expect((panel as HTMLElement).style.width).toBe("0px");
	});
	it("sidebarOpen=false 时侧栏宽度为 0", () => {
		const { container } = render(
			<AppShell
				rail={<div />}
				sidebar={<div>S</div>}
				sidebarOpen={false}
				topbar={<div />}
				panel={<div />}
				panelOpen={false}
			>
				<div />
			</AppShell>,
		);
		const sidebar = container.querySelector("[data-slot=sessions-sidebar]");
		expect((sidebar as HTMLElement).style.width).toBe("0px");
	});
});
