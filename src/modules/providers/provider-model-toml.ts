import { parse } from "smol-toml";

export const PROVIDER_TYPE_OPTIONS = ["openai", "openai_responses", "anthropic"] as const;

export const MODEL_PROTOCOL_OPTIONS = ["openai", "openai_responses", "anthropic"] as const;

export const MODEL_CAPABILITY_OPTIONS = [
	"thinking",
	"always_thinking",
	"image_in",
	"video_in",
] as const;

export type ProviderEditorConfig = {
	name: string;
	type: string;
	baseUrl: string;
	apiKey: string;
	envRaw: string;
	customHeadersRaw: string;
	hasNestedSettings: boolean;
};

export type ModelEditorConfig = {
	name: string;
	provider: string;
	protocol: string;
	upstreamModel: string;
	displayName: string;
	maxContextSize: string;
	capabilities: string[];
	supportEfforts: string[];
	defaultEffort: string;
};

export type ProviderModelConfig = {
	providers: ProviderEditorConfig[];
	models: ModelEditorConfig[];
	defaultModel: string;
};

export type TomlMutationResult = {
	content: string;
	error?: string;
	providerName?: string;
	modelName?: string;
	fallbackModelName?: string;
};

type TomlHeaderKind = "table" | "array-table";

type TomlHeader = {
	kind: TomlHeaderKind;
	parts: string[];
	start: number;
	end: number;
	leading: string;
	trailing: string;
};

type TomlSection = TomlHeader & {
	kind: "table";
};

type TomlValueRange = {
	start: number;
	end: number;
	raw: string;
	prefix: string;
};

type TomlAssignment = {
	key: string;
	value: string;
	prefix: string;
};

function splitLines(content: string): string[] {
	return content.length > 0 ? content.split(/\r?\n/) : [];
}

function lineEndingFor(content: string): "\n" | "\r\n" {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

function joinLines(lines: string[], originalContent: string): string {
	return lines.join(lineEndingFor(originalContent));
}

function parseTomlTableHeader(line: string): Omit<TomlHeader, "start" | "end"> | null {
	const firstContentIndex = line.search(/\S/);
	if (firstContentIndex < 0) {
		return null;
	}

	const leading = line.slice(0, firstContentIndex);
	const trimmedStart = line.slice(firstContentIndex);
	if (!trimmedStart.startsWith("[")) {
		return null;
	}

	const kind: TomlHeaderKind = trimmedStart.startsWith("[[") ? "array-table" : "table";
	const openingLength = kind === "array-table" ? 2 : 1;
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let index = openingLength; index < trimmedStart.length; index += 1) {
		const character = trimmedStart[index];
		if (quote) {
			if (quote === '"' && escaped) {
				escaped = false;
				continue;
			}
			if (quote === '"' && character === "\\") {
				escaped = true;
				continue;
			}
			if (quote === "'" && character === "'" && trimmedStart[index + 1] === "'") {
				index += 1;
				continue;
			}
			if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character !== "]") {
			continue;
		}

		const closingLength = kind === "array-table" ? 2 : 1;
		if (kind === "array-table" && trimmedStart[index + 1] !== "]") {
			continue;
		}
		const trailing = trimmedStart.slice(index + closingLength);
		if (trailing.trim().length > 0 && !trailing.trimStart().startsWith("#")) {
			return null;
		}
		return {
			kind,
			parts: splitTomlPath(trimmedStart.slice(openingLength, index).trim()),
			leading,
			trailing,
		};
	}
	return null;
}

function decodeTomlPathSegment(segment: string): string {
	const trimmed = segment.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	return trimmed;
}

