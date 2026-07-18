import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type UiLanguage = "system" | "en-US" | "zh-CN";
export type ResolvedUiLanguage = "en-US" | "zh-CN";

export const UI_LANGUAGE_STORAGE_KEY = "kimi-ui-language";

const ZH_CN_TRANSLATIONS: Record<string, string> = {
  "? This action cannot be undone.": "？此操作无法撤销。",
  "[providers.*] in config.toml": "config.toml 中的 [providers.*]",
  "A new session will be created with the conversation history up to and including this response. The current session will not be affected.":
    "将基于截至此回复为止的对话历史创建一个新会话。当前会话不会受到影响。",
  "Accept All": "全部接受",
  "Action:": "操作：",
  Activity: "活动",
  Add: "添加",
  "Add model": "添加模型",
  "Add to provider": "添加到提供商",
  "Agent Monitor": "Agent 监控",
  "Allow this": "允许此操作",
  About: "关于",
  "API key": "API 密钥",
  "API key override": "API Key 覆盖",
  "API model": "API 模型",
  "App theme": "应用主题",
  "Approval action failed": "审批操作失败",
  Approve: "批准",
  "Approve for session": "本会话内批准",
  "Approve Plan": "批准计划",
  "Approving session...": "正在批准会话...",
  Archive: "归档",
  "Archive session": "归档会话",
  Archived: "已归档",
  "Are you sure you want to delete": "确定要删除",
  "Assembling snippet...": "正在组装代码片段...",
  "Assembling snippet…": "正在组装代码片段...",
  "Attach files": "附加文件",
  Attachment: "附件",
  "Attachment preview": "附件预览",
  Available: "可用",
  "Base URL": "Base URL",
  "Base URL override": "Base URL 覆盖",
  basic: "基础",
  "Bound models": "已绑定模型",
  "Built-in provider": "内置提供商",
  Cache: "缓存",
  Cancel: "取消",
  "Cancel All": "全部取消",
  "Cancel task": "取消任务",
  Capabilities: "能力",
  "Change global model": "切换全局模型",
  "Checking changes...": "正在检查变更...",
  "Chinese (Simplified)": "简体中文",
  "Choose app to open working directory": "选择打开工作目录的应用",
  "Clear search": "清空搜索",
  "CLI theme": "CLI 主题",
  "CLI session theme": "CLI 会话主题",
  "Click the + button in the sidebar to start a new session":
    "点击侧边栏中的 + 按钮开始新会话",
  "Click to open in new tab": "点击以在新标签页打开",
  Close: "关闭",
  "Close sessions sidebar": "关闭会话侧边栏",
  "Close side chat": "关闭侧聊",
  "Close sidebar": "关闭侧边栏",
  "Close workspace files panel": "关闭工作区文件面板",
  "Collapse agent monitor": "折叠 Agent 监控",
  "Collapse sidebar": "折叠侧边栏",
  "Collapse skills panel": "折叠技能面板",
  "Collapse workspace panel": "折叠工作区面板",
  "config.toml env": "config.toml 环境变量",
  "config.toml saved": "config.toml 已保存",
  "Confirming...": "正在确认...",
  "Connection Error": "连接错误",
  Context: "上下文",
  "Copied!": "已复制！",
  Copy: "复制",
  "Copy path": "复制路径",
  Config: "配置",
  "Create a session to begin": "创建一个会话开始使用",
  "Create or select a session to start working with Kimi.":
    "创建或选择一个会话，开始使用 Kimi。",
  "Create Directory": "创建目录",
  "Create new session": "创建新会话",
  "Create New Session": "创建新会话",
  "Custom headers": "自定义请求头",
  Dark: "深色",
  Decline: "拒绝",
  "Declining...": "正在拒绝...",
  "Default model": "默认模型",
  "Default model saved": "默认模型已保存",
  "Default model staged": "默认模型已暂存",
  "Default plan mode": "默认计划模式",
  "Default yolo mode": "默认 YOLO 模式",
  Delete: "删除",
  "Delete session": "删除会话",
  "Delete Session": "删除会话",
  "Diff Review": "Diff 审查",
  "Directory Not Found": "目录不存在",
  Dismiss: "忽略",
  "Display name": "显示名称",
  "Display type:": "显示类型：",
  "does not exist. Would you like to create it?": "不存在。要创建它吗？",
  Done: "完成",
  "Double-click to rename": "双击重命名",
  Edit: "编辑",
  "Edit Plan": "编辑计划",
  "Edit queued message": "编辑排队消息",
  "Empty Message": "消息为空",
  English: "英语",
  Enter: "回车",
  "Enter to submit · Shift+Enter for newline · Esc to cancel":
    "回车提交 · Shift+回车换行 · Esc 取消",
  Env: "环境变量",
  "Env overrides": "环境变量覆盖",
  "Expand sidebar": "展开侧边栏",
  "Expand workspace panel": "展开工作区面板",
  "Extra skill directories": "额外技能目录",
  "Failed to copy path": "复制路径失败",
  "Failed to decode file content": "文件内容解码失败",
  "Failed to load image": "图片加载失败",
  "Failed to load image:": "图片加载失败：",
  "Failed to load media": "媒体加载失败",
  "Failed to load settings": "加载设置失败",
  "Failed to load this directory": "加载此目录失败",
  "Failed to open Kimi login": "打开 Kimi 登录失败",
  "Failed to open": "打开失败",
  "Failed to open application": "打开应用失败",
  "Failed to restart busy sessions": "重启繁忙会话失败",
  "Failed to save config.toml": "保存 config.toml 失败",
  "Failed to save mcp.json": "保存 mcp.json 失败",
  "Failed to save model": "保存模型失败",
  "Failed to save settings": "保存设置失败",
  "Failed to save thinking": "保存思考模式失败",
  "Failed to update global model": "更新全局模型失败",
  "Failed to update global thinking": "更新全局思考模式失败",
  "Failed to Upload Files": "上传文件失败",
  "File Error": "文件错误",
  "File too large for inline diff": "文件过大，无法内联显示 diff",
  "File:": "文件：",
  Files: "文件",
  "Files uploaded": "文件已上传",
  "Force restart busy sessions": "强制重启繁忙会话",
  Fork: "派生",
  "Fork failed": "派生失败",
  "Fork session": "派生会话",
  "Fork Session": "派生会话",
  "Fork session from this point": "从此处派生会话",
  Format: "格式化",
  "Forced by model": "由模型强制启用",
  "Finish login in the terminal, then reload settings.":
    "请在终端中完成登录，然后重新加载设置。",
  "Full size preview": "全尺寸预览",
  General: "通用",
  "Generated code": "生成的代码",
  "Generated content": "生成内容",
  "Generated image": "生成的图片",
  "Generated output": "生成输出",
  "Handled by Kimi Code unless overridden": "默认由 Kimi Code 处理，需要覆盖时再填写",
  "Generated:": "已生成：",
  "Git changes": "Git 变更",
  Changes: "变更",
  "Global model updated": "全局模型已更新",
  "Grouped by folder": "按文件夹分组",
  "Grouped view": "分组视图",
  "Hide API key": "隐藏 API 密钥",
  Hunk: "变更块",
  Image: "图片",
  Input: "输入",
  "Input Tokens": "输入 Token",
  "Interface language": "界面语言",
  "Invalid MCP JSON": "MCP JSON 无效",
  "Invalid JSON": "JSON 无效",
  Invoke: "调用",
  "Invoke /skill:": "调用 /skill：",
  "Jump to message": "跳转到消息",
  "Kimi Code auth": "Kimi Code 鉴权",
  "Kimi Code CLI configuration": "Kimi Code CLI 配置",
  "Kimi Code credentials": "Kimi Code 凭据",
  "Kimi login is only available in the desktop app":
    "Kimi 登录只能在桌面应用中使用",
  "Kimi login terminal opened": "Kimi 登录终端已打开",
  "Last used": "上次使用",
  "Leave this empty when Kimi Code is authenticated by environment variables or an existing CLI login.":
    "使用环境变量或已有 CLI 登录态时，这里保持为空。",
  Light: "浅色",
  "List view": "列表视图",
  "Load more": "加载更多",
  Loader: "加载器",
  Login: "登录",
  "Loading diff...": "正在加载 diff...",
  "Loading files...": "正在加载文件...",
  "Loading settings...": "正在加载设置...",
  "Loading workspace files...": "正在加载工作区文件...",
  "Loading workspace files…": "正在加载工作区文件...",
  "Manual approval required by": "需要手动批准，来源：",
  "Max context size": "最大上下文长度",
  "mcp.json saved": "mcp.json 已保存",
  "Media preview": "媒体预览",
  "Message queued": "消息已排队",
  "Merge all available skills": "合并全部可用技能",
  "Model context usage": "模型上下文用量",
  "Model key": "模型键",
  "Model key already exists": "模型键已存在",
  Models: "模型",
  Model: "模型",
  "more lines...": "行更多内容...",
  "Move up": "上移",
  Navigate: "导航",
  "nested settings": "嵌套设置",
  "New session": "新建会话",
  "New Session": "新建会话",
  "New session here": "在此处新建会话",
  "Next branch": "下一个分支",
  "Next slide": "下一张幻灯片",
  "No active agents": "没有活跃的 Agent",
  "No active session": "没有活跃会话",
  "No active task list": "没有活跃任务列表",
  "No archived sessions": "没有已归档会话",
  "No diff to review": "没有可审查的 diff",
  "No files in this directory.": "此目录中没有文件。",
  "No messages found": "未找到消息",
  "No models found.": "未找到模型。",
  "No models bound to this provider": "此提供商未绑定模型",
  "No pending requests": "没有待处理请求",
  "No providers": "没有提供商",
  "No skills found": "未找到技能",
  "No workspace files": "没有工作区文件",
  Open: "打开",
  "Opening...": "正在打开...",
  "Optional; env/CLI login can stay empty":
    "可选；使用环境变量/CLI 登录时可留空",
  "Open in": "打开方式",
  "Open sessions sidebar": "打开会话侧边栏",
  "Open settings": "打开设置",
  "Open side chat": "打开侧聊",
  "Open working directory": "打开工作目录",
  Overview: "概览",
  Other: "其他",
  Output: "输出",
  "Output Tokens": "输出 Token",
  "Path copied": "路径已复制",
  Plan: "计划",
  "Plan Preview": "计划预览",
  "Press Enter to send, @ for files, / for commands.":
    "按回车发送，@ 提及文件，/ 查看命令。",
  "Preferences saved": "偏好设置已保存",
  "Previous branch": "上一个分支",
  "Previous slide": "上一张幻灯片",
  Provider: "提供商",
  "Provider key": "提供商键",
  "Provider key already exists": "提供商键已存在",
  "Provider type": "提供商类型",
  Providers: "提供商",
  "Question response failed": "问题回复失败",
  "Queue message": "消息入队",
  Queued: "已排队",
  "Raw token usage": "原始 Token 用量",
  Reasoning: "推理",
  "Reasoning through the request...": "正在推理请求...",
  "Reasoning through the request…": "正在推理请求...",
  "Recent files": "最近文件",
  "Refresh git changes": "刷新 Git 变更",
  "Refresh sessions": "刷新会话",
  "Refresh Sessions": "刷新会话",
  "Refresh workspace files": "刷新工作区文件",
  "Reject All": "全部拒绝",
  "Reject Plan": "拒绝计划",
  Reload: "重新加载",
  "Reload global config": "重新加载全局配置",
  Remove: "移除",
  "Remove attachment": "移除附件",
  Rename: "重命名",
  "Request denied": "请求已拒绝",
  "Request failed": "请求失败",
  Requests: "请求",
  "Resource:": "资源：",
  "Restarted running sessions": "已重启正在运行的会话",
  Retry: "重试",
  Root: "根目录",
  "Runtime env / CLI login": "运行时环境变量 / CLI 登录",
  "Running subagents will appear here when spawned by the Agent tool.":
    "Agent 工具启动子 Agent 后会显示在这里。",
  Save: "保存",
  "Save config": "保存配置",
  "Save MCP": "保存 MCP",
  "Save settings": "保存设置",
  "Save config to apply this model definition.": "保存配置后应用此模型定义。",
  Saved: "已保存",
  "Search directories or type a path...": "搜索目录或输入路径...",
  "Search directories or type a new path": "搜索目录或输入新路径",
  "Search in conversation...": "搜索对话...",
  "Search messages": "搜索消息",
  "Search Messages": "搜索消息",
  "Search models...": "搜索模型...",
  "Search sessions...": "搜索会话...",
  "Search skills...": "搜索技能...",
  "Select an active session to enable workspace file mentions.":
    "选择一个活跃会话后即可使用工作区文件提及。",
  "Select a session to inspect the workspace": "选择会话以查看工作区",
  "Select global model": "选择全局模型",
  "Select model": "选择模型",
  "Select or add a model": "选择或添加模型",
  "Select or add a provider": "选择或添加提供商",
  "Select Multiple": "多选",
  "Select provider": "选择提供商",
  "Select provider type": "选择提供商类型",
  "Send message": "发送消息",
  "Session approved. Future matching requests auto-approve.":
    "会话已批准。后续匹配的请求会自动批准。",
  "Session Error": "会话错误",
  "Session forked successfully": "会话派生成功",
  "Session info": "会话信息",
  "Session Info": "会话信息",
  Session: "会话",
  Sessions: "会话",
  Settings: "设置",
  "Settings saved": "设置已保存",
  "Show API key": "显示 API 密钥",
  "Show thinking stream": "显示思考流",
  "Side Chat": "侧聊",
  "Skills Library": "技能库",
  Skills: "技能",
  "Slash Commands": "斜杠命令",
  "Something went wrong": "出了点问题",
  "Start a conversation...": "开始对话...",
  "Start a side conversation": "开始侧聊",
  "Starting environment...": "正在启动环境...",
  "Still processing": "仍在处理",
  "Still uploading": "仍在上传",
  "Stop generation": "停止生成",
  Submit: "提交",
  "Submit feedback": "提交反馈",
  "Switch to dark mode": "切换到深色模式",
  "Switch to light mode": "切换到浅色模式",
  System: "系统",
  Tasks: "任务",
  Telemetry: "遥测",
  "Tell the model what to do instead...": "告诉模型改为执行什么...",
  "The directory": "目录",
  "Thinking through the problem...": "正在思考问题...",
  "Thinking through the request...": "正在思考请求...",
  Thinking: "思考",
  "Thought through the problem": "已思考该问题",
  "Toggle default thinking": "切换默认思考模式",
  "Toggle global thinking": "切换全局思考模式",
  "Toggle plan mode": "切换计划模式",
  "Tool execution cancelled.": "工具执行已取消。",
  "Tool output": "工具输出",
  "Total cost": "总成本",
  "Total Input": "总输入",
  "Try adjusting your search query.": "试着调整搜索关键词。",
  "Try again": "重试",
  "Type a message...": "输入消息...",
  "Type a path to search deeper.": "输入路径以继续深入搜索。",
  "Type a path to start a new session.": "输入路径以开始新会话。",
  "Type to search": "输入以搜索",
  "Type your answer...": "输入你的回答...",
  "Type:": "类型：",
  Unarchive: "取消归档",
  "Unarchive session": "取消归档会话",
  Unavailable: "不可用",
  "Unknown Session": "未知会话",
  "Unsaved changes": "有未保存的更改",
  "Unsaved MCP changes": "MCP 有未保存的更改",
  "Unsaved settings": "设置有未保存的更改",
  "Unsaved settings and MCP changes": "设置和 MCP 都有未保存的更改",
  Untitled: "未命名",
  Up: "上一级",
  Upload: "上传",
  "Upload files": "上传文件",
  "Uploading files...": "正在上传文件...",
  "Uploading files…": "正在上传文件...",
  Usage: "用量",
  "Uses Kimi CLI runtime credentials. If you sign in with environment variables or an existing CLI login, leave the API key empty here.":
    "使用 Kimi CLI 运行时凭据。如果通过环境变量或已有 CLI 登录态登录，这里的 API Key 保持为空即可。",
  User: "用户",
  Video: "视频",
  "Waiting for approval...": "正在等待批准...",
  "Waiting for your approval...": "等待你的批准...",
  "Waiting for your approval…": "等待你的批准...",
  "What would you like to know?": "想了解什么？",
  "Work dir": "工作目录",
  "Working Directory": "工作目录",
  Workspace: "工作区",
  "Workspace files": "工作区文件",
  "Workspace files indexed.": "工作区文件已索引。",
  "Workspace files unavailable.": "工作区文件不可用。",
  "Write": "写入",
  "Writing files...": "正在写入文件...",
  "[models.*] in config.toml": "config.toml 中的 [models.*]",
};

