import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStream } from "./useSessionStream";

const mocks = vi.hoisted(() => ({
	isTauri: vi.fn(),
	onWireMessage: vi.fn(),
	replaySessionHistory: vi.fn(),
	wireConnect: vi.fn(),
	wireDisconnect: vi.fn(),
	wireSend: vi.fn(),
	wireStatus: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
	isTauri: mocks.isTauri,
	onWireMessage: mocks.onWireMessage,
	replaySessionHistory: mocks.replaySessionHistory,
	wireConnect: mocks.wireConnect,
	wireDisconnect: mocks.wireDisconnect,
	wireSend: mocks.wireSend,
	wireStatus: mocks.wireStatus,
}));

vi.mock("@/lib/version", () => ({
	resolveKimiCliVersion: vi.fn(() => Promise.resolve("test-version")),
}));

async function flushPromises() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("useSessionStream Tauri watchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.isTauri.mockReturnValue(true);
		mocks.onWireMessage.mockReturnValue(() => undefined);
		mocks.replaySessionHistory.mockResolvedValue([]);
		mocks.wireConnect.mockResolvedValue(undefined);
		mocks.wireDisconnect.mockResolvedValue(undefined);
		mocks.wireSend.mockResolvedValue(undefined);
		mocks.wireStatus.mockResolvedValue({
			sessionId: "session-1",
			state: "busy",
			seq: 1,
			workerId: "worker-1",
			reason: "prompt",
			detail: null,
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("syncs worker status instead of reconnecting after a quiet streaming period", async () => {
		renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();

		expect(mocks.wireConnect).toHaveBeenCalledTimes(1);
		expect(mocks.wireDisconnect).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(50_000);
		});
		await flushPromises();

		expect(mocks.wireStatus).toHaveBeenCalledWith("session-1");
		expect(mocks.wireConnect).toHaveBeenCalledTimes(1);
		expect(mocks.wireDisconnect).not.toHaveBeenCalled();
	});
});