function splitTomlPath(path: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	const appendCurrent = () => {
		if (current.length > 0) {
			parts.push(decodeTomlPathSegment(current));
		}
		current = "";
	};

	for (let index = 0; index < path.length; index += 1) {
		const character = path[index];
		if (!quote && character === ".") {
			appendCurrent();
			continue;
		}

		current += character;
		if (quote) {
			if (quote === '"' && escaped) {
				escaped = false;
				continue;
			}
			if (quote === '"' && character === "\\") {
				escaped = true;
				continue;
			}
			if (quote === "'" && character === "'" && path[index + 1] === "'") {
				current += path[index + 1];
				index += 1;
				continue;
			}
			if (character === quote) {
				quote = null;
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		}
	}
	appendCurrent();
	return parts;
}

function formatTomlPathSegment(value: string): string {
	return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatTomlPath(parts: string[]): string {
	return parts.map(formatTomlPathSegment).join(".");
}

function formatTomlHeader(header: TomlHeader, parts: string[]): string {
	const brackets = header.kind === "array-table" ? "[[" : "[";
	const closingBrackets = header.kind === "array-table" ? "]]" : "]";
	return `${header.leading}${brackets}${formatTomlPath(parts)}${closingBrackets}${header.trailing}`;
}

function samePath(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((part, index) => part === right[index]);
}

function pathStartsWith(parts: string[], prefix: string[]): boolean {
	return prefix.every((part, index) => parts[index] === part);
}

function providerPath(name: string): string[] {
	return ["providers", name];
}

function modelPath(name: string): string[] {
	return ["models", name];
}

function getTomlHeaders(content: string): TomlHeader[] {
	const lines = splitLines(content);
	const starts: Array<Omit<TomlHeader, "end">> = [];

	for (let index = 0; index < lines.length; index += 1) {
		const header = parseTomlTableHeader(lines[index]);
		if (header) {
			starts.push({ ...header, start: index });
		}
	}

	return starts.map((header, index) => ({
		...header,
		end: starts[index + 1]?.start ?? lines.length,
	}));
}

function getTomlSections(content: string): TomlSection[] {
	return getTomlHeaders(content).filter(
		(header): header is TomlSection => header.kind === "table",
	);
}

function findTomlSection(content: string, parts: string[]): TomlSection | null {
	return getTomlSections(content).find((section) => samePath(section.parts, parts)) ?? null;
}

function findRootEnd(lines: string[]): number {
	for (let index = 0; index < lines.length; index += 1) {
		if (parseTomlTableHeader(lines[index])) {
			return index;
		}
	}
	return lines.length;
}

function isTomlValueComplete(value: string): boolean {
	let quote: '"' | "'" | null = null;
	let multiline = false;
	let escaped = false;
	let squareDepth = 0;
	let curlyDepth = 0;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote) {
			if (quote === '"' && escaped) {
				escaped = false;
				continue;
			}
			if (quote === '"' && character === "\\") {
				escaped = true;
				continue;
			}
			if (
				multiline &&
				value.slice(index, index + 3) === `${quote}${quote}${quote}`
			) {
				quote = null;
				multiline = false;
				index += 2;
				continue;
			}
			if (!multiline && character === quote) {
				quote = null;
			}
			continue;
		}

		if (character === "#") {
			while (index + 1 < value.length && value[index + 1] !== "\n") {
				index += 1;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			multiline = value.slice(index, index + 3) === `${character}${character}${character}`;
			if (multiline) {
				index += 2;
			}
			continue;
		}
		if (character === "[") {
			squareDepth += 1;
		} else if (character === "]") {
			squareDepth = Math.max(0, squareDepth - 1);
		} else if (character === "{") {
			curlyDepth += 1;
		} else if (character === "}") {
			curlyDepth = Math.max(0, curlyDepth - 1);
		}
	}

	return quote === null && squareDepth === 0 && curlyDepth === 0;
}

function parseTomlAssignment(line: string): TomlAssignment | null {
	let index = 0;
	while (index < line.length && /\s/.test(line[index])) {
		index += 1;
	}
	const keyStart = index;
	let key = "";

	if (line[index] === '"') {
		index += 1;
		let escaped = false;
		while (index < line.length) {
			const character = line[index];
			if (escaped) {
				escaped = false;
				index += 1;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				index += 1;
				continue;
			}
			if (character === '"') {
				index += 1;
				break;
			}
			index += 1;
		}
		const keyText = line.slice(keyStart, index);
		if (!keyText.endsWith('"')) {
			return null;
		}
		try {
			key = JSON.parse(keyText) as string;
		} catch {
			return null;
		}
	} else if (line[index] === "'") {
		index += 1;
		let closed = false;
		while (index < line.length) {
			const character = line[index];
			if (character === "'" && line[index + 1] === "'") {
				key += "'";
				index += 2;
				continue;
			}
			if (character === "'") {
				index += 1;
				closed = true;
				break;
			}
			key += character;
			index += 1;
		}
		if (!closed) {
			return null;
		}
	} else {
		while (index < line.length && /[A-Za-z0-9_-]/.test(line[index])) {
			index += 1;
		}
		key = line.slice(keyStart, index);
		if (!key) {
			return null;
		}
	}

	while (index < line.length && /\s/.test(line[index])) {
		index += 1;
	}
	if (line[index] !== "=") {
		return null;
	}
	index += 1;
	while (index < line.length && /\s/.test(line[index])) {
		index += 1;
	}
	return { key, value: line.slice(index), prefix: line.slice(0, index) };
}

function findTomlValueRange(
	lines: string[],
	start: number,
	end: number,
	key: string,
): TomlValueRange | null {
	for (let index = start; index < end; index += 1) {
		const assignment = parseTomlAssignment(lines[index]);
		if (!assignment || assignment.key !== key) {
			continue;
		}
		const valueLines = [assignment.value];
		let rangeEnd = index + 1;
		while (!isTomlValueComplete(valueLines.join("\n")) && rangeEnd < end) {
			valueLines.push(lines[rangeEnd]);
			rangeEnd += 1;
		}
		return {
			start: index,
			end: rangeEnd,
			raw: valueLines.join("\n"),
			prefix: assignment.prefix,
		};
	}
	return null;
}

function findInlineCommentStart(value: string): number {
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote) {
			if (quote === '"' && escaped) {
				escaped = false;
				continue;
			}
			if (quote === '"' && character === "\\") {
				escaped = true;
				continue;
			}
			if (quote === "'" && character === "'" && value[index + 1] === "'") {
				index += 1;
				continue;
			}
			if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "#") {
			return index;
		}
	}
	return -1;
}

