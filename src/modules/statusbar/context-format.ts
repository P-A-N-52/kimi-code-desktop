// 与原生 CLI footer 的 context 读数保持一致：
// - 百分比优先用精确 token 数计算（ceil、clamp 到 [0,100]、非零至少 1%）
// - token 数为 1024 进制紧凑格式（85.3k / 977k / 256k / 1.5M）

function trimDecimal(value: string): string {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function formatScaled(value: number, suffix: string): string {
	if (value >= 100) return `${Math.round(value)}${suffix}`;
	return `${trimDecimal(value.toFixed(1))}${suffix}`;
}

export function formatTokenCount(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n >= 1048576) return formatScaled(n / 1048576, "M");
	if (n >= 1024) return formatScaled(n / 1024, "k");
	return `${Math.round(n)}`;
}

function hasExactWindow(
	contextTokens?: number | null,
	maxContextTokens?: number | null,
): contextTokens is number {
	return (
		typeof contextTokens === "number" &&
		Number.isFinite(contextTokens) &&
		typeof maxContextTokens === "number" &&
		maxContextTokens > 0
	);
}

export function contextPercent(
	usage: number,
	contextTokens?: number | null,
	maxContextTokens?: number | null,
): number {
	const ratio = hasExactWindow(contextTokens, maxContextTokens)
		? contextTokens / (maxContextTokens as number)
		: Number.isFinite(usage)
			? usage
			: 0;
	if (ratio <= 0) return 0;
	// ceil 天然保证非零用量至少显示 1%
	return Math.min(100, Math.ceil(ratio * 100));
}

export function formatContextStatus(
	usage: number,
	contextTokens?: number | null,
	maxContextTokens?: number | null,
): string {
	const pct = contextPercent(usage, contextTokens, maxContextTokens);
	if (hasExactWindow(contextTokens, maxContextTokens)) {
		return `context: ${pct}% (${formatTokenCount(contextTokens)}/${formatTokenCount(maxContextTokens as number)})`;
	}
	return `context: ${pct}%`;
}
