import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

describe("AppShell", () => {
	it("渲染主内容区", () => {
		render(
			<AppShell
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
	it("sidebarOpen=false 时侧栏收起为窄条", () => {
		const { container } = render(
			<AppShell
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
		expect((sidebar as HTMLElement).style.width).toBe("52px");
	});

	it("双开时左栏带窄屏 overlay 类，右栏仅在打开时 overlay", () => {
		const { container } = render(
			<AppShell
				sidebar={<div>S</div>}
				sidebarOpen
				topbar={<div />}
				panel={<div>P</div>}
				panelOpen
			>
				<div />
			</AppShell>,
		);
		const sidebar = container.querySelector("[data-slot=sessions-sidebar]");
		const spacer = container.querySelector("[data-slot=sessions-sidebar-spacer]");
		const panel = container.querySelector("[data-slot=workspace-panel]");
		expect(sidebar?.className).toContain("max-[1100px]:absolute");
		expect(sidebar?.className).not.toContain("max-[900px]:absolute");
		expect(spacer).not.toBeNull();
		expect(panel?.className).toContain("max-[900px]:absolute");
	});

	it("仅侧栏展开时不 overlay，避免最小宽度下盖住对话框", () => {
		const { container } = render(
			<AppShell
				sidebar={<div>S</div>}
				sidebarOpen
				topbar={<div />}
				panel={<div>P</div>}
				panelOpen={false}
			>
				<div />
			</AppShell>,
		);
		const sidebar = container.querySelector("[data-slot=sessions-sidebar]");
		const spacer = container.querySelector("[data-slot=sessions-sidebar-spacer]");
		const panel = container.querySelector("[data-slot=workspace-panel]");
		expect(sidebar?.className).not.toContain("absolute");
		expect(spacer).toBeNull();
		expect(panel?.className).not.toContain("max-[900px]:absolute");
	});

	it("顶栏拖拽区存在且内容层 pointer-events-none，避免挡住拖拽", () => {
		const { container } = render(
			<AppShell
				sidebar={<div />}
				sidebarOpen
				topbar={<button type="button">title</button>}
				panel={<div />}
				panelOpen={false}
			>
				<div />
			</AppShell>,
		);
		const drag = container.querySelector("[data-tauri-drag-region]");
		expect(drag).not.toBeNull();
		const content = drag?.querySelector(":scope > div");
		expect(content?.className).toContain("pointer-events-none");
		expect(content?.className).toContain("[&>*]:pointer-events-auto");
	});
});
