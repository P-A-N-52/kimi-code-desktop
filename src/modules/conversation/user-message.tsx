import type { ReactNode } from "react";

export function UserMessage({ children }: { children: ReactNode }) {
	return (
		<div className="my-5 flex justify-end">
			<div className="max-w-[82%] whitespace-pre-wrap rounded-r3 border border-line bg-secondary px-3.5 py-2.5 text-[14px]">
				{children}
			</div>
		</div>
	);
}
