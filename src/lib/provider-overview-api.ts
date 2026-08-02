import type {
	AcpAuthStatus,
	ProviderCredentialStatus,
	ProviderModelBinding,
	ProviderSummary,
	ProvidersOverview,
} from "@/lib/provider-overview";

export type {
	AcpAuthStatus,
	ProviderCredentialStatus,
	ProviderModelBinding,
	ProviderSummary,
	ProvidersOverview,
};

function normalizeCredentialStatus(value: unknown): ProviderCredentialStatus {
	return value === "configured" ? "configured" : "not_configured";
}

function normalizeAcpAuthStatus(value: unknown): AcpAuthStatus {
	return value === "failed" ? "failed" : "unknown";
}

function normalizeModelBinding(raw: Record<string, unknown>): ProviderModelBinding {
	return {
		alias: String(raw.alias ?? ""),
		upstreamModel: String(raw.upstreamModel ?? raw.upstream_model ?? ""),
		provider: String(raw.provider ?? ""),
		isDefault: Boolean(raw.isDefault ?? raw.is_default),
		maxContextSize: Number(raw.maxContextSize ?? raw.max_context_size ?? 0) || 0,
		capabilities: Array.isArray(raw.capabilities)
			? raw.capabilities.map(String)
			: undefined,
		supportEfforts: Array.isArray(raw.supportEfforts)
			? raw.supportEfforts.map(String)
			: Array.isArray(raw.support_efforts)
				? raw.support_efforts.map(String)
				: undefined,
		issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
	};
}

function normalizeProviderSummary(raw: Record<string, unknown>): ProviderSummary {
	return {
		name: String(raw.name ?? ""),
		providerType: String(raw.providerType ?? raw.provider_type ?? ""),
		baseUrl:
			typeof raw.baseUrl === "string"
				? raw.baseUrl
				: typeof raw.base_url === "string"
					? raw.base_url
					: null,
		credentialStatus: normalizeCredentialStatus(
			raw.credentialStatus ?? raw.credential_status,
		),
		credentialHint: String(raw.credentialHint ?? raw.credential_hint ?? ""),
		models: (
			(raw.models as Array<Record<string, unknown>> | undefined) ?? []
		).map(normalizeModelBinding),
		issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
	};
}

export function normalizeProvidersOverview(
	raw: Record<string, unknown>,
): ProvidersOverview {
	const acpAuth =
		(raw.acpAuth as Record<string, unknown> | undefined) ??
		(raw.acp_auth as Record<string, unknown> | undefined) ??
		{};
	return {
		configPath: String(raw.configPath ?? raw.config_path ?? ""),
		defaultModel: String(raw.defaultModel ?? raw.default_model ?? ""),
		structureValid: Boolean(raw.structureValid ?? raw.structure_valid),
		structureIssues: Array.isArray(raw.structureIssues)
			? raw.structureIssues.map(String)
			: Array.isArray(raw.structure_issues)
				? raw.structure_issues.map(String)
				: [],
		providers: (
			(raw.providers as Array<Record<string, unknown>> | undefined) ?? []
		).map(normalizeProviderSummary),
		kimiAccountCredentialsPresent: Boolean(
			raw.kimiAccountCredentialsPresent ?? raw.kimi_account_credentials_present,
		),
		acpAuth: {
			status: normalizeAcpAuthStatus(acpAuth.status),
			lastFailureAtMs:
				typeof acpAuth.lastFailureAtMs === "number"
					? acpAuth.lastFailureAtMs
					: typeof acpAuth.last_failure_at_ms === "number"
						? acpAuth.last_failure_at_ms
						: null,
			lastFailureMessage:
				typeof acpAuth.lastFailureMessage === "string"
					? acpAuth.lastFailureMessage
					: typeof acpAuth.last_failure_message === "string"
						? acpAuth.last_failure_message
						: null,
		},
	};
}
