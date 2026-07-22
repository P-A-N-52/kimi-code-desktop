import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KimiLoginPanel } from "./kimi-login-panel";

const mocks = vi.hoisted(() => ({
	isTauri: vi.fn(() => true),
	startKimiLogin: vi.fn(),
	pollKimiLogin: vi.fn(),
	cancelKimiLogin: vi.fn(),
	openExternal: vi.fn(),
	openKimiLogin: vi.fn(),
	kimiCredentialsStatus: vi.fn(),
	logoutKimi: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
	isTauri: mocks.isTauri,
	startKimiLogin: mocks.startKimiLogin,
	pollKimiLogin: mocks.pollKimiLogin,
	cancelKimiLogin: mocks.cancelKimiLogin,
	openExternal: mocks.openExternal,
	openKimiLogin: mocks.openKimiLogin,
	kimiCredentialsStatus: mocks.kimiCredentialsStatus,
	logoutKimi: mocks.logoutKimi,
}));

describe("KimiLoginPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isTauri.mockReturnValue(true);
		mocks.cancelKimiLogin.mockResolvedValue(undefined);
		mocks.openExternal.mockResolvedValue(undefined);
		mocks.kimiCredentialsStatus.mockResolvedValue({ present: false });
		mocks.logoutKimi.mockResolvedValue({ success: true, present: false });
	});

	it("starts device login and shows the user code", async () => {
		mocks.startKimiLogin.mockResolvedValue({
			loginId: "login-1",
			userCode: "ABCD-EFGH",
			verificationUri: "https://auth.kimi.com/device",
			verificationUriComplete: "https://auth.kimi.com/device?user_code=ABCD-EFGH",
			expiresIn: 900,
			interval: 5,
		});
		mocks.pollKimiLogin.mockResolvedValue({ kind: "pending", interval: 5 });

		render(<KimiLoginPanel />);
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Login" })).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: "Login" }));

		await waitFor(() => {
			expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
		});
		expect(mocks.startKimiLogin).toHaveBeenCalled();
		expect(mocks.openExternal).toHaveBeenCalledWith(
			"https://auth.kimi.com/device?user_code=ABCD-EFGH",
		);
	});

	it("reports success and invokes onSuccess", async () => {
		const onSuccess = vi.fn();
		mocks.startKimiLogin.mockResolvedValue({
			loginId: "login-2",
			userCode: "WXYZ-1234",
			verificationUri: "https://auth.kimi.com/device",
			verificationUriComplete: "https://auth.kimi.com/device?user_code=WXYZ-1234",
			expiresIn: 900,
			interval: 1,
		});
		mocks.pollKimiLogin.mockResolvedValue({ kind: "success" });

		render(<KimiLoginPanel onSuccess={onSuccess} />);
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Login" })).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: "Login" }));

		await waitFor(() => {
			expect(screen.getByText("WXYZ-1234")).toBeTruthy();
		});

		await waitFor(
			() => {
				expect(onSuccess).toHaveBeenCalled();
			},
			{ timeout: 2500 },
		);
		expect(
			screen.getByText("Login successful. Credentials saved for Kimi Code."),
		).toBeTruthy();
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Logout" })).toBeTruthy();
		});
		expect(screen.queryByRole("button", { name: "Login" })).toBeNull();
	});

	it("shows Logout when credentials are already present", async () => {
		mocks.kimiCredentialsStatus.mockResolvedValue({ present: true });

		render(<KimiLoginPanel />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Logout" })).toBeTruthy();
		});
		expect(screen.queryByRole("button", { name: "Login" })).toBeNull();
		expect(
			screen.getByText("Signed in. Credentials are saved like `kimi login`."),
		).toBeTruthy();
	});

	it("logs out and restores Login", async () => {
		const onLogout = vi.fn();
		mocks.kimiCredentialsStatus.mockResolvedValue({ present: true });

		render(<KimiLoginPanel onLogout={onLogout} />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Logout" })).toBeTruthy();
		});
		fireEvent.click(screen.getByRole("button", { name: "Logout" }));

		await waitFor(() => {
			expect(mocks.logoutKimi).toHaveBeenCalled();
			expect(onLogout).toHaveBeenCalled();
			expect(screen.getByRole("button", { name: "Login" })).toBeTruthy();
		});
		expect(screen.getByText("Logged out. Credentials cleared.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Logout" })).toBeNull();
	});
});
