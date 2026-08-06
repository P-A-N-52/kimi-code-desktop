import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";

export type ConfirmOptions = {
	message: string;
	title?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
};

export type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

type PendingConfirm = {
	options: ConfirmOptions;
	resolve: (value: boolean) => void;
};

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * In-app replacement for window.confirm. Tauri webviews (WKWebView / WebView2)
 * do not implement native JS confirm dialogs: window.confirm never shows a
 * dialog and always returns falsy, silently blocking every confirm-gated
 * action. All confirm call sites must go through useConfirm() instead.
 */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
	const [pending, setPending] = useState<PendingConfirm | null>(null);
	const pendingRef = useRef<PendingConfirm | null>(null);

	const confirm = useCallback<ConfirmFn>((options) => {
		const normalized: ConfirmOptions =
			typeof options === "string" ? { message: options } : options;
		// A new confirm request supersedes any still-open one, resolving it as cancelled.
		const previous = pendingRef.current;
		if (previous) {
			previous.resolve(false);
		}
		return new Promise<boolean>((resolve) => {
			const next: PendingConfirm = { options: normalized, resolve };
			pendingRef.current = next;
			setPending(next);
		});
	}, []);

	const settle = useCallback((value: boolean) => {
		const current = pendingRef.current;
		pendingRef.current = null;
		setPending(null);
		current?.resolve(value);
	}, []);

	return (
		<ConfirmContext.Provider value={confirm}>
			{children}
			<Dialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) {
						settle(false);
					}
				}}
			>
				<DialogContent className="max-w-sm">
					{pending ? (
						<>
							<DialogTitle>{pending.options.title ?? "确认操作"}</DialogTitle>
							<DialogDescription className="whitespace-pre-wrap">
								{pending.options.message}
							</DialogDescription>
							<div className="mt-4 flex justify-end gap-2">
								<Button variant="ghost" onClick={() => settle(false)}>
									{pending.options.cancelLabel ?? "取消"}
								</Button>
								<Button
									variant={pending.options.danger ? "danger" : "primary"}
									onClick={() => settle(true)}
								>
									{pending.options.confirmLabel ?? "确定"}
								</Button>
							</div>
						</>
					) : null}
				</DialogContent>
			</Dialog>
		</ConfirmContext.Provider>
	);
}

export function useConfirm(): ConfirmFn {
	const context = useContext(ConfirmContext);
	if (!context) {
		throw new Error("useConfirm 必须在 <ConfirmDialogProvider> 内使用");
	}
	return context;
}