const EN_US_RESTORE_TRANSLATIONS = Object.entries(ZH_CN_TRANSLATIONS).reduce<
  Record<string, string>
>((restoreMap, [english, chinese]) => {
  restoreMap[chinese] ??= english;
  return restoreMap;
}, {});

const TRANSLATABLE_ATTRIBUTES = [
  "aria-label",
  "title",
  "placeholder",
  "alt",
] as const;

const SKIP_TAGS = new Set([
  "CODE",
  "IFRAME",
  "INPUT",
  "NOSCRIPT",
  "PRE",
  "SCRIPT",
  "STYLE",
  "TEXTAREA",
]);

type I18nContextValue = {
  uiLanguage: UiLanguage;
  resolvedLanguage: ResolvedUiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  t: (value: string) => string;
};

type TextRecord = {
  original: string;
  lastApplied: string;
};

type AttributeRecord = {
  original: string;
  lastApplied: string;
};

const I18nContext = createContext<I18nContextValue | null>(null);
const textRecords = new WeakMap<Text, TextRecord>();
const attributeRecords = new WeakMap<Element, Map<string, AttributeRecord>>();

function isUiLanguage(value: string | null): value is UiLanguage {
  return value === "system" || value === "en-US" || value === "zh-CN";
}

function getSystemLanguage(): ResolvedUiLanguage {
  if (typeof navigator !== "undefined" && navigator.language.startsWith("zh")) {
    return "zh-CN";
  }
  return "en-US";
}

