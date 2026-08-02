import { useCallback, useEffect, useState } from "react";
import { getProvidersOverview, type ProvidersOverview } from "@/lib/tauri-api";

export type UseProvidersOverviewReturn = {
	overview: ProvidersOverview | null;
	isLoading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
};

export function useProvidersOverview({
	enabled,
}: {
	enabled: boolean;
}): UseProvidersOverviewReturn {
	const [overview, setOverview] = useState<ProvidersOverview | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const next = await getProvidersOverview();
			setOverview(next);
		} catch (err) {
			setOverview(null);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		setIsLoading(true);
		setError(null);
		void getProvidersOverview()
			.then((next) => {
				if (!cancelled) setOverview(next);
			})
			.catch((err) => {
				if (!cancelled) {
					setOverview(null);
					setError(err instanceof Error ? err.message : String(err));
				}
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	useEffect(() => {
		if (!enabled) return;
		const handleConfigUpdate = () => {
			void refresh();
		};
		window.addEventListener("kimi:config-update", handleConfigUpdate);
		return () => {
			window.removeEventListener("kimi:config-update", handleConfigUpdate);
		};
	}, [enabled, refresh]);

	return {
		overview,
		isLoading,
		error,
		refresh,
	};
}
