import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStream } from "./useSessionStream";

let wireMessageHandler: ((message: string) => void) | null = null;

const mocks = vi.hoisted(() => ({
	getSessionSwarmMode: vi.fn(),
	isTauri: vi.fn(),
	migrateSessionSwarmMode: vi.fn(),
	onWireMessage: vi.fn(),
	replaySessionHistory: vi.fn(),
	wireConnect: vi.fn(),
	wireDisconnect: vi.fn(),
	wireSend: vi.fn(),
	wireStatus: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
	getSessionSwarmMode: mocks.getSessionSwarmMode,
	isTauri: mocks.isTauri,
	migrateSessionSwarmMode: mocks.migrateSessionSwarmMode,
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
	const sentMessages = mocks.wireSend.mock.calls.map(([, rawMessage]) =>
		JSON.parse(rawMessage),
	);
	const initialize = sentMessages.find((message) => message.method === "initialize");
	const replay = sentMessages.find((message) => message.method === "replay");
	expect(initialize).toBeDefined();
	expect(replay).toBeDefined();

	act(() => {
		wireMessageHandler?.(
			JSON.stringify({
				jsonrpc: "2.0",
				id: initialize.id,
				result: { slash_commands: [] },
			}),
		);
		wireMessageHandler?.(
			JSON.stringify({
				jsonrpc: "2.0",
				id: replay.id,
				result: { status: "finished" },
			}),
		);
	});
}

function emitVisibleText(text: string) {
	wireMessageHandler?.(
		JSON.stringify({
			jsonrpc: "2.0",
			method: "event",
			params: {
				type: "ContentPart",
				payload: { type: "text", text },
			},
		}),
	);
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
		mocks.getSessionSwarmMode.mockResolvedValue(false);
		mocks.migrateSessionSwarmMode.mockResolvedValue(undefined);
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
		completeReplay();
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

	it("loads Swarm mode from the Kimi session state", async () => {
		mocks.getSessionSwarmMode.mockResolvedValue(true);
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();

		expect(mocks.getSessionSwarmMode).toHaveBeenCalledWith("session-1");
		expect(result.current.swarmMode).toBe(true);
		expect(
			window.localStorage.getItem(
				"kimi-code-desktop.swarm-mode-by-session.v1",
			),
		).toBeNull();
	});

	it("migrates the legacy local Swarm value into the Kimi session state", async () => {
		window.localStorage.setItem(
			"kimi-code-desktop.swarm-mode-by-session.v1",
			JSON.stringify({ "session-1": true, "session-2": false }),
		);
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();

		expect(mocks.migrateSessionSwarmMode).toHaveBeenCalledWith(
			"session-1",
			true,
		);
		expect(mocks.migrateSessionSwarmMode).toHaveBeenCalledWith(
			"session-2",
			false,
		);
		expect(mocks.getSessionSwarmMode).not.toHaveBeenCalled();
		expect(result.current.swarmMode).toBe(true);
		expect(
			window.localStorage.getItem(
				"kimi-code-desktop.swarm-mode-by-session.v1",
			),
		).toBeNull();
	});

	it("syncs permission mode from the backend and sends independent updates", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();
		completeReplay();
		await flushPromises();
		mocks.wireSend.mockClear();

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: {
						type: "StatusUpdate",
						payload: {
							context_usage: null,
							plan_mode: true,
							permission_mode: "auto",
						},
					},
				}),
			);
		});

		expect(result.current.planMode).toBe(true);
		expect(result.current.permissionMode).toBe("auto");

		act(() => {
			expect(result.current.sendSetPermissionMode("yolo")).toBe(true);
		});
		await flushPromises();

		expect(result.current.permissionMode).toBe("yolo");
		expect(
			mocks.wireSend.mock.calls
				.map(([, message]) => JSON.parse(message))
				.find((message) => message.method === "set_permission_mode"),
		).toMatchObject({
			method: "set_permission_mode",
			params: { mode: "yolo" },
		});
	});

	it("defers Swarm mode updates until a busy session becomes idle", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();
		completeReplay();
		await flushPromises();
		mocks.wireSend.mockClear();

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "session_status",
					params: {
						session_id: "session-1",
						state: "busy",
						seq: 2,
						updated_at: "2026-01-01T00:00:01Z",
					},
				}),
			);
		});
		expect(result.current.status).toBe("streaming");
		act(() => {
			expect(result.current.sendSetSwarmMode(true)).toBe(true);
		});
		await flushPromises();

		expect(
			mocks.wireSend.mock.calls
				.map(([, rawMessage]) => JSON.parse(rawMessage))
				.some((message) => message.method === "set_swarm_mode"),
		).toBe(false);

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "session_status",
					params: {
						session_id: "session-1",
						state: "idle",
						seq: 3,
						updated_at: "2026-01-01T00:00:02Z",
					},
				}),
			);
		});
		await flushPromises();

		expect(
			mocks.wireSend.mock.calls
				.map(([, rawMessage]) => JSON.parse(rawMessage))
				.filter((message) => message.method === "set_swarm_mode"),
		).toHaveLength(1);
	});

	it("keeps background warmup non-blocking and ignores cancel while initializing", async () => {
		let resolveInitialize: (() => void) | undefined;
		mocks.wireSend.mockImplementation((_sessionId: string, rawMessage: string) => {
			const message = JSON.parse(rawMessage);
			if (message.method !== "initialize") {
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				resolveInitialize = resolve;
			});
		});

		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: false,
			}),
		);

		await flushPromises();
		act(() => {
			expect(result.current.sendSetSwarmMode(true)).toBe(true);
		});
		await flushPromises();

		expect(result.current.status).toBe("ready");
		expect(result.current.canCancel).toBe(false);
		act(() => result.current.cancel());

		expect(
			mocks.wireSend.mock.calls
				.map(([, rawMessage]) => JSON.parse(rawMessage))
				.some((message) => message.method === "cancel"),
		).toBe(false);

		await act(async () => {
			resolveInitialize?.();
			await flushPromises();
		});
	});

	it("still sends cancel when a real prompt is active", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();
		completeReplay();
		await flushPromises();
		mocks.wireSend.mockClear();

		await act(async () => {
			await result.current.sendMessage("Long running prompt");
		});
		expect(result.current.canCancel).toBe(true);
		act(() => result.current.cancel());
		await flushPromises();

		expect(
			mocks.wireSend.mock.calls
				.map(([, rawMessage]) => JSON.parse(rawMessage))
				.some((message) => message.method === "cancel"),
		).toBe(true);
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
		completeReplay();
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

	it("keeps user-authored system-like tags visible without an ACP echo", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: true,
			}),
		);

		await flushPromises();
		completeReplay();

		const literalText =
			"<system-reminder>this is user-authored text</system-reminder>";
		await act(async () => {
			await result.current.sendMessage(literalText);
		});

		expect(
			result.current.messages.filter((message) => message.role === "user"),
		).toEqual([expect.objectContaining({ content: literalText })]);
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

	it("keeps each assistant response attached to its own turn during fast replay", async () => {
		const replayEvent = (type: string, payload: unknown) =>
			JSON.stringify({
				jsonrpc: "2.0",
				method: "event",
				params: { type, payload },
			});
		mocks.replaySessionHistory.mockResolvedValue([
			replayEvent("TurnBegin", { user_input: "First question" }),
			replayEvent("StepBegin", { n: 1 }),
			replayEvent("ContentPart", { type: "text", text: "FIRST_RESPONSE" }),
			replayEvent("TurnBegin", { user_input: "Second question" }),
			replayEvent("StepBegin", { n: 1 }),
			replayEvent("ContentPart", { type: "text", text: "SECOND_RESPONSE" }),
		]);

		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: false,
			}),
		);

		await flushPromises();

		expect(
			result.current.messages
				.filter((message) => message.role === "assistant" && message.variant === "text")
				.map((message) => message.content),
		).toEqual(["FIRST_RESPONSE", "SECOND_RESPONSE"]);
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

	it("prewarms ACP after local history without replaying it a second time", async () => {
		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: false,
			}),
		);

		await flushPromises();

		expect(mocks.replaySessionHistory).toHaveBeenCalledWith("session-1");
		expect(mocks.wireConnect).toHaveBeenCalledWith("session-1");
		expect(result.current.status).toBe("ready");
		expect(result.current.isConnected).toBe(true);
		expect(
			mocks.wireSend.mock.calls
				.map(([, rawMessage]) => JSON.parse(rawMessage))
				.some((message) => message.method === "replay"),
		).toBe(false);
	});

	it("queues a prompt sent during background warmup and flushes it once connected", async () => {
		let resolveConnect: (() => void) | undefined;
		mocks.wireConnect.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveConnect = resolve;
				}),
		);

		const { result } = renderHook(() =>
			useSessionStream({
				sessionId: "session-1",
				baseUrl: "http://localhost:5173",
				autoConnect: false,
			}),
		);

		await flushPromises();
		await act(async () => {
			await result.current.sendMessage("Send during warmup");
		});

		expect(
			mocks.wireSend.mock.calls
				.map(([, rawMessage]) => JSON.parse(rawMessage))
				.some((message) => message.method === "prompt"),
		).toBe(false);

		await act(async () => {
			resolveConnect?.();
			await flushPromises();
		});

		expect(
			mocks.wireSend.mock.calls
				.map(([, rawMessage]) => JSON.parse(rawMessage))
				.some(
					(message) =>
						message.method === "prompt" &&
						message.params.user_input === "Send during warmup",
				),
		).toBe(true);
	});

	it("reports connection, dispatch, first-event, and first-visible-response timing", async () => {
		const timingLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
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
			await result.current.sendMessage("Measure the response");
		});
		expect(result.current.isAwaitingFirstResponse).toBe(true);

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: { type: "StepBegin", payload: { n: 1 } },
				}),
			);
		});
		expect(result.current.isAwaitingFirstResponse).toBe(true);

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: {
						type: "ContentPart",
						payload: { type: "text", text: "First token" },
					},
				}),
			);
		});
		expect(result.current.isAwaitingFirstResponse).toBe(false);
		expect(result.current.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "assistant", content: "First token" }),
			]),
		);

		expect(timingLog).toHaveBeenCalledWith(
			"[SessionStream][TTFR]",
			expect.objectContaining({
				sessionId: "session-1",
				workerReadyMs: expect.any(Number),
				promptSubmittedMs: expect.any(Number),
				firstEventMs: expect.any(Number),
				firstVisibleResponseMs: expect.any(Number),
				modelWaitMs: expect.any(Number),
			}),
		);
		timingLog.mockRestore();
	});

	it("enters streaming on the first ContentPart without waiting for StepBegin", async () => {
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
			await result.current.sendMessage("Stream without StepBegin");
		});
		expect(result.current.status).toBe("submitted");

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: {
						type: "ContentPart",
						payload: { type: "think", think: "Hmm" },
					},
				}),
			);
		});

		expect(result.current.status).toBe("streaming");
		expect(result.current.isAwaitingFirstResponse).toBe(false);
		expect(result.current.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					variant: "thinking",
					thinking: "Hmm",
					isStreaming: true,
				}),
			]),
		);
	});

	it("keeps thinking blocks interleaved with tool calls in live order", async () => {
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
			await result.current.sendMessage("Test every feature");
		});

		const emitEvent = (type: string, payload: unknown) => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: { type, payload },
				}),
			);
		};

		act(() => {
			emitEvent("ContentPart", { type: "think", think: "first thought" });
		});
		act(() => {
			emitEvent("ToolCall", {
				id: "call-1",
				function: { name: "Shell", arguments: "{}" },
			});
		});
		act(() => {
			emitEvent("ContentPart", { type: "think", think: "second thought" });
		});
		act(() => {
			emitEvent("ContentPart", { type: "text", text: "final answer" });
		});

		const assistantMessages = result.current.messages.filter(
			(message) => message.role === "assistant",
		);
		expect(assistantMessages.map((message) => message.variant)).toEqual([
			"thinking",
			"tool",
			"thinking",
			"text",
		]);
		expect(assistantMessages[0]).toEqual(
			expect.objectContaining({
				thinking: "first thought",
				isStreaming: false,
			}),
		);
		expect(assistantMessages[2]).toEqual(
			expect.objectContaining({ thinking: "second thought" }),
		);
	});

	it("turns a failed prompt status into a persistent error report", async () => {
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
			await result.current.sendMessage("Trigger an error");
		});

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "session_status",
					params: {
						session_id: "session-1",
						state: "error",
						seq: 2,
						reason: "prompt_error",
						detail: "provider returned 404",
						updated_at: "2026-01-01T00:00:01Z",
					},
				}),
			);
		});

		expect(result.current.isAwaitingFirstResponse).toBe(false);
		expect(result.current.status).toBe("error");
		expect(result.current.error?.message).toBe("provider returned 404");

		act(() => {
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "session_status",
					params: {
						session_id: "session-1",
						state: "idle",
						seq: 3,
						reason: "finished",
						updated_at: "2026-01-01T00:00:02Z",
					},
				}),
			);
		});

		expect(result.current.status).toBe("error");
		expect(result.current.error?.message).toBe("provider returned 404");
	});

	it("reports a finished prompt that returned no visible content", async () => {
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
			await result.current.sendMessage("Return something visible");
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
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "session_status",
					params: {
						session_id: "session-1",
						state: "idle",
						seq: 2,
						reason: "finished",
						updated_at: "2026-01-01T00:00:01Z",
					},
				}),
			);
		});

		expect(result.current.isAwaitingFirstResponse).toBe(false);
		expect(result.current.status).toBe("error");
		expect(result.current.error?.message).toBe("模型未返回可显示内容");
	});

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

	it("stays ready when idle arrives before the pending Tauri invoke resolves", async () => {
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
				autoConnect: false,
			}),
		);

		await flushPromises();
		await act(async () => {
			await result.current.sendMessage("First prompt after connect");
		});
		await flushPromises();

		const prompt = mocks.wireSend.mock.calls
			.map(([, rawMessage]) => JSON.parse(rawMessage))
			.find((message) => message.method === "prompt");
		expect(prompt).toBeDefined();

		act(() => {
			emitVisibleText("First response");
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					id: prompt.id,
					result: { status: "finished" },
				}),
			);
			wireMessageHandler?.(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "session_status",
					params: {
						session_id: "session-1",
						state: "idle",
						seq: 2,
						reason: "finished",
						updated_at: "2026-01-01T00:00:01Z",
					},
				}),
			);
		});

		expect(result.current.status).toBe("ready");

		await act(async () => {
			resolvePrompt?.();
			await flushPromises();
		});
		expect(result.current.status).toBe("ready");
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
			emitVisibleText("Completed response");
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
			emitVisibleText("Title-worthy response");
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