export function resolveUiLanguage(language: UiLanguage): ResolvedUiLanguage {
  return language === "system" ? getSystemLanguage() : language;
}

function getInitialUiLanguage(): UiLanguage {
  if (typeof window === "undefined") {
    return "system";
  }
  const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
  return isUiLanguage(stored) ? stored : "system";
}

function translateCore(core: string): string | null {
  const direct = ZH_CN_TRANSLATIONS[core];
  if (direct) {
    return direct;
  }

  const selectedMatch = core.match(/^(\d+) selected$/);
  if (selectedMatch) {
    return `已选择 ${selectedMatch[1]} 个`;
  }

  const countMatch = core.match(/^(\d+) of (\d+)$/);
  if (countMatch) {
    return `${countMatch[1]} / ${countMatch[2]}`;
  }

  return null;
}

export function translateUiString(
  value: string,
  language: ResolvedUiLanguage,
): string {
  if (language !== "zh-CN") {
    return value;
  }

  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const core = value.replace(/\s+/g, " ").trim();
  const translated = translateCore(core);

  return translated ? `${leading}${translated}${trailing}` : value;
}

function restoreCore(core: string): string | null {
  return EN_US_RESTORE_TRANSLATIONS[core] ?? null;
}

function restoreUiString(value: string): string {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const core = value.replace(/\s+/g, " ").trim();
  const restored = restoreCore(core);

  return restored ? `${leading}${restored}${trailing}` : value;
}

