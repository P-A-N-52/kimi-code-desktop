import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextConfigEditor } from "./settings-dialog";

const mocks = vi.hoisted(() => ({
	notifyTextConfigSaved: vi.fn(),
}));

vi.mock("@/lib/config-update-toast", () => ({
	notifyTextConfigSaved: mocks.notifyTextConfigSaved,
}));

function renderEditor({
	load,
	save = vi.fn(),
	onDirtyChange = vi.fn(),
}: {
	load: () => Promise<{ content: string; path: string }>;
	save?: (content: string) => Promise<{ success: boolean; error?: string | null }>;
	onDirtyChange?: (dirty: boolean) => void;
}) {
	render(
		<TextConfigEditor
			enabled
			label="config.toml"
			description="编辑配置"
			language="toml"
			load={load}
			save={save}
			onDirtyChange={onDirtyChange}
		/>,
	);
	return { onDirtyChange, save };
}

describe("TextConfigEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not expose stale content or save after a load failure, and retries", async () => {
		const load = vi
			.fn<() => Promise<{ content: string; path: string }>>()
			.mockRejectedValueOnce(new Error("native read failed"))
			.mockResolvedValueOnce({ content: "theme = \"dark\"\n", path: "/tmp/config.toml" });
		const save = vi.fn<() => Promise<{ success: boolean }>>().mockResolvedValue({ success: true });
		renderEditor({ load, save });

		await waitFor(() => {
			expect(screen.getByText("读取 config.toml 失败：native read failed")).toBeTruthy();
		});
		expect(screen.queryByRole("textbox")).toBeNull();
		const saveButton = screen.getByRole("button", { name: "保存 config.toml" }) as HTMLButtonElement;
		expect(saveButton.disabled).toBe(true);
		fireEvent.click(saveButton);
		expect(save).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
		await waitFor(() => {
			expect(load).toHaveBeenCalledTimes(2);
			expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe('theme = "dark"\n');
		});
	});

	it("treats a valid empty config as an editable draft", async () => {
		const load = vi
			.fn<() => Promise<{ content: string; path: string }>>()
			.mockResolvedValue({ content: "", path: "/tmp/config.toml" });
		const onDirtyChange = vi.fn();
		renderEditor({ load, onDirtyChange });

		const editor = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
		expect(editor.disabled).toBe(false);
		fireEvent.change(editor, { target: { value: "theme = \"light\"" } });
		await waitFor(() => {
			expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		});
		expect((screen.getByRole("button", { name: "保存 config.toml" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
	});
});
