import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri-api";
import { isMacOS } from "@/hooks/utils";
import { cn } from "@/lib/utils";

async function withWindow(action: (win: {
	minimize: () => Promise<void>;
	toggleMaximize: () => Promise<void>;
	close: () => Promise<void>;
	isMaximized: () => Promise<boolean>;
	onResized: (handler: () => void) => Promise<() => void>;
}) => void | Promise<void>) {
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	await action(getCurrentWindow());
}

export function WindowControls({ className }: { className?: string }) {
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		if (!isTauri()) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;

		void withWindow(async (win) => {
			const sync = async () => {
				const next = await win.isMaximized();
				if (!disposed) setMaximized(next);
			};
			await sync();
			unlisten = await win.onResized(() => {
				void sync();
			});
		});

		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	if (!isTauri() || isMacOS()) return null;

	return (
		<div className={cn("flex items-center", className)}>
			<button
				type="button"
				aria-label="最小化"
				title="最小化"
				onClick={() => void withWindow((win) => win.minimize())}
				className="flex size-[30px] items-center justify-center rounded-r1 text-muted transition-colors hover:bg-hover hover:text-foreground"
			>
				<Minus size={14} strokeWidth={1.5} />
			</button>
			<button
				type="button"
				aria-label={maximized ? "还原" : "最大化"}
				title={maximized ? "还原" : "最大化"}
				onClick={() => void withWindow((win) => win.toggleMaximize())}
				className="flex size-[30px] items-center justify-center rounded-r1 text-muted transition-colors hover:bg-hover hover:text-foreground"
			>
				{maximized ? (
					<Copy size={12} strokeWidth={1.5} className="-scale-x-100" />
				) : (
					<Square size={12} strokeWidth={1.5} />
				)}
			</button>
			<button
				type="button"
				aria-label="关闭"
				title="关闭"
				onClick={() => void withWindow((win) => win.close())}
				className="flex size-[30px] items-center justify-center rounded-r1 text-muted transition-colors hover:bg-danger-bg hover:text-danger"
			>
				<X size={14} strokeWidth={1.5} />
			</button>
		</div>
	);
}
