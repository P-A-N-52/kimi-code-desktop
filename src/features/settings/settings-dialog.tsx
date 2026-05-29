import {
  BookOpen,
  Check,
  Cpu,
  Eye,
  EyeOff,
  FileCode2,
  Globe2,
  LogIn,
  Plus,
  RefreshCcw,
  Save,
  Server,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { useI18n, type UiLanguage } from "@/lib/i18n";
import { ModelCapability, type ConfigModel } from "@/lib/api/models";
import { isTauri, openKimiLogin } from "@/lib/tauri-api";
import {
  getConfigTomlFile,
  getMcpConfigFile,
  updateConfigTomlFile,
  updateMcpConfigFile,
} from "@/lib/settings-api";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type SettingsSection = "model" | "general" | "mcp" | "skills" | "advanced";

const PROVIDER_TYPES = ["kimi", "openai_legacy", "anthropic", "gemini", "vertexai"];
const KIMI_PROVIDER_TYPE = "kimi";
const BUILT_IN_KIMI_PROVIDER_NAME = "kimi";
const MODEL_CAPABILITY_OPTIONS = [
  "thinking",
  "always_thinking",
  "image_in",
  "video_in",
];

type TomlSection = {
  path: string;
  parts: string[];
  start: number;
  end: number;
};

type ProviderEditorConfig = {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  envRaw: string;
  customHeadersRaw: string;
  hasNestedSettings: boolean;
};

type ModelEditorConfig = {
  key: string;
  provider: string;
  model: string;
  maxContextSizeRaw: string;
  capabilities: string[];
  displayName: string;
};

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof Cpu;
}> = [
  { id: "model", label: "Model", icon: Cpu },
  { id: "general", label: "General", icon: Globe2 },
  { id: "mcp", label: "MCP", icon: Server },
  { id: "skills", label: "Skills", icon: BookOpen },
  { id: "advanced", label: "Config", icon: FileCode2 },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitLines(content: string): string[] {
  return content.length > 0 ? content.split(/\r?\n/) : [];
}

function findRootTableIndex(lines: string[]): number {
  const index = lines.findIndex((line) => line.trimStart().startsWith("["));
  return index === -1 ? lines.length : index;
}

function setTopLevelValue(content: string, key: string, literal: string): string {
  const lines = splitLines(content);
  const rootEnd = findRootTableIndex(lines);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);

  for (let index = 0; index < rootEnd; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${literal}`;
      return lines.join("\n");
    }
  }

  const insertAt = rootEnd;
  const insertLines = [`${key} = ${literal}`];
  if (insertAt > 0 && lines[insertAt - 1]?.trim() !== "") {
    insertLines.unshift("");
  }
  if (insertAt < lines.length && lines[insertAt]?.trim() !== "") {
    insertLines.push("");
  }

  lines.splice(insertAt, 0, ...insertLines);
  return lines.join("\n");
}

function readTopLevelRaw(content: string, key: string): string | null {
  const lines = splitLines(content);
  const rootEnd = findRootTableIndex(lines);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`);

  for (let index = 0; index < rootEnd; index += 1) {
    const match = lines[index].match(keyPattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function stripInlineTomlComment(value: string): string {
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"" || char === "'") {
      if (!inString) {
        inString = true;
        quote = char;
      } else if (quote === char) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (!inString && char === "#") {
      return value.slice(0, index).trim();
    }
  }

  return value.trim();
}

function parseTomlTableHeader(line: string): string | null {
  const match = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
  return match ? match[1].trim() : null;
}

function splitTomlPath(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];

    if (!inString && char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }

    current += char;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString && quote === "\"" && char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"" || char === "'") {
      if (!inString) {
        inString = true;
        quote = char;
      } else if (quote === char) {
        inString = false;
        quote = "";
      }
    }
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments.map(decodeTomlPathSegment);
}

function decodeTomlPathSegment(segment: string): string {
  const trimmed = segment.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
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

function formatTomlPathSegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatTomlSectionPath(parts: string[]): string {
  return parts.map(formatTomlPathSegment).join(".");
}

function pathsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function pathStartsWith(parts: string[], prefix: string[]): boolean {
  return prefix.every((part, index) => parts[index] === part);
}

function providerSectionParts(name: string): string[] {
  return ["providers", name];
}

function modelSectionParts(key: string): string[] {
  return ["models", key];
}

function getTomlSections(content: string): TomlSection[] {
  const lines = splitLines(content);
  const starts: Array<{ index: number; path: string; parts: string[] }> = [];

  lines.forEach((line, index) => {
    const path = parseTomlTableHeader(line);
    if (path) {
      starts.push({ index, path, parts: splitTomlPath(path) });
    }
  });

  return starts.map((section, index) => ({
    path: section.path,
    parts: section.parts,
    start: section.index,
    end: starts[index + 1]?.index ?? lines.length,
  }));
}

function findTomlSection(content: string, parts: string[]): TomlSection | null {
  return getTomlSections(content).find((section) => pathsEqual(section.parts, parts)) ?? null;
}

function readSectionRaw(
  content: string,
  parts: string[],
  key: string,
): string | null {
  const lines = splitLines(content);
  const section = findTomlSection(content, parts);
  if (!section) {
    return null;
  }
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`);

  for (let index = section.start + 1; index < section.end; index += 1) {
    const match = lines[index].match(keyPattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function readSectionString(
  content: string,
  parts: string[],
  key: string,
  fallback = "",
): string {
  const raw = readSectionRaw(content, parts, key);
  if (raw === null) {
    return fallback;
  }
  const trimmed = stripInlineTomlComment(raw);
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, "") || fallback;
  }
}

function readSectionStringArray(
  content: string,
  parts: string[],
  key: string,
): string[] {
  const raw = readSectionRaw(content, parts, key);
  if (raw === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(stripInlineTomlComment(raw)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function ensureTomlSection(content: string, parts: string[]): string {
  if (findTomlSection(content, parts)) {
    return content;
  }
  return appendTomlSection(content, parts, []);
}

function appendTomlSection(
  content: string,
  parts: string[],
  entries: Array<[string, string]>,
): string {
  const lines = splitLines(content);
  const needsLeadingBlank = lines.length > 0 && lines[lines.length - 1]?.trim() !== "";
  const nextLines = [
    ...(needsLeadingBlank ? [""] : []),
    `[${formatTomlSectionPath(parts)}]`,
    ...entries.map(([key, literal]) => `${key} = ${literal}`),
  ];
  return [...lines, ...nextLines].join("\n");
}

function setSectionValue(
  content: string,
  parts: string[],
  key: string,
  literal: string,
): string {
  const ensured = ensureTomlSection(content, parts);
  const lines = splitLines(ensured);
  const section = findTomlSection(ensured, parts);
  if (!section) {
    return ensured;
  }
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);

  for (let index = section.start + 1; index < section.end; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${literal}`;
      return lines.join("\n");
    }
  }

  let insertAt = section.end;
  while (insertAt > section.start + 1 && lines[insertAt - 1]?.trim() === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, `${key} = ${literal}`);
  return lines.join("\n");
}

