export type ProviderCredentialStatus = "not_configured" | "configured";

export type RuntimeAuthStatus = "unknown" | "failed";

export type ProviderModelBinding = {
	alias: string;
	upstreamModel: string;
	provider: string;
	isDefault: boolean;
	maxContextSize: number;
	capabilities?: string[];
	supportEfforts?: string[];
	issues: string[];
};

export type ProviderSummary = {
	name: string;
	providerType: string;
	baseUrl: string | null;
	credentialStatus: ProviderCredentialStatus;
	credentialHint: string;
	models: ProviderModelBinding[];
	issues: string[];
};

export type ProvidersOverview = {
	configPath: string;
	defaultModel: string;
	structureValid: boolean;
	structureIssues: string[];
	providers: ProviderSummary[];
	kimiAccountCredentialsPresent: boolean;
	runtimeAuth: {
		status: RuntimeAuthStatus;
		lastFailureAtMs: number | null;
		lastFailureMessage: string | null;
	};
};

export function providerCredentialLabel(status: ProviderCredentialStatus): string {
	switch (status) {
		case "configured":
			return "已配置";
		case "not_configured":
			return "未配置";
	}
}

export function runtimeAuthStatusLabel(status: RuntimeAuthStatus): string {
	switch (status) {
		case "failed":
			return "上次 Runtime 认证失败";
		case "unknown":
			return "Runtime 认证状态未知";
	}
}

export function formatCapabilities(capabilities: string[] | undefined): string {
	if (!capabilities?.length) return "（无）";
	return capabilities.join(" · ");
}

export function overviewHasConfiguredProviders(overview: ProvidersOverview): boolean {
	return overview.providers.some(
		(provider) => provider.credentialStatus === "configured",
	);
}