function replaceTomlValueRange(lines: string[], range: TomlValueRange, literal: string): void {
	const commentStart = findInlineCommentStart(range.raw);
	const beforeComment = commentStart >= 0 ? range.raw.slice(0, commentStart) : range.raw;
	const trailingWhitespace = beforeComment.match(/\s*$/)?.[0] ?? "";
	const trailing =
		commentStart >= 0 ? `${trailingWhitespace}${range.raw.slice(commentStart)}` : trailingWhitespace;
	lines.splice(range.start, range.end - range.start, `${range.prefix}${literal}${trailing}`);
}

function readTomlValue(raw: string): unknown {
	try {
		const parsed = parse(`value = ${raw}`) as Record<string, unknown>;
		return parsed.value;
	} catch {
		return undefined;
	}
}

function readSectionRaw(content: string, parts: string[], key: string): string | null {
	const section = findTomlSection(content, parts);
	if (!section) {
		return null;
	}
	return findTomlValueRange(splitLines(content), section.start + 1, section.end, key)?.raw ?? null;
}

function readSectionString(
	content: string,
	parts: string[],
	key: string,
	fallback = "",
): string {
	const raw = readSectionRaw(content, parts, key);
	const value = raw === null ? undefined : readTomlValue(raw);
	return typeof value === "string" ? value : fallback;
}