function removeSectionValue(content: string, parts: string[], key: string): string {
  const lines = splitLines(content);
  const section = findTomlSection(content, parts);
  if (!section) {
    return content;
  }
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const index = lines.findIndex(
    (line, lineIndex) =>
      lineIndex > section.start && lineIndex < section.end && keyPattern.test(line),
  );
  if (index === -1) {
    return content;
  }
  lines.splice(index, 1);
  return lines.join("\n");
}

function renameSectionPrefix(
  content: string,
  oldPrefix: string[],
  newPrefix: string[],
): string {
  const lines = splitLines(content);
  getTomlSections(content).forEach((section) => {
    if (!pathStartsWith(section.parts, oldPrefix)) {
      return;
    }
    const renamedParts = [...newPrefix, ...section.parts.slice(oldPrefix.length)];
    lines[section.start] = `[${formatTomlSectionPath(renamedParts)}]`;
  });
  return lines.join("\n");
}

function removeSectionPrefix(content: string, prefix: string[]): string {
  const lines = splitLines(content);
  const ranges = getTomlSections(content)
    .filter((section) => pathStartsWith(section.parts, prefix))
    .sort((left, right) => right.start - left.start);

  ranges.forEach((section) => {
    let start = section.start;
    let end = section.end;
    if (start > 0 && lines[start - 1]?.trim() === "") {
      start -= 1;
    } else if (end < lines.length && lines[end]?.trim() === "") {
      end += 1;
    }
    lines.splice(start, end - start);
  });

  return lines.join("\n");
}

function parseProviderConfigs(content: string): ProviderEditorConfig[] {
  return getTomlSections(content)
    .filter((section) => section.parts[0] === "providers" && section.parts.length === 2)
    .map((section) => {
      const parts = providerSectionParts(section.parts[1]);
      return {
        name: section.parts[1],
        type: readSectionString(content, parts, "type"),
        baseUrl: readSectionString(content, parts, "base_url"),
        apiKey: readSectionString(content, parts, "api_key"),
        envRaw: readSectionRaw(content, parts, "env") ?? "",
        customHeadersRaw: readSectionRaw(content, parts, "custom_headers") ?? "",
        hasNestedSettings: getTomlSections(content).some(
          (nested) =>
            nested.parts.length > 2 &&
            nested.parts[0] === "providers" &&
            nested.parts[1] === section.parts[1],
        ),
      };
    });
}

function parseModelConfigs(content: string): ModelEditorConfig[] {
  return getTomlSections(content)
    .filter((section) => section.parts[0] === "models" && section.parts.length === 2)
    .map((section) => {
      const parts = modelSectionParts(section.parts[1]);
      return {
        key: section.parts[1],
        provider: readSectionString(content, parts, "provider"),
        model: readSectionString(content, parts, "model"),
        maxContextSizeRaw: readSectionRaw(content, parts, "max_context_size") ?? "",
        capabilities: readSectionStringArray(content, parts, "capabilities"),
        displayName: readSectionString(content, parts, "display_name"),
      };
    });
}

function isKimiProvider(provider: ProviderEditorConfig | null | undefined): boolean {
  return provider?.type === KIMI_PROVIDER_TYPE;
}

function isBuiltInKimiProvider(
  provider: ProviderEditorConfig | null | undefined,
): boolean {
  return isKimiProvider(provider) && provider?.name === BUILT_IN_KIMI_PROVIDER_NAME;
}

function getKimiCredentialStatus(provider: ProviderEditorConfig): string {
  if (provider.apiKey.trim()) {
    return "API key override";
  }

  if (provider.envRaw.trim()) {
    return "config.toml env";
  }

  return "Runtime env / CLI login";
}

function getUniqueName(existing: string[], baseName: string): string {
  if (!existing.includes(baseName)) {
    return baseName;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!existing.includes(candidate)) {
      return candidate;
    }
  }
  return `${baseName}-${Date.now()}`;
}

function replaceModelProviderReferences(
  content: string,
  oldProviderName: string,
  newProviderName: string,
): string {
  return parseModelConfigs(content).reduce((nextContent, model) => {
    if (model.provider !== oldProviderName) {
      return nextContent;
    }
    return setSectionValue(
      nextContent,
      modelSectionParts(model.key),
      "provider",
      formatTomlString(newProviderName),
    );
  }, content);
}

function readTopLevelBoolean(
  content: string,
  key: string,
  fallback: boolean,
): boolean {
  const raw = readTopLevelRaw(content, key);
  if (raw === null) {
    return fallback;
  }
  const normalized = stripInlineTomlComment(raw).toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}

function readTopLevelString(
  content: string,
  key: string,
  fallback: string,
): string {
  const raw = readTopLevelRaw(content, key);
  if (raw === null) {
    return fallback;
  }
  const trimmed = stripInlineTomlComment(raw);
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, "") || fallback;
  }
}