function shouldSkipElement(element: Element | null): boolean {
  if (!element) {
    return true;
  }

  if (SKIP_TAGS.has(element.tagName)) {
    return true;
  }

  return Boolean(
    element.closest(
      "[data-kimi-i18n-skip], code, pre, script, style, textarea",
    ),
  );
}

function shouldSkipAttributeElement(element: Element): boolean {
  return Boolean(
    element.closest("[data-kimi-i18n-skip], code, pre, script, style"),
  );
}

function applyTextNodeTranslation(
  node: Text,
  language: ResolvedUiLanguage,
): void {
  const current = node.nodeValue ?? "";
  if (!current.trim()) {
    return;
  }

  if (shouldSkipElement(node.parentElement)) {
    return;
  }

  let record = textRecords.get(node);

  if (language === "zh-CN") {
    if (!/[A-Za-z]/.test(current) && !record) {
      return;
    }

    if (!record || current !== record.lastApplied) {
      record = { original: current, lastApplied: current };
      textRecords.set(node, record);
    }

    const translated = translateUiString(record.original, language);
    record.lastApplied = translated;

    if (translated !== current) {
      node.nodeValue = translated;
    }
    return;
  }

  const restored = record?.original ?? restoreUiString(current);
  if (current !== restored) {
    node.nodeValue = restored;
    if (record) {
      record.lastApplied = restored;
    }
  }
}

