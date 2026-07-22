import { useCallback, useEffect, useRef, useState } from "react";
import {
	cancelKimiLogin,
	isTauri,
	kimiCredentialsStatus,
	logoutKimi,
	openExternal,
	openKimiLogin,
	pollKimiLogin,
	startKimiLogin,
	type KimiLoginStart,
} from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

type LoginPhase = "idle" | "starting" | "waiting" | "success" | "error";

export function KimiLoginPanel({
	className,
	compact = false,
	onSuccess,
	onLogout,
}: {
	className?: string;
	compact?: boolean;
	onSuccess?: () => void;
	onLogout?: () => void;
}) {
	const [phase, setPhase] = useState<LoginPhase>("idle");
	const [loggedIn, setLoggedIn] = useState(false);
	const [authChecked, setAuthChecked] = useState(false);
	const [session, setSession] = useState<KimiLoginStart | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [loggingOut, setLoggingOut] = useState(false);
	const loginIdRef = useRef<string | null>(null);
	const cancelledRef = useRef(false);
	const timerRef = useRef<number | null>(null);

	const clearTimer = useCallback(() => {
		if (timerRef.current != null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const refreshAuthStatus = useCallback(async () => {
		if (!isTauri()) {
			setLoggedIn(false);
			setAuthChecked(true);
			return;
		}
		try {
			const status = await kimiCredentialsStatus();
			setLoggedIn(status.present);
		} catch {
			setLoggedIn(false);
		} finally {
			setAuthChecked(true);
		}
	}, []);

	useEffect(() => {
		void refreshAuthStatus();
	}, [refreshAuthStatus]);

	const reset = useCallback(() => {
		clearTimer();
		cancelledRef.current = true;
		const id = loginIdRef.current;
		loginIdRef.current = null;
		if (id) {
			void cancelKimiLogin(id).catch(() => {});
		}
		setSession(null);
		setMessage(null);
		setCopied(false);
		setPhase("idle");
	}, [clearTimer]);

	useEffect(() => {
		return () => {
			clearTimer();
			cancelledRef.current = true;
			const id = loginIdRef.current;
			if (id) {
				void cancelKimiLogin(id).catch(() => {});
			}
		};
	}, [clearTimer]);

	const schedulePoll = useCallback(
		(loginId: string, intervalSec: number) => {
			clearTimer();
			timerRef.current = window.setTimeout(() => {
				void (async () => {
					if (cancelledRef.current || loginIdRef.current !== loginId) return;
					try {
						const result = await pollKimiLogin(loginId);
						if (cancelledRef.current || loginIdRef.current !== loginId) return;
						switch (result.kind) {
							case "pending":
								schedulePoll(
									loginId,
									Math.max(1, result.interval ?? intervalSec),
								);
								return;
							case "success":
								loginIdRef.current = null;
								setLoggedIn(true);
								setPhase("idle");
								setSession(null);
								setMessage("Login successful. Credentials saved for Kimi Code.");
								onSuccess?.();
								return;
							case "expired":
								loginIdRef.current = null;
								setPhase("error");
								setMessage("Device code expired. Start login again.");
								return;
							case "denied":
								loginIdRef.current = null;
								setPhase("error");
								setMessage(result.message || "Authorization denied.");
								return;
							case "cancelled":
								setPhase("idle");
								setSession(null);
								setMessage(null);
								return;
							case "error":
								loginIdRef.current = null;
								setPhase("error");
								setMessage(result.message);
								return;
						}
					} catch (err) {
						if (cancelledRef.current || loginIdRef.current !== loginId) return;
						loginIdRef.current = null;
						setPhase("error");
						setMessage(err instanceof Error ? err.message : String(err));
					}
				})();
			}, Math.max(1, intervalSec) * 1000);
		},
		[clearTimer, onSuccess],
	);

	const startLogin = useCallback(async () => {
		if (!isTauri()) {
			setPhase("error");
			setMessage("Kimi login is only available in the desktop app");
			return;
		}
		clearTimer();
		cancelledRef.current = false;
		setPhase("starting");
		setMessage(null);
		setCopied(false);
		setSession(null);
		try {
			const started = await startKimiLogin();
			if (!started.loginId || !started.userCode) {
				throw new Error("Login response was incomplete.");
			}
			loginIdRef.current = started.loginId;
			setSession(started);
			setPhase("waiting");
			const openUrl =
				started.verificationUriComplete || started.verificationUri;
			if (openUrl) {
				void openExternal(openUrl).catch(() => {});
			}
			schedulePoll(started.loginId, started.interval);
		} catch (err) {
			loginIdRef.current = null;
			setPhase("error");
			setMessage(err instanceof Error ? err.message : String(err));
		}
	}, [clearTimer, schedulePoll]);

	const handleLogout = useCallback(async () => {
		if (!isTauri()) {
			setPhase("error");
			setMessage("Kimi login is only available in the desktop app");
			return;
		}
		setLoggingOut(true);
		setMessage(null);
		try {
			await logoutKimi();
			reset();
			setLoggedIn(false);
			setMessage("Logged out. Credentials cleared.");
			onLogout?.();
		} catch (err) {
			setPhase("error");
			setMessage(err instanceof Error ? err.message : String(err));
		} finally {
			setLoggingOut(false);
		}
	}, [onLogout, reset]);

	const copyCode = useCallback(async () => {
		if (!session?.userCode) return;
		try {
			await navigator.clipboard.writeText(session.userCode);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			setCopied(false);
		}
	}, [session?.userCode]);

	const openBrowser = useCallback(() => {
		const url =
			session?.verificationUriComplete || session?.verificationUri || "";
		if (!url) return;
		void openExternal(url).catch((err) => {
			setMessage(err instanceof Error ? err.message : String(err));
		});
	}, [session]);

	const openTerminalFallback = useCallback(async () => {
		try {
			await openKimiLogin();
			setMessage("Kimi login terminal opened");
		} catch (err) {
			setMessage(
				err instanceof Error ? err.message : "Failed to open Kimi login",
			);
		}
	}, []);

	const showLoggedIn =
		authChecked && loggedIn && phase !== "waiting" && phase !== "starting";

	return (
		<div
			className={cn(
				"rounded-r2 border border-line bg-elevated/60 p-3",
				className,
			)}
		>
			<div className="mb-2 flex items-center justify-between gap-2">
				<div>
					<div className="text-[12.5px] font-medium text-foreground">
						Kimi Code auth
					</div>
					{!compact && (
						<p className="mt-0.5 text-[11px] text-muted">
							{showLoggedIn
								? "Signed in. Credentials are saved like `kimi login`."
								: "Sign in with a device code in this app. Credentials are saved like `kimi login`."}
						</p>
					)}
					{compact && showLoggedIn && (
						<p className="mt-0.5 text-[11px] text-muted">Signed in</p>
					)}
				</div>
				{showLoggedIn ? (
					<Button
						variant="ghost"
						disabled={loggingOut}
						onClick={() => void handleLogout()}
					>
						{loggingOut ? "Logging out…" : "Logout"}
					</Button>
				) : (
					(phase === "idle" || phase === "error" || phase === "success") && (
						<Button
							variant="primary"
							disabled={!authChecked}
							onClick={() => void startLogin()}
						>
							Login
						</Button>
					)
				)}
			</div>

			{phase === "starting" && (
				<p className="font-mono text-[11px] text-faint">Starting login…</p>
			)}

			{phase === "waiting" && session && (
				<div className="space-y-2.5">
					<p className="text-[11.5px] text-muted">
						Open the link, sign in, and confirm this code:
					</p>
					<button
						type="button"
						onClick={() => void copyCode()}
						className="w-full rounded-r2 border border-line-strong bg-background px-3 py-3 text-center font-mono text-[22px] tracking-[0.18em] text-bright transition-colors hover:bg-hover"
						title="Copy code"
					>
						{session.userCode}
					</button>
					<p className="truncate font-mono text-[10.5px] text-faint">
						{session.verificationUriComplete || session.verificationUri}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button variant="primary" onClick={openBrowser}>
							Open browser
						</Button>
						<Button variant="ghost" onClick={() => void copyCode()}>
							{copied ? "Copied" : "Copy code"}
						</Button>
						<Button variant="ghost" onClick={reset}>
							Cancel
						</Button>
					</div>
					<p className="font-mono text-[10.5px] text-faint">
						Waiting for authorization…
					</p>
				</div>
			)}

			{(phase === "success" || phase === "error" || message) &&
				phase !== "waiting" &&
				message && (
					<p
						className={cn(
							"mt-2 font-mono text-[11px]",
							showLoggedIn || message.startsWith("Login successful")
								? "text-success"
								: message.startsWith("Logged out")
									? "text-muted"
									: "text-danger",
						)}
					>
						{message}
					</p>
				)}

			{!showLoggedIn && phase !== "waiting" && phase !== "starting" && (
				<button
					type="button"
					className="mt-2 text-left font-mono text-[10.5px] text-faint underline-offset-2 hover:text-muted hover:underline"
					onClick={() => void openTerminalFallback()}
				>
					Open terminal login instead
				</button>
			)}
		</div>
	);
}