function readSectionStringArray(content: string, parts: string[], key: string): string[] {
	const raw = readSectionRaw(content, parts, key);
	const value = raw === null ? undefined : readTomlValue(raw);
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function readSectionNumber(content: string, parts: string[], key: string): string {
	const raw = readSectionRaw(content, parts, key);
	const value = raw === null ? undefined : readTomlValue(raw);
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function readTopLevelString(content: string, key: string): string {
	const lines = splitLines(content);
	const raw = findTomlValueRange(lines, 0, findRootEnd(lines), key)?.raw;
	const value = raw === undefined ? undefined : readTomlValue(raw);
	return typeof value === "string" ? value : "";
}

function setTomlSectionValue(
	content: string,
	parts: string[],
	key: string,
	literal: string,
): string {
	let nextContent = content;
	let section = findTomlSection(nextContent, parts);
	if (!section) {
		nextContent = appendTomlSection(nextContent, parts, []);
		section = findTomlSection(nextContent, parts);
	}
	if (!section) {
		return nextContent;
	}

	const lines = splitLines(nextContent);
	const range = findTomlValueRange(lines, section.start + 1, section.end, key);
	if (range) {
		replaceTomlValueRange(lines, range, literal);
		return joinLines(lines, nextContent);
	}

	let insertAt = section.end;
	while (insertAt > section.start + 1 && lines[insertAt - 1]?.trim() === "") {
		insertAt -= 1;
	}
	lines.splice(insertAt, 0, `${key} = ${literal}`);
	return joinLines(lines, nextContent);
}

function removeTomlSectionValue(content: string, parts: string[], key: string): string {
	const section = findTomlSection(content, parts);
	if (!section) {
		return content;
	}
	const lines = splitLines(content);
	const range = findTomlValueRange(lines, section.start + 1, section.end, key);
	if (!range) {
		return content;
	}
	lines.splice(range.start, range.end - range.start);
	return joinLines(lines, content);
}

function setTopLevelValue(content: string, key: string, literal: string): string {
	const lines = splitLines(content);
	const rootEnd = findRootEnd(lines);
	const range = findTomlValueRange(lines, 0, rootEnd, key);
	if (range) {
		replaceTomlValueRange(lines, range, literal);
		return joinLines(lines, content);
	}

	const entries = [`${key} = ${literal}`];
	if (rootEnd > 0 && lines[rootEnd - 1]?.trim() !== "") {
		entries.unshift("");
	}
	if (rootEnd < lines.length && lines[rootEnd]?.trim() !== "") {
		entries.push("");
	}
	lines.splice(rootEnd, 0, ...entries);
	return joinLines(lines, content);
}

function appendTomlSection(
	content: string,
	parts: string[],
	entries: Array<[string, string]>,
): string {
	const lines = splitLines(content);
	const nextLines = [
		...(lines.length > 0 && lines[lines.length - 1]?.trim() !== "" ? [""] : []),
		`[${formatTomlPath(parts)}]`,
		...entries.map(([key, literal]) => `${key} = ${literal}`),
	];
	return joinLines([...lines, ...nextLines], content);
}

function renameTomlSectionPrefix(
	content: string,
	oldPrefix: string[],
	newPrefix: string[],
): string {
	const lines = splitLines(content);
	for (const section of getTomlSections(content)) {
		if (!pathStartsWith(section.parts, oldPrefix)) {
			continue;
		}
		const renamed = [...newPrefix, ...section.parts.slice(oldPrefix.length)];
		lines[section.start] = formatTomlHeader(section, renamed);
	}
	return joinLines(lines, content);
}

function removeTomlSectionPrefix(content: string, prefix: string[]): string {
	const lines = splitLines(content);
	const ranges = getTomlSections(content)
		.filter((section) => pathStartsWith(section.parts, prefix))
		.map((section) => {
			let start = section.start;
			let end = section.end;
			if (start > 0 && lines[start - 1]?.trim() === "") {
				start -= 1;
			} else if (end < lines.length && lines[end]?.trim() === "") {
				end += 1;
			}
			return { start, end };
		})
		.sort((left, right) => left.start - right.start);
	const mergedRanges: Array<{ start: number; end: number }> = [];

	for (const range of ranges) {
		const previous = mergedRanges.at(-1);
		if (previous && range.start <= previous.end) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			mergedRanges.push(range);
		}
	}
	for (let index = mergedRanges.length - 1; index >= 0; index -= 1) {
		const range = mergedRanges[index];
		lines.splice(range.start, range.end - range.start);
	}
	return joinLines(lines, content);
}

function formatTomlString(value: string): string {
	return JSON.stringify(value);
}

function formatTomlStringArray(values: string[]): string {
	return `[${values.map(formatTomlString).join(", ")}]`;
}

function getUniqueName(existingNames: string[], baseName: string): string {
	if (!existingNames.includes(baseName)) {
		return baseName;
	}
	for (let index = 2; index < 1000; index += 1) {
		const candidate = `${baseName}-${index}`;
		if (!existingNames.includes(candidate)) {
			return candidate;
		}
	}
	return `${baseName}-${Date.now()}`;
}

function errorResult(content: string, error: string): TomlMutationResult {
	return { content, error };
}

function parseTomlError(content: string): string | null {
	try {
		parse(content);
		return null;
	} catch (error) {
		return `TOML 格式错误：${error instanceof Error ? error.message : String(error)}`;
	}
}

function controlledKeysForPath(parts: string[]): string[] {
	if (samePath(parts, ["secondary_model"])) {
		return ["model"];
	}
	if (parts[0] === "providers" && parts.length === 2) {
		return ["type", "base_url", "api_key", "env", "custom_headers"];
	}
	if (parts[0] === "models" && parts.length === 2) {
		return [
			"provider",
			"model",
			"display_name",
			"max_context_size",
			"capabilities",
			"support_efforts",
			"default_effort",
		];
	}
	return [];
}

function formatUnsupportedPath(parts: string[]): string {
	return `[${formatTomlPath(parts)}]`;
}

export function getProviderModelTomlCompatibilityError(content: string): string | null {
	const syntaxError = parseTomlError(content);
	if (syntaxError) {
		return syntaxError;
	}

	const headers = getTomlHeaders(content);
	const arrayTable = headers.find(
		(header) =>
			header.kind === "array-table" &&
			(header.parts[0] === "providers" || header.parts[0] === "models"),
	);
	if (arrayTable) {
		return `结构化 Provider / 模型编辑不支持 ${formatUnsupportedPath(arrayTable.parts)} 下的 array-of-tables；请转用高级 config.toml 编辑器。`;
	}

	const aggregateTable = headers.find(
		(header) =>
			header.kind === "table" &&
			(header.parts.length === 1 && (header.parts[0] === "providers" || header.parts[0] === "models")),
	);
	if (aggregateTable) {
		return `结构化 Provider / 模型编辑不支持 ${formatUnsupportedPath(aggregateTable.parts)} 聚合表；请转用高级 config.toml 编辑器。`;
	}

	const lines = splitLines(content);
	const rootEnd = findRootEnd(lines);
	for (const key of ["providers", "models"]) {
		if (findTomlValueRange(lines, 0, rootEnd, key)) {
			return `结构化 Provider / 模型编辑不支持顶层 ${key} 赋值结构；请转用高级 config.toml 编辑器。`;
		}
	}

	for (const section of getTomlSections(content)) {
		for (const key of controlledKeysForPath(section.parts)) {
			const range = findTomlValueRange(lines, section.start + 1, section.end, key);
			if (range && range.end > range.start + 1) {
				return `结构化 Provider / 模型编辑不支持 ${formatUnsupportedPath(section.parts)} 的 ${key} 多行 TOML 值；请转用高级 config.toml 编辑器。`;
			}
		}
	}
	return null;
}

function requireEditableProviderModelToml(content: string): TomlMutationResult | null {
	const compatibilityError = getProviderModelTomlCompatibilityError(content);
	return compatibilityError ? errorResult(content, compatibilityError) : null;
}

function updateModelReferences(content: string, from: string, to: string): string {
	let nextContent = content;
	if (readTopLevelString(nextContent, "default_model") === from) {
		nextContent = setTopLevelValue(nextContent, "default_model", formatTomlString(to));
	}
	if (readSectionString(nextContent, ["secondary_model"], "model") === from) {
		nextContent = setTomlSectionValue(
			nextContent,
			["secondary_model"],
			"model",
			formatTomlString(to),
		);
	}
	return nextContent;
}

export function readProviderModelConfig(content: string): ProviderModelConfig {
	const sections = getTomlSections(content);
	const providers = sections
		.filter((section) => section.parts[0] === "providers" && section.parts.length === 2)
		.map((section) => {
			const name = section.parts[1];
			const parts = providerPath(name);
			return {
				name,
				type: readSectionString(content, parts, "type"),
				baseUrl: readSectionString(content, parts, "base_url"),
				apiKey: readSectionString(content, parts, "api_key"),
				envRaw: readSectionRaw(content, parts, "env") ?? "",
				customHeadersRaw: readSectionRaw(content, parts, "custom_headers") ?? "",
				hasNestedSettings: sections.some(
					(nested) =>
						nested.parts.length > 2 &&
						nested.parts[0] === "providers" &&
						nested.parts[1] === name,
				),
			};
		});
	const models = sections
		.filter((section) => section.parts[0] === "models" && section.parts.length === 2)
		.map((section) => {
			const name = section.parts[1];
			const parts = modelPath(name);
			return {
				name,
				provider: readSectionString(content, parts, "provider"),
				protocol: readSectionString(content, parts, "protocol"),
				upstreamModel: readSectionString(content, parts, "model"),
				displayName: readSectionString(content, parts, "display_name"),
				maxContextSize: readSectionNumber(content, parts, "max_context_size"),
				capabilities: readSectionStringArray(content, parts, "capabilities"),
				supportEfforts: readSectionStringArray(content, parts, "support_efforts"),
				defaultEffort: readSectionString(content, parts, "default_effort"),
			};
		});

	return {
		providers,
		models,
		defaultModel: readTopLevelString(content, "default_model"),
	};
}

export function isBuiltInKimiProvider(
	provider: Pick<ProviderEditorConfig, "name" | "type">,
): boolean {
	return provider.name === "kimi" && provider.type === "kimi";
}

export function validateProviderModelToml(content: string): string | null {
	return getProviderModelTomlCompatibilityError(content);
}

export function addProvider(content: string): TomlMutationResult {
	const guard = requireEditableProviderModelToml(content);
	if (guard) {
		return guard;
	}
	const config = readProviderModelConfig(content);
	const providerName = getUniqueName(
		config.providers.map((provider) => provider.name),
		"custom-provider",
	);
	return {
		content: appendTomlSection(content, providerPath(providerName), [
			["type", formatTomlString("openai_responses")],
			["base_url", formatTomlString("")],
			["api_key", formatTomlString("")],
		]),
		providerName,
	};
}

export function addModel(content: string, selectedProviderName: string): TomlMutationResult {
	const guard = requireEditableProviderModelToml(content);
	if (guard) {
		return guard;
	}
	let nextContent = content;
	let providerName = selectedProviderName.trim();
	let config = readProviderModelConfig(nextContent);

	if (!config.providers.some((provider) => provider.name === providerName)) {
		providerName = config.providers[0]?.name ?? "";
	}
	if (!providerName) {
		const providerResult = addProvider(nextContent);
		if (providerResult.error) {
			return providerResult;
		}
		nextContent = providerResult.content;
		providerName = providerResult.providerName ?? "custom-provider";
		config = readProviderModelConfig(nextContent);
	}

	const modelName = getUniqueName(
		config.models.map((model) => model.name),
		`${providerName}/model-name`,
	);
	nextContent = appendTomlSection(nextContent, modelPath(modelName), [
		["provider", formatTomlString(providerName)],
		["model", formatTomlString("model-name")],
		["max_context_size", "200000"],
		["capabilities", formatTomlStringArray(["thinking"])],
	]);

	const defaultModel = readProviderModelConfig(nextContent).defaultModel;
	if (!defaultModel) {
		nextContent = setTopLevelValue(nextContent, "default_model", formatTomlString(modelName));
	}

	return { content: nextContent, providerName, modelName };
}

export function renameProvider(
	content: string,
	currentName: string,
	nextName: string,
): TomlMutationResult {
	const guard = requireEditableProviderModelToml(content);
	if (guard) {
		return guard;
	}
	const normalizedName = nextName.trim();
	const config = readProviderModelConfig(content);
	const provider = config.providers.find((candidate) => candidate.name === currentName);
	if (!provider) {
		return errorResult(content, "找不到要重命名的 Provider。");
	}
	if (isBuiltInKimiProvider(provider)) {
		return errorResult(content, "Kimi Code 内置 Provider 不允许重命名。");
	}
	if (!normalizedName) {
		return errorResult(content, "Provider 名称不能为空。");
	}
	if (normalizedName === currentName) {
		return { content, providerName: currentName };
	}
	if (config.providers.some((candidate) => candidate.name === normalizedName)) {
		return errorResult(content, "Provider 名称已存在。");
	}

	let nextContent = renameTomlSectionPrefix(
		content,
		providerPath(currentName),
		providerPath(normalizedName),
	);
	for (const model of readProviderModelConfig(nextContent).models) {
		if (model.provider === currentName) {
			nextContent = setTomlSectionValue(
				nextContent,
				modelPath(model.name),
				"provider",
				formatTomlString(normalizedName),
			);
		}
	}
	return { content: nextContent, providerName: normalizedName };
}

export function removeProvider(content: string, providerName: string): TomlMutationResult {
	const guard = requireEditableProviderModelToml(content);
	if (guard) {
		return guard;
	}
	const config = readProviderModelConfig(content);
	const provider = config.providers.find((candidate) => candidate.name === providerName);
	if (!provider) {
		return errorResult(content, "找不到要删除的 Provider。");
	}
	if (isBuiltInKimiProvider(provider)) {
		return errorResult(content, "Kimi Code 内置 Provider 不允许删除。");
	}
	const removedModels = config.models.filter((model) => model.provider === providerName);
	const remainingModels = config.models.filter((model) => model.provider !== providerName);
	const currentDefault = config.defaultModel;
	const secondaryModel = readSectionString(content, ["secondary_model"], "model");
	const removesDefault = removedModels.some((model) => model.name === currentDefault);
	const removesSecondary = removedModels.some((model) => model.name === secondaryModel);
	if ((removesDefault || removesSecondary) && remainingModels.length === 0) {
		return errorResult(content, "无法删除唯一的默认模型；请先添加另一个模型。");
	}

	let nextContent = removeTomlSectionPrefix(content, providerPath(providerName));
	for (const model of removedModels) {
		nextContent = removeTomlSectionPrefix(nextContent, modelPath(model.name));
	}
	const fallbackModelName = remainingModels[0]?.name;
	if (fallbackModelName && (removesDefault || removesSecondary)) {
		nextContent = updateModelReferences(
			nextContent,
			removesDefault ? currentDefault : secondaryModel,
			fallbackModelName,
		);
		if (removesDefault && removesSecondary && currentDefault !== secondaryModel) {
			nextContent = updateModelReferences(nextContent, secondaryModel, fallbackModelName);
		}
	}
	return { content: nextContent, fallbackModelName };
}

export function renameModel(
	content: string,
	currentName: string,
	nextName: string,
): TomlMutationResult {
	const guard = requireEditableProviderModelToml(content);
	if (guard) {
		return guard;
	}
	const normalizedName = nextName.trim();
	const config = readProviderModelConfig(content);
	if (!normalizedName) {
		return errorResult(content, "模型别名不能为空。");
	}
	if (normalizedName === currentName) {
		return { content, modelName: currentName };
	}
	if (!config.models.some((model) => model.name === currentName)) {
		return errorResult(content, "找不到要重命名的模型。");
	}
	if (config.models.some((model) => model.name === normalizedName)) {
		return errorResult(content, "模型别名已存在。");
	}

	let nextContent = renameTomlSectionPrefix(content, modelPath(currentName), modelPath(normalizedName));
	nextContent = updateModelReferences(nextContent, currentName, normalizedName);
	return { content: nextContent, modelName: normalizedName };
}

export function removeModel(content: string, modelName: string): TomlMutationResult {
	const guard = requireEditableProviderModelToml(content);
	if (guard) {
		return guard;
	}
	const config = readProviderModelConfig(content);
	if (!config.models.some((model) => model.name === modelName)) {
		return errorResult(content, "找不到要删除的模型。");
	}
	if (config.models.length <= 1) {
		return errorResult(content, "至少保留一个模型，才能维持可用的默认模型。");
	}

	const fallbackModelName = config.models.find((model) => model.name !== modelName)?.name;
	if (!fallbackModelName) {
		return errorResult(content, "没有可用于默认模型的回退项。");
	}
	let nextContent = removeTomlSectionPrefix(content, modelPath(modelName));
	nextContent = updateModelReferences(nextContent, modelName, fallbackModelName);
	return { content: nextContent, fallbackModelName };
}

function setEditableValue(content: string, update: (current: string) => string): TomlMutationResult {
	const guard = requireEditableProviderModelToml(content);
	return guard ?? { content: update(content) };
}

export function setProviderStringValue(
	content: string,
	providerName: string,
	key: "type" | "base_url" | "api_key",
	value: string,
): TomlMutationResult {
	return setEditableValue(content, (current) =>
		setTomlSectionValue(current, providerPath(providerName), key, formatTomlString(value)),
	);
}

export function setProviderRawValue(
	content: string,
	providerName: string,
	key: "env" | "custom_headers",
	value: string,
): TomlMutationResult {
	return setEditableValue(content, (current) =>
		value.trim()
			? setTomlSectionValue(current, providerPath(providerName), key, value)
			: removeTomlSectionValue(current, providerPath(providerName), key),
	);
}

export function setModelStringValue(
	content: string,
	modelName: string,
	key: "provider" | "model" | "display_name",
	value: string,
): TomlMutationResult {
	return setEditableValue(content, (current) =>
		setTomlSectionValue(current, modelPath(modelName), key, formatTomlString(value)),
	);
}

export function setModelOptionalStringValue(
	content: string,
	modelName: string,
	key: "display_name" | "default_effort",
	value: string,
): TomlMutationResult {
	return setEditableValue(content, (current) =>
		value
			? setTomlSectionValue(current, modelPath(modelName), key, formatTomlString(value))
			: removeTomlSectionValue(current, modelPath(modelName), key),
	);
}

export function setModelProtocol(
	content: string,
	modelName: string,
	value: string,
): TomlMutationResult {
	return setEditableValue(content, (current) =>
		value
			? setTomlSectionValue(current, modelPath(modelName), "protocol", formatTomlString(value))
			: removeTomlSectionValue(current, modelPath(modelName), "protocol"),
	);
}

export function setModelMaxContextSize(
	content: string,
	modelName: string,
	value: string,
): TomlMutationResult {
	return setEditableValue(content, (current) =>
		value.trim()
			? setTomlSectionValue(current, modelPath(modelName), "max_context_size", value)
			: removeTomlSectionValue(current, modelPath(modelName), "max_context_size"),
	);
}

export function setModelCapabilities(
	content: string,
	modelName: string,
	capabilities: string[],
): TomlMutationResult {
	return setEditableValue(content, (current) =>
		setTomlSectionValue(
			current,
			modelPath(modelName),
			"capabilities",
			formatTomlStringArray(capabilities),
		),
	);
}

export function setModelSupportEfforts(
	content: string,
	modelName: string,
	efforts: string[],
): TomlMutationResult {
	const normalizedEfforts = [...new Set(efforts.map((effort) => effort.trim()).filter(Boolean))];
	return setEditableValue(content, (current) =>
		normalizedEfforts.length > 0
			? setTomlSectionValue(
					current,
					modelPath(modelName),
					"support_efforts",
					formatTomlStringArray(normalizedEfforts),
				)
			: removeTomlSectionValue(current, modelPath(modelName), "support_efforts"),
	);
}

export function setDefaultModel(content: string, modelName: string): TomlMutationResult {
	return setEditableValue(content, (current) =>
		setTopLevelValue(current, "default_model", formatTomlString(modelName)),
	);
}