function getAttributeRecord(
  element: Element,
  attribute: string,
): AttributeRecord | undefined {
  return attributeRecords.get(element)?.get(attribute);
}

function setAttributeRecord(
  element: Element,
  attribute: string,
  record: AttributeRecord,
): void {
  let records = attributeRecords.get(element);
  if (!records) {
    records = new Map();
    attributeRecords.set(element, records);
  }
  records.set(attribute, record);
}

function applyAttributeTranslation(
  element: Element,
  attribute: (typeof TRANSLATABLE_ATTRIBUTES)[number],
  language: ResolvedUiLanguage,
): void {
  const current = element.getAttribute(attribute);
  if (!current) {
    return;
  }

  if (shouldSkipAttributeElement(element)) {
    return;
  }

  let record = getAttributeRecord(element, attribute);

  if (language === "zh-CN") {
    if (!/[A-Za-z]/.test(current) && !record) {
      return;
    }

    if (!record || current !== record.lastApplied) {
      record = { original: current, lastApplied: current };
      setAttributeRecord(element, attribute, record);
    }

    const translated = translateUiString(record.original, language);
    record.lastApplied = translated;

    if (translated !== current) {
      element.setAttribute(attribute, translated);
    }
    return;
  }

  const restored = record?.original ?? restoreUiString(current);
  if (current !== restored) {
    element.setAttribute(attribute, restored);
    if (record) {
      record.lastApplied = restored;
    }
  }
}