function readTopLevelStringArray(content: string, key: string): string[] {
  const raw = readTopLevelRaw(content, key);
  if (raw === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(stripInlineTomlComment(raw)) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlBoolean(value: boolean): string {
  return value ? "true" : "false";
}

function formatTomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function getModelThinkingMode(model: ConfigModel | null): "enabled" | "forced" | "disabled" {
  if (!model?.capabilities) {
    return "disabled";
  }
  if (model.capabilities.has(ModelCapability.AlwaysThinking)) {
    return "forced";
  }
  if (model.capabilities.has(ModelCapability.Thinking)) {
    return "enabled";
  }
  return "disabled";
}

function normalizeMcpJson(content: string): string {
  return JSON.stringify(JSON.parse(content), null, 2) + "\n";
}

export function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps): ReactElement {
  const {
    config,
    error: globalConfigError,
    isLoading: isGlobalConfigLoading,
    isUpdating: isGlobalConfigUpdating,
    refresh: refreshGlobalConfig,
    update: updateGlobalConfig,
  } = useGlobalConfig();
  const { theme, setTheme } = useTheme();
  const { uiLanguage, setUiLanguage } = useI18n();

  const [activeSection, setActiveSection] = useState<SettingsSection>("model");
  const [configToml, setConfigToml] = useState("");
  const [originalConfigToml, setOriginalConfigToml] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [mcpJson, setMcpJson] = useState("");
  const [originalMcpJson, setOriginalMcpJson] = useState("");
  const [mcpPath, setMcpPath] = useState("");
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isSavingMcp, setIsSavingMcp] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedProviderName, setSelectedProviderName] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [providerNameDraft, setProviderNameDraft] = useState("");
  const [modelKeyDraft, setModelKeyDraft] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isOpeningKimiLogin, setIsOpeningKimiLogin] = useState(false);

  const configDirty = configToml !== originalConfigToml;
  const mcpDirty = mcpJson !== originalMcpJson;

  const currentModel = useMemo(() => {
    if (!config) {
      return null;
    }
    return config.models.find((model) => model.name === config.defaultModel) ?? null;
  }, [config]);

  const providerConfigs = useMemo(
    () => parseProviderConfigs(configToml),
    [configToml],
  );

  const modelConfigs = useMemo(
    () => parseModelConfigs(configToml),
    [configToml],
  );

  const providerModelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    modelConfigs.forEach((model) => {
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    });
    return counts;
  }, [modelConfigs]);

  const selectedProviderModelConfigs = useMemo(() => {
    if (!selectedProviderName) {
      return modelConfigs;
    }
    return modelConfigs.filter(
      (model) => model.provider === selectedProviderName,
    );
  }, [modelConfigs, selectedProviderName]);

  const selectedProvider = useMemo(
    () =>
      providerConfigs.find((provider) => provider.name === selectedProviderName) ??
      null,
    [providerConfigs, selectedProviderName],
  );
  const selectedProviderIsKimi = isKimiProvider(selectedProvider);
  const selectedProviderIsBuiltInKimi = isBuiltInKimiProvider(selectedProvider);
  const selectedProviderCredentialStatus =
    selectedProviderIsKimi && selectedProvider
      ? getKimiCredentialStatus(selectedProvider)
      : "";

  const selectedModelConfig = useMemo(
    () => modelConfigs.find((model) => model.key === selectedModelKey) ?? null,
    [modelConfigs, selectedModelKey],
  );

  const providerTypeOptions = useMemo(() => {
    const currentType = selectedProvider?.type;
    return currentType && !PROVIDER_TYPES.includes(currentType)
      ? [...PROVIDER_TYPES, currentType]
      : PROVIDER_TYPES;
  }, [selectedProvider]);

  const thinkingMode = useMemo(
    () => getModelThinkingMode(currentModel),
    [currentModel],
  );

  const extraSkillDirs = useMemo(
    () => readTopLevelStringArray(configToml, "extra_skill_dirs"),
    [configToml],
  );

  const cliTheme = useMemo(
    () => readTopLevelString(configToml, "theme", theme),
    [configToml, theme],
  );

  const mergeAllSkills = useMemo(
    () => readTopLevelBoolean(configToml, "merge_all_available_skills", false),
    [configToml],
  );

  const defaultYolo = useMemo(
    () => readTopLevelBoolean(configToml, "default_yolo", false),
    [configToml],
  );

  const defaultPlanMode = useMemo(
    () => readTopLevelBoolean(configToml, "default_plan_mode", false),
    [configToml],
  );

  const telemetry = useMemo(
    () => readTopLevelBoolean(configToml, "telemetry", true),
    [configToml],
  );

  const showThinkingStream = useMemo(
    () => readTopLevelBoolean(configToml, "show_thinking_stream", true),
    [configToml],
  );

  const loadConfigFiles = useCallback(async () => {
    setIsLoadingFiles(true);
    setLoadError(null);
    try {
      const [tomlFile, mcpFile] = await Promise.all([
        getConfigTomlFile(),
        getMcpConfigFile(),
      ]);
      setConfigToml(tomlFile.content);
      setOriginalConfigToml(tomlFile.content);
      setConfigPath(tomlFile.path);
      setMcpJson(mcpFile.content);
      setOriginalMcpJson(mcpFile.content);
      setMcpPath(mcpFile.path);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load settings";
      setLoadError(message);
      toast.error("Failed to load settings", { description: message });
    } finally {
      setIsLoadingFiles(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    loadConfigFiles();
    refreshGlobalConfig();
  }, [loadConfigFiles, open, refreshGlobalConfig]);

  useEffect(() => {
    if (providerConfigs.length === 0) {
      setSelectedProviderName("");
      return;
    }
    if (!providerConfigs.some((provider) => provider.name === selectedProviderName)) {
      setSelectedProviderName(providerConfigs[0].name);
    }
  }, [providerConfigs, selectedProviderName]);

  useEffect(() => {
    setProviderNameDraft(selectedProviderName);
  }, [selectedProviderName]);

  useEffect(() => {
    if (selectedProviderModelConfigs.length === 0) {
      setSelectedModelKey("");
      return;
    }
    if (
      !selectedProviderModelConfigs.some((model) => model.key === selectedModelKey)
    ) {
      const defaultModelKey = readTopLevelString(
        configToml,
        "default_model",
        config?.defaultModel ?? "",
      );
      const defaultModel =
        selectedProviderModelConfigs.find((model) => model.key === defaultModelKey) ??
        selectedProviderModelConfigs[0];
      setSelectedModelKey(defaultModel.key);
    }
  }, [
    config?.defaultModel,
    configToml,
    selectedModelKey,
    selectedProviderModelConfigs,
  ]);

  useEffect(() => {
    setModelKeyDraft(selectedModelKey);
  }, [selectedModelKey]);

  const updateConfigTomlKey = useCallback((key: string, literal: string) => {
    setConfigToml((previous) => setTopLevelValue(previous, key, literal));
  }, []);

  const updateConfigTomlKeyInBothCopies = useCallback(
    (key: string, literal: string) => {
      setConfigToml((previous) => setTopLevelValue(previous, key, literal));
      setOriginalConfigToml((previous) => setTopLevelValue(previous, key, literal));
    },
    [],
  );

  const updateSelectedProviderValue = useCallback(
    (key: string, literal: string) => {
      if (!selectedProviderName) {
        return;
      }
      setConfigToml((previous) =>
        setSectionValue(previous, providerSectionParts(selectedProviderName), key, literal),
      );
    },
    [selectedProviderName],
  );

  const updateSelectedProviderRawValue = useCallback(
    (key: string, rawValue: string) => {
      if (!selectedProviderName) {
        return;
      }
      const parts = providerSectionParts(selectedProviderName);
      setConfigToml((previous) =>
        rawValue.trim()
          ? setSectionValue(previous, parts, key, rawValue)
          : removeSectionValue(previous, parts, key),
      );
    },
    [selectedProviderName],
  );

  const updateSelectedModelValue = useCallback(
    (key: string, literal: string) => {
      if (!selectedModelKey) {
        return;
      }
      setConfigToml((previous) =>
        setSectionValue(previous, modelSectionParts(selectedModelKey), key, literal),
      );
    },
    [selectedModelKey],
  );

  const updateSelectedModelRawValue = useCallback(
    (key: string, rawValue: string) => {
      if (!selectedModelKey) {
        return;
      }
      const parts = modelSectionParts(selectedModelKey);
      setConfigToml((previous) =>
        rawValue.trim()
          ? setSectionValue(previous, parts, key, rawValue.trim())
          : removeSectionValue(previous, parts, key),
      );
    },
    [selectedModelKey],
  );

  const handleSelectedModelProviderChange = useCallback(
    (providerName: string) => {
      updateSelectedModelValue("provider", formatTomlString(providerName));
      setSelectedProviderName(providerName);
    },
    [updateSelectedModelValue],
  );

  const commitProviderName = useCallback(() => {
    if (!selectedProviderName) {
      return;
    }
    const nextName = providerNameDraft.trim();
    if (!nextName || nextName === selectedProviderName) {
      setProviderNameDraft(selectedProviderName);
      return;
    }
    if (providerConfigs.some((provider) => provider.name === nextName)) {
      toast.error("Provider key already exists");
      setProviderNameDraft(selectedProviderName);
      return;
    }

    setConfigToml((previous) => {
      const renamed = renameSectionPrefix(
        previous,
        providerSectionParts(selectedProviderName),
        providerSectionParts(nextName),
      );
      return replaceModelProviderReferences(
        renamed,
        selectedProviderName,
        nextName,
      );
    });
    setSelectedProviderName(nextName);
  }, [providerConfigs, providerNameDraft, selectedProviderName]);

  const commitModelKey = useCallback(() => {
    if (!selectedModelKey) {
      return;
    }
    const nextKey = modelKeyDraft.trim();
    if (!nextKey || nextKey === selectedModelKey) {
      setModelKeyDraft(selectedModelKey);
      return;
    }
    if (modelConfigs.some((model) => model.key === nextKey)) {
      toast.error("Model key already exists");
      setModelKeyDraft(selectedModelKey);
      return;
    }

    setConfigToml((previous) => {
      let renamed = renameSectionPrefix(
        previous,
        modelSectionParts(selectedModelKey),
        modelSectionParts(nextKey),
      );
      if (readTopLevelString(previous, "default_model", "") === selectedModelKey) {
        renamed = setTopLevelValue(renamed, "default_model", formatTomlString(nextKey));
      }
      return renamed;
    });
    setSelectedModelKey(nextKey);
  }, [modelConfigs, modelKeyDraft, selectedModelKey]);

  const addProvider = useCallback(() => {
    const providerName = getUniqueName(
      providerConfigs.map((provider) => provider.name),
      "custom-provider",
    );
    setConfigToml((previous) =>
      appendTomlSection(previous, providerSectionParts(providerName), [
        ["type", formatTomlString("openai_legacy")],
        ["base_url", formatTomlString("")],
        ["api_key", formatTomlString("")],
      ]),
    );
    setSelectedProviderName(providerName);
  }, [providerConfigs]);

  const addModel = useCallback(() => {
    let nextProviderName = selectedProviderName || providerConfigs[0]?.name || "";
    let nextContent = configToml;

    if (!nextProviderName) {
      nextProviderName = "custom-provider";
      nextContent = appendTomlSection(nextContent, providerSectionParts(nextProviderName), [
        ["type", formatTomlString("openai_legacy")],
        ["base_url", formatTomlString("")],
        ["api_key", formatTomlString("")],
      ]);
      setSelectedProviderName(nextProviderName);
    }

    const modelKey = getUniqueName(
      parseModelConfigs(nextContent).map((model) => model.key),
      `${nextProviderName}/model-name`,
    );
    nextContent = appendTomlSection(nextContent, modelSectionParts(modelKey), [
      ["provider", formatTomlString(nextProviderName)],
      ["model", formatTomlString("model-name")],
      ["max_context_size", "200000"],
      ["capabilities", formatTomlStringArray(["thinking"])],
    ]);

    setConfigToml(nextContent);
    setSelectedModelKey(modelKey);
  }, [configToml, providerConfigs, selectedProviderName]);

  const removeSelectedModel = useCallback(() => {
    if (!selectedModelKey) {
      return;
    }
    const fallbackSelectedModelKey =
      selectedProviderModelConfigs.find((model) => model.key !== selectedModelKey)
        ?.key ?? "";
    const fallbackDefaultModelKey =
      modelConfigs.find((model) => model.key !== selectedModelKey)?.key ?? "";
    setConfigToml((previous) => {
      let next = removeSectionPrefix(previous, modelSectionParts(selectedModelKey));
      if (
        fallbackDefaultModelKey &&
        readTopLevelString(previous, "default_model", "") === selectedModelKey
      ) {
        next = setTopLevelValue(
          next,
          "default_model",
          formatTomlString(fallbackDefaultModelKey),
        );
      }
      return next;
    });
    setSelectedModelKey(fallbackSelectedModelKey);
  }, [modelConfigs, selectedModelKey, selectedProviderModelConfigs]);

  const toggleSelectedModelCapability = useCallback(
    (capability: string, checked: boolean) => {
      if (!selectedModelConfig) {
        return;
      }
      const nextCapabilities = checked
        ? Array.from(new Set([...selectedModelConfig.capabilities, capability]))
        : selectedModelConfig.capabilities.filter((item) => item !== capability);
      updateSelectedModelValue(
        "capabilities",
        formatTomlStringArray(nextCapabilities),
      );
    },
    [selectedModelConfig, updateSelectedModelValue],
  );

  const saveConfigToml = useCallback(async () => {
    setIsSavingConfig(true);
    try {
      const response = await updateConfigTomlFile(configToml);
      if (!response.success) {
        throw new Error(response.error ?? "Failed to save config.toml");
      }
      setOriginalConfigToml(configToml);
      window.dispatchEvent(new Event("kimi:config-update"));
      await refreshGlobalConfig();
      toast.success("config.toml saved");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save config.toml";
      toast.error("Failed to save config.toml", { description: message });
    } finally {
      setIsSavingConfig(false);
    }
  }, [configToml, refreshGlobalConfig]);

  const saveMcpJson = useCallback(async () => {
    setIsSavingMcp(true);
    try {
      const normalized = normalizeMcpJson(mcpJson);
      const response = await updateMcpConfigFile(normalized);
      if (!response.success) {
        throw new Error(response.error ?? "Failed to save mcp.json");
      }
      setMcpJson(normalized);
      setOriginalMcpJson(normalized);
      toast.success("mcp.json saved");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save mcp.json";
      toast.error("Failed to save mcp.json", { description: message });
    } finally {
      setIsSavingMcp(false);
    }
  }, [mcpJson]);

  const handleOpenKimiLogin = useCallback(async () => {
    if (!isTauri()) {
      toast.error("Kimi login is only available in the desktop app");
      return;
    }

    setIsOpeningKimiLogin(true);
    try {
      await openKimiLogin();
      toast.success("Kimi login terminal opened", {
        description: "Finish login in the terminal, then reload settings.",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open Kimi login";
      toast.error("Failed to open Kimi login", { description: message });
    } finally {
      setIsOpeningKimiLogin(false);
    }
  }, []);

  const handleModelChange = useCallback(
    async (modelKey: string) => {
      const currentDefaultModel = readTopLevelString(
        configToml,
        "default_model",
        config?.defaultModel ?? "",
      );
      if (modelKey === currentDefaultModel) {
        return;
      }

      const modelExistsInRuntime =
        config?.models.some((model) => model.name === modelKey) ?? false;
      const nextModelConfig = modelConfigs.find((model) => model.key === modelKey);

      setSelectedModelKey(modelKey);
      if (nextModelConfig?.provider) {
        setSelectedProviderName(nextModelConfig.provider);
      }

      if (!config || !modelExistsInRuntime) {
        updateConfigTomlKey("default_model", formatTomlString(modelKey));
        toast.success("Default model staged", {
          description: "Save config to apply this model definition.",
        });
        return;
      }

      try {
        const response = await updateGlobalConfig({ defaultModel: modelKey });
        const restartedCount = response.restartedSessionIds?.length ?? 0;
        updateConfigTomlKeyInBothCopies(
          "default_model",
          formatTomlString(modelKey),
        );
        toast.success("Default model saved", {
          description:
            restartedCount > 0
              ? `Restarted ${restartedCount} running session(s).`
              : undefined,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to save model";
        toast.error("Failed to save model", { description: message });
      }
    },
    [
      config,
      configToml,
      modelConfigs,
      updateConfigTomlKey,
      updateConfigTomlKeyInBothCopies,
      updateGlobalConfig,
    ],
  );

  const handleThinkingChange = useCallback(
    async (checked: boolean) => {
      try {
        await updateGlobalConfig({ defaultThinking: checked });
        updateConfigTomlKeyInBothCopies(
          "default_thinking",
          formatTomlBoolean(checked),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to save thinking";
        toast.error("Failed to save thinking", { description: message });
      }
    },
    [updateConfigTomlKeyInBothCopies, updateGlobalConfig],
  );

  const handleExtraSkillDirsChange = useCallback(
    (value: string) => {
      const dirs = value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      updateConfigTomlKey("extra_skill_dirs", formatTomlStringArray(dirs));
    },
    [updateConfigTomlKey],
  );

  const handleFormatMcpJson = useCallback(() => {
    try {
      setMcpJson(normalizeMcpJson(mcpJson));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON";
      toast.error("Invalid MCP JSON", { description: message });
    }
  }, [mcpJson]);

  const renderSection = () => {
    switch (activeSection) {
      case "model":
        return (
          <div className="min-w-0 space-y-6">
            <section className="rounded-md border bg-muted/10">
              <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem_auto] lg:items-end">
                <div className="min-w-0 space-y-2">
                  <FieldLabel>Default model</FieldLabel>
                  <Select
                    value={readTopLevelString(
                      configToml,
                      "default_model",
                      config?.defaultModel ?? "",
                    )}
                    disabled={
                      isGlobalConfigLoading ||
                      isGlobalConfigUpdating ||
                      modelConfigs.length === 0
                    }
                    onValueChange={handleModelChange}
                  >
                    <SelectTrigger className="w-full min-w-0">
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent align="start" className="max-h-80">
                      {modelConfigs.map((model) => (
                        <SelectItem key={model.key} value={model.key}>
                          {model.key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-md border bg-background px-3 py-2">
                  <div className="flex min-h-10 items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">Thinking</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {thinkingMode === "forced"
                          ? "Forced by model"
                          : thinkingMode === "enabled"
                            ? "Available"
                            : "Unavailable"}
                      </p>
                    </div>
                    <Switch
                      checked={
                        thinkingMode === "forced"
                          ? true
                          : thinkingMode === "disabled"
                            ? false
                            : (config?.defaultThinking ?? false)
                      }
                      disabled={
                        isGlobalConfigLoading ||
                        isGlobalConfigUpdating ||
                        thinkingMode !== "enabled"
                      }
                      onCheckedChange={handleThinkingChange}
                      aria-label="Toggle default thinking"
                    />
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={refreshGlobalConfig}
                  disabled={isGlobalConfigLoading}
                >
                  <RefreshCcw className="size-4" />
                  Reload
                </Button>
              </div>
            </section>

            {globalConfigError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {globalConfigError}
              </div>
            ) : null}

            <section className="min-w-0 overflow-hidden rounded-md border">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Providers</p>
                  <p className="truncate text-xs text-muted-foreground">
                    [providers.*] in config.toml
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addProvider}>
                  <Plus className="size-4" />
                  Add
                </Button>
              </div>

              <div className="grid min-h-[25rem] lg:grid-cols-[17rem_minmax(0,1fr)]">
                <div className="min-w-0 border-b bg-muted/10 p-2 lg:border-b-0 lg:border-r">
                  <div className="max-h-80 space-y-1 overflow-auto lg:max-h-[25rem]">
                    {providerConfigs.length === 0 ? (
                      <EmptyState label="No providers" />
                    ) : (
                      providerConfigs.map((provider) => (
                        <Button
                          key={provider.name}
                          type="button"
                          variant={
                            provider.name === selectedProviderName
                              ? "secondary"
                              : "ghost"
                          }
                          size="sm"
                          className="h-auto w-full justify-start px-2 py-2 text-left"
                          onClick={() => setSelectedProviderName(provider.name)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center justify-between gap-2">
                              <span className="truncate text-xs font-medium">
                                {provider.name}
                              </span>
                              <span className="shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {providerModelCounts.get(provider.name) ?? 0}
                              </span>
                            </span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {provider.type || "unknown"}
                            </span>
                          </span>
                        </Button>
                      ))
                    )}
                  </div>
                </div>

                <div className="min-w-0 p-4">
                  {selectedProvider ? (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{selectedProvider.type || "type"}</Badge>
                        {selectedProviderIsKimi ? (
                          <Badge variant="outline">Kimi Code auth</Badge>
                        ) : null}
                        {selectedProviderIsBuiltInKimi ? (
                          <Badge variant="outline">Built-in provider</Badge>
                        ) : null}
                        {selectedProvider.hasNestedSettings ? (
                          <Badge variant="outline">nested settings</Badge>
                        ) : null}
                      </div>

                      {selectedProviderIsKimi ? (
                        <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-medium text-foreground">
                              Kimi Code credentials
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="secondary">
                                {selectedProviderCredentialStatus}
                              </Badge>
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                onClick={handleOpenKimiLogin}
                                disabled={isOpeningKimiLogin}
                              >
                                <LogIn className="size-3.5" />
                                {isOpeningKimiLogin ? "Opening..." : "Login"}
                              </Button>
                            </div>
                          </div>
                          <p className="mt-1 text-muted-foreground">
                            Uses Kimi CLI runtime credentials. If you sign in
                            with environment variables or an existing CLI login,
                            leave the API key empty here.
                          </p>
                        </div>
                      ) : null}

                      <div className="grid min-w-0 gap-4 md:grid-cols-2">
                        <div className="min-w-0 space-y-2">
                          <FieldLabel>Provider key</FieldLabel>
                          <Input
                            value={providerNameDraft}
                            disabled={selectedProviderIsBuiltInKimi}
                            onChange={(event) =>
                              setProviderNameDraft(event.currentTarget.value)
                            }
                            onBlur={commitProviderName}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.currentTarget.blur();
                              }
                            }}
                            spellCheck={false}
                            className="font-mono text-sm"
                          />
                        </div>

                        <div className="min-w-0 space-y-2">
                          <FieldLabel>Provider type</FieldLabel>
                          <Select
                            value={selectedProvider.type}
                            disabled={selectedProviderIsBuiltInKimi}
                            onValueChange={(value) =>
                              updateSelectedProviderValue(
                                "type",
                                formatTomlString(value),
                              )
                            }
                          >
                            <SelectTrigger className="w-full min-w-0">
                              <SelectValue placeholder="Select provider type" />
                            </SelectTrigger>
                            <SelectContent align="start">
                              {providerTypeOptions.map((type) => (
                                <SelectItem key={type} value={type}>
                                  {type}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="min-w-0 space-y-2 md:col-span-2">
                          <FieldLabel>
                            {selectedProviderIsKimi ? "Base URL override" : "Base URL"}
                          </FieldLabel>
                          <Input
                            value={selectedProvider.baseUrl}
                            onChange={(event) =>
                              updateSelectedProviderValue(
                                "base_url",
                                formatTomlString(event.currentTarget.value),
                              )
                            }
                            spellCheck={false}
                            className="font-mono text-sm"
                            placeholder={
                              selectedProviderIsKimi
                                ? "Handled by Kimi Code unless overridden"
                                : "https://api.example.com/v1"
                            }
                          />
                        </div>

                        <div className="min-w-0 space-y-2 md:col-span-2">
                          <FieldLabel>
                            {selectedProviderIsKimi ? "API key override" : "API key"}
                          </FieldLabel>
                          <div className="flex min-w-0 gap-2">
                            <Input
                              type={showApiKey ? "text" : "password"}
                              value={selectedProvider.apiKey}
                              onChange={(event) =>
                                updateSelectedProviderValue(
                                  "api_key",
                                  formatTomlString(event.currentTarget.value),
                                )
                              }
                              spellCheck={false}
                              className="font-mono text-sm"
                              placeholder={
                                selectedProviderIsKimi
                                  ? "Optional; env/CLI login can stay empty"
                                  : "sk-..."
                              }
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              onClick={() => setShowApiKey((value) => !value)}
                              aria-label={showApiKey ? "Hide API key" : "Show API key"}
                            >
                              {showApiKey ? (
                                <EyeOff className="size-4" />
                              ) : (
                                <Eye className="size-4" />
                              )}
                            </Button>
                          </div>
                          {selectedProviderIsKimi ? (
                            <p className="text-xs text-muted-foreground">
                              Leave this empty when Kimi Code is authenticated
                              by environment variables or an existing CLI login.
                            </p>
                          ) : null}
                        </div>

                        <div className="min-w-0 space-y-2">
                          <FieldLabel>
                            {selectedProviderIsKimi ? "Env overrides" : "Env"}
                          </FieldLabel>
                          <Input
                            value={selectedProvider.envRaw}
                            onChange={(event) =>
                              updateSelectedProviderRawValue(
                                "env",
                                event.currentTarget.value,
                              )
                            }
                            spellCheck={false}
                            className="font-mono text-sm"
                            placeholder={
                              selectedProviderIsKimi
                                ? '{ KIMI_API_KEY = "..." }'
                                : '{ GOOGLE_CLOUD_PROJECT = "project-id" }'
                            }
                          />
                        </div>

                        <div className="min-w-0 space-y-2">
                          <FieldLabel>Custom headers</FieldLabel>
                          <Input
                            value={selectedProvider.customHeadersRaw}
                            onChange={(event) =>
                              updateSelectedProviderRawValue(
                                "custom_headers",
                                event.currentTarget.value,
                              )
                            }
                            spellCheck={false}
                            className="font-mono text-sm"
                            placeholder='{ "X-Title" = "Kimi Code" }'
                          />
                        </div>
                      </div>

                      <div className="overflow-hidden rounded-md border bg-muted/10">
                        <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold">
                              Bound models
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              provider = "{selectedProvider.name}"
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={addModel}
                          >
                            <Plus className="size-3.5" />
                            Add model
                          </Button>
                        </div>
                        <div className="grid max-h-40 gap-1 overflow-auto p-2 sm:grid-cols-2">
                          {selectedProviderModelConfigs.length === 0 ? (
                            <EmptyState label="No models bound to this provider" />
                          ) : (
                            selectedProviderModelConfigs.map((model) => (
                              <button
                                key={model.key}
                                type="button"
                                className={cn(
                                  "min-w-0 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/70",
                                  model.key === selectedModelKey && "bg-secondary",
                                )}
                                onClick={() => setSelectedModelKey(model.key)}
                              >
                                <span className="block truncate font-mono font-medium">
                                  {model.key}
                                </span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {model.model || "model"}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <EmptyState label="Select or add a provider" />
                  )}
                </div>
              </div>
            </section>

            <section className="min-w-0 overflow-hidden rounded-md border">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Models</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {selectedProviderName
                      ? `Bound to ${selectedProviderName}`
                      : "[models.*] in config.toml"}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addModel}>
                  <Plus className="size-4" />
                  Add to provider
                </Button>
              </div>

              <div className="grid min-h-[28rem] lg:grid-cols-[17rem_minmax(0,1fr)]">
                <div className="min-w-0 border-b bg-muted/10 p-2 lg:border-b-0 lg:border-r">
                  <div className="max-h-96 space-y-1 overflow-auto lg:max-h-[28rem]">
                    {selectedProviderModelConfigs.length === 0 ? (
                      <EmptyState label="No models bound to this provider" />
                    ) : (
                      selectedProviderModelConfigs.map((model) => {
                        const isDefault =
                          model.key ===
                          readTopLevelString(
                            configToml,
                            "default_model",
                            config?.defaultModel ?? "",
                          );
                        return (
                          <Button
                            key={model.key}
                            type="button"
                            variant={
                              model.key === selectedModelKey ? "secondary" : "ghost"
                            }
                            size="sm"
                            className="h-auto w-full justify-start px-2 py-2 text-left"
                            onClick={() => setSelectedModelKey(model.key)}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-1.5">
                                {isDefault ? (
                                  <Check className="size-3.5 shrink-0 text-primary" />
                                ) : null}
                                <span className="truncate text-xs font-medium">
                                  {model.key}
                                </span>
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {model.provider || "provider"} / {model.model || "model"}
                              </span>
                            </span>
                          </Button>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="min-w-0 p-4">
                  {selectedModelConfig ? (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap gap-2">
                          {selectedModelConfig.capabilities.length > 0 ? (
                            selectedModelConfig.capabilities.map((capability) => (
                              <Badge key={capability} variant="outline">
                                {capability}
                              </Badge>
                            ))
                          ) : (
                            <Badge variant="secondary">basic</Badge>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={removeSelectedModel}
                        >
                          <Trash2 className="size-4" />
                          Remove
                        </Button>
                      </div>

                      <div className="grid min-w-0 gap-4 md:grid-cols-2">
                        <div className="min-w-0 space-y-2 md:col-span-2">
                          <FieldLabel>Model key</FieldLabel>
                          <Input
                            value={modelKeyDraft}
                            onChange={(event) =>
                              setModelKeyDraft(event.currentTarget.value)
                            }
                            onBlur={commitModelKey}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.currentTarget.blur();
                              }
                            }}
                            spellCheck={false}
                            className="font-mono text-sm"
                            placeholder="provider/model-name"
                          />
                        </div>

                        <div className="min-w-0 space-y-2">
                          <FieldLabel>Provider</FieldLabel>
                          <Select
                            value={selectedModelConfig.provider}
                            disabled={providerConfigs.length === 0}
                            onValueChange={handleSelectedModelProviderChange}
                          >
                            <SelectTrigger className="w-full min-w-0">
                              <SelectValue placeholder="Select provider" />
                            </SelectTrigger>
                            <SelectContent align="start" className="max-h-80">
                              {providerConfigs.map((provider) => (
                                <SelectItem key={provider.name} value={provider.name}>
                                  {provider.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="min-w-0 space-y-2">
                          <FieldLabel>API model</FieldLabel>
                          <Input
                            value={selectedModelConfig.model}
                            onChange={(event) =>
                              updateSelectedModelValue(
                                "model",
                                formatTomlString(event.currentTarget.value),
                              )
                            }
                            spellCheck={false}
                            className="font-mono text-sm"
                            placeholder="kimi-for-coding"
                          />
                        </div>

                        <div className="min-w-0 space-y-2">
                          <FieldLabel>Max context size</FieldLabel>
                          <Input
                            type="number"
                            min={0}
                            value={stripInlineTomlComment(
                              selectedModelConfig.maxContextSizeRaw,
                            )}
                            onChange={(event) =>
                              updateSelectedModelRawValue(
                                "max_context_size",
                                event.currentTarget.value,
                              )
                            }
                            className="font-mono text-sm"
                            placeholder="262144"
                          />
                        </div>

                        <div className="min-w-0 space-y-2">
                          <FieldLabel>Display name</FieldLabel>
                          <Input
                            value={selectedModelConfig.displayName}
                            onChange={(event) =>
                              event.currentTarget.value
                                ? updateSelectedModelValue(
                                    "display_name",
                                    formatTomlString(event.currentTarget.value),
                                  )
                                : updateSelectedModelRawValue("display_name", "")
                            }
                            placeholder="Kimi-k2.6"
                          />
                        </div>

                        <div className="min-w-0 space-y-2 md:col-span-2">
                          <FieldLabel>Capabilities</FieldLabel>
                          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                            {MODEL_CAPABILITY_OPTIONS.map((capability) => (
                              <label
                                key={capability}
                                className="flex min-h-10 items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm"
                              >
                                <Checkbox
                                  checked={selectedModelConfig.capabilities.includes(
                                    capability,
                                  )}
                                  onCheckedChange={(checked) =>
                                    toggleSelectedModelCapability(
                                      capability,
                                      checked === true,
                                    )
                                  }
                                  aria-label={capability}
                                />
                                <span className="min-w-0 truncate font-mono text-xs">
                                  {capability}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <EmptyState label="Select or add a model" />
                  )}
                </div>
              </div>
            </section>
          </div>
        );
      case "general":
        return (
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground">
                  Interface language
                </label>
                <Select
                  value={uiLanguage}
                  onValueChange={(value) => setUiLanguage(value as UiLanguage)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="en-US">English</SelectItem>
                    <SelectItem value="zh-CN">Chinese (Simplified)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground">
                  App theme
                </label>
                <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground">
                  CLI theme
                </label>
                <Select
                  value={cliTheme}
                  onValueChange={(value) =>
                    updateConfigTomlKey("theme", formatTomlString(value))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <BooleanRow
                checked={defaultPlanMode}
                label="Default plan mode"
                onCheckedChange={(checked) =>
                  updateConfigTomlKey(
                    "default_plan_mode",
                    formatTomlBoolean(checked),
                  )
                }
              />
              <BooleanRow
                checked={defaultYolo}
                label="Default yolo mode"
                onCheckedChange={(checked) =>
                  updateConfigTomlKey("default_yolo", formatTomlBoolean(checked))
                }
              />
              <BooleanRow
                checked={showThinkingStream}
                label="Show thinking stream"
                onCheckedChange={(checked) =>
                  updateConfigTomlKey(
                    "show_thinking_stream",
                    formatTomlBoolean(checked),
                  )
                }
              />
              <BooleanRow
                checked={telemetry}
                label="Telemetry"
                onCheckedChange={(checked) =>
                  updateConfigTomlKey("telemetry", formatTomlBoolean(checked))
                }
              />
            </div>
          </div>
        );
      case "mcp":
        return (
          <div className="space-y-3">
            <PathLine path={mcpPath} />
            <Textarea
              value={mcpJson}
              onChange={(event) => setMcpJson(event.currentTarget.value)}
              spellCheck={false}
              className="min-h-[26rem] resize-none font-mono text-xs"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleFormatMcpJson}
              >
                <SlidersHorizontal className="size-4" />
                Format
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!mcpDirty || isSavingMcp}
                onClick={saveMcpJson}
              >
                <Save className="size-4" />
                Save MCP
              </Button>
            </div>
          </div>
        );
      case "skills":
        return (
          <div className="space-y-5">
            <BooleanRow
              checked={mergeAllSkills}
              label="Merge all available skills"
              onCheckedChange={(checked) =>
                updateConfigTomlKey(
                  "merge_all_available_skills",
                  formatTomlBoolean(checked),
                )
              }
            />

            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground">
                Extra skill directories
              </label>
              <Textarea
                value={extraSkillDirs.join("\n")}
                onChange={(event) =>
                  handleExtraSkillDirsChange(event.currentTarget.value)
                }
                placeholder="C:\\Users\\administer\\.agents\\skills"
                spellCheck={false}
                className="min-h-36 resize-none font-mono text-xs"
              />
            </div>
          </div>
        );
      case "advanced":
        return (
          <div className="space-y-3">
            <PathLine path={configPath} />
            <Textarea
              value={configToml}
              onChange={(event) => setConfigToml(event.currentTarget.value)}
              spellCheck={false}
              className="min-h-[28rem] resize-none font-mono text-xs"
            />
          </div>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[min(1220px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Kimi Code CLI configuration
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[11rem_minmax(0,1fr)]">
          <nav className="flex min-w-0 gap-1 overflow-x-auto border-b p-2 md:flex-col md:overflow-visible md:border-b-0 md:border-r">
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon;
              const active = section.id === activeSection;
              return (
                <Button
                  key={section.id}
                  type="button"
                  variant={active ? "secondary" : "ghost"}
                  size="sm"
                  className="justify-start gap-2 md:w-full"
                  onClick={() => setActiveSection(section.id)}
                >
                  <Icon className="size-4" />
                  {section.label}
                </Button>
              );
            })}
          </nav>

          <ScrollArea className="min-h-0">
            <div className="min-w-0 p-5 lg:p-6">
              {loadError ? (
                <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                  {loadError}
                </div>
              ) : null}

              {isLoadingFiles ? (
                <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
                  Loading settings...
                </div>
              ) : (
                renderSection()
              )}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-muted-foreground">
              {configDirty || mcpDirty ? "Unsaved changes" : "Saved"}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={loadConfigFiles}
                disabled={isLoadingFiles || isSavingConfig || isSavingMcp}
              >
                <RefreshCcw className="size-4" />
                Reload
              </Button>
              <Button
                type="button"
                onClick={saveConfigToml}
                disabled={!configDirty || isSavingConfig}
              >
                <Save className="size-4" />
                Save config
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type BooleanRowProps = {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
};

function BooleanRow({
  checked,
  label,
  onCheckedChange,
}: BooleanRowProps): ReactElement {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
      <span className="text-sm font-medium">{label}</span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  );
}

function PathLine({ path }: { path: string }): ReactElement | null {
  if (!path) {
    return null;
  }
  return (
    <p className="truncate rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
      {path}
    </p>
  );
}

function FieldLabel({ children }: { children: ReactNode }): ReactElement {
  return (
    <label className="text-xs font-semibold text-muted-foreground">
      {children}
    </label>
  );
}

function EmptyState({ label }: { label: string }): ReactElement {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}
