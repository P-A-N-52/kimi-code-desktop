import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStream } from "./useSessionStream";

let wireMessageHandler: ((message: string) => void) | null = null;

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

function completeReplay() {
	const replay = mocks.wireSend.mock.calls
		.map(([, rawMessage]) => JSON.parse(rawMessage))
		.find((message) => message.method === "replay");
	expect(replay).toBeDefined();

	act(() => {
		wireMessageHandler?.(
			JSON.stringify({
				jsonrpc: "2.0",
				id: replay.id,
				result: { status: "finished" },
			}),
		);
	});
}

describe("useSessionStream Tauri watchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		window.localStorage.clear();
		mocks.isTauri.mockReturnValue(true);
		mocks.onWireMessage.mockImplementation(
			(_sessionId: string, handler: (message: string) => void) => {
				wireMessageHandler = handler;
				return () => undefined;
			},
		);
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
		wireMessageHandler = null;
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
		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "session_status",
					params: {
						session_id: "session-1",
						state: "busy",
						seq: 1,
						worker_id: "worker-1",
						updated_at: "2026-01-01T00:00:00Z",
					},
				}),
			);
		});

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

	it("sends Swarm mode updates and applies backend acknowledgements", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();

		act(() => {
			expect(result.current.sendSetSwarmMode(true)).toBe(true);
		});
		await flushPromises();

		const sentMessages = mocks.wireSend.mock.calls.map(([, message]) =>
			JSON.parse(message),
		);
		expect(sentMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: "set_swarm_mode",
					params: { enabled: true },
				}),
			]),
		);
		expect(result.current.swarmMode).toBe(true);

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: {
						type: "StatusUpdate",
						payload: {
							context_usage: null,
							swarm_mode: false,
						},
					},
				}),
			);
		});

		expect(result.current.swarmMode).toBe(false);
	});

	it("handles the local /swarm command without sending it as a prompt", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();
		mocks.wireSend.mockClear();

		await act(async () => {
			await result.current.sendMessage("/swarm on");
		});
		await flushPromises();

		const sentMessages = mocks.wireSend.mock.calls.map(([, message]) =>
			JSON.parse(message),
		);
		expect(sentMessages.some((message) => message.method === "prompt")).toBe(
			false,
		);
		expect(sentMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ method: "set_swarm_mode" }),
			]),
		);
		expect(result.current.swarmMode).toBe(true);
	});

	it("shows a sent user message before ACP echoes the turn", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();
		completeReplay();

		await act(async () => {
			await result.current.sendMessage("Hello from the user");
		});

		expect(
			result.current.messages.filter((message) => message.role === "user"),
		).toEqual([
			expect.objectContaining({ content: "Hello from the user" }),
		]);

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: {
						type: "TurnBegin",
						payload: { user_input: "Hello from the user" },
					},
				}),
			);
		});

		expect(
			result.current.messages.filter((message) => message.role === "user"),
		).toHaveLength(1);
	});

	it("renders SteerInput as an additional instruction in the active turn", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();
		completeReplay();

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: {
						type: "TurnBegin",
						payload: { user_input: "Build the feature" },
					},
				}),
			);
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: {
						type: "SteerInput",
						payload: { user_input: "Also add tests" },
					},
				}),
			);
		});

		expect(result.current.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					variant: "steer",
					content: "Also add tests",
					turnIndex: 0,
				}),
			]),
		);
	});

	it.each([
		["image_url", "https://example.com/result.png", "image/*"],
		["video_url", "https://example.com/result.mp4", "video/*"],
		["audio_url", "https://example.com/result.mp3", "audio/*"],
	] as const)(
		"renders %s content parts as message attachments",
		async (partType, url, mediaType) => {
			const { result } = renderHook(() =>
				useSessionStream({
					sessionId: "session-1",
					baseUrl: "http://localhost:5173",
					autoConnect: true,
				}),
			);

			await flushPromises();
			completeReplay();

			act(() => {
				wireMessageHandler?.(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "event",
						params: {
							type: "ContentPart",
							payload: {
								type: partType,
								[partType]: { url },
							},
						},
					}),
				);
			});

			expect(result.current.messages).toEqual([
				expect.objectContaining({
					role: "assistant",
					attachments: [
						expect.objectContaining({
							type: "file",
							mediaType,
							url,
						}),
					],
				}),
			]);
		},
	);

	it("sends a pending Tauri prompt without replaying preserved history", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: false,
			}),
		);

		await flushPromises();

		await act(async () => {
			await result.current.sendMessage("Send without duplicate history");
		});
		await flushPromises();

		const sentMessages = mocks.wireSend.mock.calls.map(([, rawMessage]) =>
			JSON.parse(rawMessage),
		);
		expect(sentMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: "prompt",
					params: expect.objectContaining({
						user_input: "Send without duplicate history",
					}),
				}),
			]),
		);
		expect(sentMessages.some((message) => message.method === "replay")).toBe(
			false,
		);
	});

	it("keeps the session ready when the completed prompt command resolves", async () => {
		let resolvePrompt: (() => void) | undefined;
		mocks.wireSend.mockImplementation((_sessionId: string, rawMessage: string) => {
			const message = JSON.parse(rawMessage);
			if (message.method !== "prompt") {
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				resolvePrompt = resolve;
			});
		});

		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();
		completeReplay();

		let sendPromise: Promise<void> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("Complete this prompt");
		});

		const prompt = mocks.wireSend.mock.calls
			.map(([, rawMessage]) => JSON.parse(rawMessage))
			.find((message) => message.method === "prompt");
		expect(prompt).toBeDefined();

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					id: prompt.id,
					result: { status: "finished" },
				}),
			);
		});
		expect(result.current.status).toBe("ready");

		await act(async () => {
			resolvePrompt?.();
			await sendPromise;
		});

		expect(result.current.status).toBe("ready");
	});

	it("auto-renames only after the first prompt response, not the connection idle status", async () => {
		const onFirstTurnComplete = vi.fn();
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: false,
				onFirstTurnComplete,
			}),
		);

		await flushPromises();

		await act(async () => {
			await result.current.sendMessage("Generate a title after completion");
		});
		await flushPromises();

		const prompt = mocks.wireSend.mock.calls
			.map(([, rawMessage]) => JSON.parse(rawMessage))
			.find((message) => message.method === "prompt");
		expect(prompt).toBeDefined();

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "session_status",
					params: {
						session_id: "session-1",
						state: "idle",
						seq: 1,
						updated_at: "2026-01-01T00:00:00Z",
					},
				}),
			);
		});
		expect(onFirstTurnComplete).not.toHaveBeenCalled();

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					id: prompt.id,
					result: { status: "finished" },
				}),
			);
		});
		expect(onFirstTurnComplete).toHaveBeenCalledTimes(1);
	});
});