function applyElementTranslation(
  root: Element,
  language: ResolvedUiLanguage,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  let currentNode = walker.nextNode();
  while (currentNode) {
    applyTextNodeTranslation(currentNode as Text, language);
    currentNode = walker.nextNode();
  }

  const elements =
    root instanceof HTMLElement || root instanceof SVGElement
      ? [root, ...Array.from(root.querySelectorAll("*"))]
      : Array.from(root.querySelectorAll("*"));

  for (const element of elements) {
    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      applyAttributeTranslation(element, attribute, language);
    }
  }
}

export function UiLanguageProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [uiLanguage, setUiLanguageState] =
    useState<UiLanguage>(getInitialUiLanguage);

  const resolvedLanguage = useMemo(
    () => resolveUiLanguage(uiLanguage),
    [uiLanguage],
  );

  const setUiLanguage = useCallback((language: UiLanguage) => {
    setUiLanguageState(language);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (uiLanguage === "system") {
      window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, uiLanguage);
    }

    document.documentElement.lang = resolvedLanguage;
  }, [resolvedLanguage, uiLanguage]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== UI_LANGUAGE_STORAGE_KEY) {
        return;
      }
      setUiLanguageState(isUiLanguage(event.newValue) ? event.newValue : "system");
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const t = useCallback(
    (value: string) => translateUiString(value, resolvedLanguage),
    [resolvedLanguage],
  );

  const value = useMemo(
    () => ({
      uiLanguage,
      resolvedLanguage,
      setUiLanguage,
      t,
    }),
    [resolvedLanguage, setUiLanguage, t, uiLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within UiLanguageProvider");
  }
  return context;
}

export function useDomTranslations(): void {
  const { resolvedLanguage } = useI18n();

  useEffect(() => {
    if (typeof document === "undefined" || !document.body) {
      return;
    }

    let frame = 0;
    let applying = false;

    const apply = () => {
      if (applying) {
        return;
      }
      applying = true;
      try {
        applyElementTranslation(document.body, resolvedLanguage);
      } finally {
        applying = false;
      }
    };

    const schedule = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    };

    apply();

    const observer = new MutationObserver((mutations) => {
      if (applying) {
        return;
      }

      if (
        mutations.some(
          (mutation) =>
            mutation.type === "childList" ||
            mutation.type === "characterData" ||
            mutation.type === "attributes",
        )
      ) {
        schedule();
      }
    });

    observer.observe(document.body, {
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [resolvedLanguage]);
}
