import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
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
  Appearance: "外观",
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
  "Click the + button in the sidebar to start a new session": "点击侧边栏中的 + 按钮开始新会话",
  "Click to open in new tab": "点击以在新标签页打开",
  Close: "关闭",
  "Close sessions sidebar": "关闭会话侧边栏",
  "Close side chat": "关闭侧聊",
  "Close sidebar": "关闭侧边栏",
  "Close workspace files panel": "关闭工作区文件面板",
  Collapse: "收起",
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
  "Create or select a session to start working with Kimi.": "创建或选择一个会话，开始使用 Kimi。",
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
  "This action is only available in the desktop app": "该入口仅在桌面应用中可用",
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
  "Expand all": "展开全部",
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
  "Failed to open file picker": "打开文件选择器失败",
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
  "Finish login in the terminal, then reload settings.": "请在终端中完成登录，然后重新加载设置。",
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
  "Follow system": "跟随系统",
  "Invalid MCP JSON": "MCP JSON 无效",
  "Invalid JSON": "JSON 无效",
  Invoke: "调用",
  "Invoke /skill:": "调用 /skill：",
  "Jump to message": "跳转到消息",
  "Kimi Code auth": "Kimi Code 鉴权",
  "Kimi Code CLI configuration": "Kimi Code CLI 配置",
  "Kimi Code credentials": "Kimi Code 凭据",
  "Kimi Code login (optional)": "Kimi Code 登录（可选）",
  "Kimi Code needs approval": "Kimi Code 需要批准",
  "Kimi login is only available in the desktop app": "Kimi 登录只能在桌面应用中使用",
  "Kimi login terminal opened": "Kimi 登录终端已打开",
  "Sign in with a device code in this app. Credentials are saved like `kimi login`.":
    "在本应用内用设备码登录。凭据写入方式与 `kimi login` 相同。",
  "Signed in. Credentials are saved like `kimi login`.":
    "已登录。凭据写入方式与 `kimi login` 相同。",
  "Signed in": "已登录",
  "Sign in again": "重新登录",
  "Starting login…": "正在开始登录…",
  "Open the link, sign in, and confirm this code:": "打开链接并登录，然后确认以下验证码：",
  "Open browser": "打开浏览器",
  "Copy code": "复制验证码",
  Copied: "已复制",
  "Waiting for authorization…": "等待授权中…",
  "Login successful. Credentials saved for Kimi Code.": "登录成功。已写入 Kimi Code 凭据。",
  "Logged out. Credentials cleared.": "已退出登录。凭据已清除。",
  "Logging out…": "正在退出…",
  "Device code expired. Start login again.": "设备码已过期，请重新登录。",
  "Open terminal login instead": "改为在终端登录",
  "Last used": "上次使用",
  "Leave this empty when Kimi Code is authenticated by environment variables or an existing CLI login.":
    "使用环境变量或已有 CLI 登录态时，这里保持为空。",
  Light: "浅色",
  "List view": "列表视图",
  "Load more": "加载更多",
  Loader: "加载器",
  Login: "登录",
  Logout: "退出登录",
  "Loading diff...": "正在加载 diff...",
  "Loading files...": "正在加载文件...",
  "Loading settings...": "正在加载设置...",
  "Loading workspace files...": "正在加载工作区文件...",
  "Loading workspace files…": "加载工作区文件…",
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
  "New session": "新会话",
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
  "Optional; env/CLI login can stay empty": "可选；使用环境变量/CLI 登录时可留空",
  "Open in": "打开方式",
  "Open in File Explorer": "在资源管理器中打开",
  "Open in VS Code": "在 VS Code 中打开",
  "Open release page": "打开发布页",
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
  "Press Enter to send, @ for files, / for commands.": "按回车发送，@ 提及文件，/ 查看命令。",
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
  "Show in Finder": "在 Finder 中显示",
  "Show full output": "显示完整输出",
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
  "Task cancelled": "任务已取消",
  "Task completed": "任务已完成",
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
  "Update check failed": "检查更新失败",
  "Updates available": "发现可用更新",
  "Upload files": "上传文件",
  "Uploading files...": "正在上传文件...",
  "Uploading files…": "正在上传文件...",
  Usage: "用量",
  "Uses Kimi CLI runtime credentials. If you sign in with environment variables or an existing CLI login, leave the API key empty here.":
    "使用 Kimi CLI 运行时凭据。如果通过环境变量或已有 CLI 登录态登录，这里的 API Key 保持为空即可。",
  "Unable to open working directory": "无法打开工作目录",
  User: "用户",
  Video: "视频",
  "Waiting for approval...": "正在等待批准...",
  "Waiting for your approval...": "等待你的批准...",
  "Waiting for your approval…": "等待你的批准...",
  "What would you like to know?": "想了解什么？",
  "Work dir": "工作目录",
  "Working Directory": "工作目录",
  "Working directory does not exist": "工作目录不存在",
  Workspace: "工作区",
  "Workspace files": "工作区文件",
  "Workspace files indexed.": "工作区文件已索引。",
  "Workspace files unavailable.": "工作区文件不可用。",
  Write: "写入",
  "Writing files...": "正在写入文件...",
  "[models.*] in config.toml": "config.toml 中的 [models.*]",
  "Switch model failed": "切换模型失败",
  "Update thinking mode failed": "更新思考模式失败",
  "Update thinking effort failed": "更新思考档位失败",
  "Choose a working directory first": "请先选择工作目录",
  "Send a message to create a session first": "请先发送消息创建会话",
  "Swarm mode can be changed from the status bar after entering a session":
    "Swarm 模式可在进入会话后通过状态栏切换",
  "Give Kimi a task": "给 Kimi 布置一个任务",
  "Saved as the global default; idle sessions will restart to apply it.":
    "已写入全局默认；空闲会话将重启以应用。",
  "Configuration saved; idle sessions will restart to apply it.":
    "已写入配置文件；空闲会话将重启以应用。",
  "Some busy sessions skipped restart": "部分忙碌会话已跳过重启",
  "The new configuration will apply after those sessions become idle.":
    "新配置将在这些会话空闲后生效。",
  "Querying…": "查询中…",
  "CLI update available": "CLI 有更新",
  "CLI update check failed": "CLI 检查失败",
  "Desktop and CLI are up to date": "桌面版与 CLI 均为最新",
  "Desktop update available": "桌面版有更新",
  "Desktop update check failed": "桌面版检查失败",
  "Drop to insert file paths": "松开以插入文件路径",
  "Drop to upload files": "松开以上传文件",
  "Pending queue ·": "待发送队列 ·",
  Clear: "清空",
  "No matching commands": "没有匹配的命令",
  "File references": "文件引用",
  "Upload attachment": "上传附件",
  Commands: "命令",
  "Model list": "模型列表",
  "No models available": "暂无可用模型",
  "Thinking effort": "思考档位",
  "Manage configuration in Settings…": "在设置中管理配置…",
  "Kimi wants to perform an action": "Kimi 请求执行操作",
  Allow: "允许",
  "Do not ask again in this session": "本会话不再询问",
  Reconnect: "重新连接",
  Summary: "摘要",
  "… and": "… 还有",
  lines: "行",
  "Fork session from this turn": "从此轮分叉会话",
  "Waiting for model response…": "等待模型响应…",
  "Waiting for subagents to start…": "等待子代理启动…",
  "Kimi has a few questions": "Kimi 想确认几个问题",
  Submitted: "已提交",
  "✗ Failed": "✗ 失败",
  "(no output)": "（无输出）",
  "Preparing the Kimi Code runtime": "准备 Kimi Code 运行时",
  "Checking the runtime environment…": "正在检查运行环境…",
  "Continue anyway": "仍要继续",
  "Go to download": "前往下载",
  "Collapse session list": "收起会话列表",
  "Expand session list": "展开会话列表",
  "Choose a working directory where Kimi will perform tasks.":
    "选择一个工作目录，Kimi 会在该目录下执行任务。",
  "Working directory, for example C:\\projects\\foo": "工作目录，如 C:\\projects\\foo",
  "Session title": "会话标题",
  "Confirm rename": "确认重命名",
  "Cancel rename": "取消重命名",
  "Restore session": "恢复会话",
  "Search sessions": "搜索会话",
  "Bulk manage": "批量管理",
  "Quick archive": "一键归档",
  "d ago": "d 以前",
  Projects: "项目",
  selected: "已选择",
  sessions: "个会话",
  "Kimi will perform tasks in this directory": "Kimi 会在该目录下执行任务",
  "Enter a path, for example C:\\projects\\foo": "输入路径，如 C:\\projects\\foo",
  Confirm: "确定",
  "Loading…": "加载中…",
  "The current file has unsaved changes. Discard them?": "当前文件有未保存的更改，确定放弃吗？",
  "Update default model failed": "更新默认模型失败",
  "Update Thinking failed": "更新 Thinking 失败",
  "Manage app appearance, Kimi Code configuration, MCP servers, usage, and version information.":
    "管理应用外观、Kimi Code 配置、MCP Server、用量统计和版本信息。",
  "Kimi Code sign-in": "Kimi Code 登录",
  "Signed in successfully; credentials were saved": "登录成功，凭据已写入",
  "Signed out; credentials were cleared": "已退出登录，凭据已清除",
  "Global configuration": "全局配置",
  "The global default for new and restarted sessions. Use the model menu in chat for everyday switching; add or edit model definitions under Config.":
    "新会话与重启后的全局默认。日常切换请用聊天区模型菜单；在 Config 中添加或编辑模型定义。",
  "Enable Plan mode by default": "默认开启 Plan 模式",
  "Enable Thinking by default": "默认开启 Thinking",
  "Saving…": "保存中…",
  "Unable to read configuration": "无法读取配置",
  "Add or edit models, capabilities, and providers. This edits the complete Kimi Code CLI TOML; idle sessions restart after saving.":
    "添加 / 编辑模型、capabilities 与 provider。直接编辑 Kimi Code CLI 的完整 TOML；保存后空闲会话会重启以应用。",
  "Manage MCP Server configuration. JSON is validated locally before saving.":
    "管理 MCP Server 配置。保存前会在本地检查 JSON 格式。",
  Version: "版本",
  "Desktop app": "桌面版",
  "Visit the Kimi Code website": "访问 Kimi Code 官网",
  "Token usage trend": "Token 用量趋势",
  "Loading quota…": "额度加载中…",
  "Current quota unavailable:": "当前额度不可用：",
  "No quota data returned for this account": "账号未返回配额数据",
  "Extra Usage this month": "Extra Usage 本月",
  "· Balance": "· 余额",
  "Local token usage": "本地 Token 用量",
  "Scanning session records…": "扫描会话记录中…",
  "Total Tokens": "总 Tokens",
  "Cache reads": "Cache 读",
  "Cache writes": "Cache 写",
  Scanned: "已扫描",
  "wire files · matched": "个 wire · 命中",
  "turn records": "条 turn 记录",
  "No local usage records yet. LLM calls in new sessions are written to wire.jsonl and will be summarized here.":
    "暂无本地用量记录。新会话中的 LLM 调用会写入 wire.jsonl，之后可在此汇总。",
  "By model": "按模型",
  Total: "合计",
  "Current Plan quota": "当前 Plan 额度",
  "No token usage data": "暂无 token 用量数据",
  "Enter to send · ⇧⏎ for newline": "Enter 发送 · ⇧⏎ 换行",
  "Workspace panel": "工作区面板",
  Minimize: "最小化",
  "No agent tasks in this session": "当前会话还没有代理任务",
  "Refresh changes": "刷新更改",
  "No file changes in this session": "当前会话还没有文件更改",
  "Statistics were read from Git; this turn has no line-level preview.":
    "已从 Git 读取统计；本轮事件没有可用的行级预览。",
  "Close panel": "关闭面板",
  "Approve pending actions": "批准待执行",
  "Reject pending actions": "拒绝待执行",
  "Go to parent directory": "返回上级目录",
  "Refresh files": "刷新文件",
  "Directory is empty": "目录为空",
  "No task summary in this session": "当前会话还没有任务摘要",
  "Current goal": "当前目标",
  "Files in this turn": "本轮文件",
  "Goal changed; please try again": "Goal 已变化，请重新操作",
  "Failed to cancel Goal": "取消 Goal 失败",
  "Resize composer": "调整输入框高度",
  "Subagent progress": "子代理进度",
  finished: "已结束",
  "Cancel the current Goal?": "取消当前 Goal？",
  "Canceling will clear the current Goal and it cannot be restored.":
    "取消后会清除当前 Goal，之后不能再恢复。",
  "Keep Goal": "保留 Goal",
  "Manage Goal queue": "管理 Goal 队列",
  "Reorder upcoming Goals, edit objectives, or remove Goals you no longer need.":
    "调整后续 Goal 的顺序、目标内容，或移除不再需要的 Goal。",
  "No Goals are queued.": "当前没有排队的 Goal。",
  "Goal queue": "Goal 队列",
  Created: "创建",
  "· Updated": "· 更新",
  "Start Goal": "启动 Goal",
  "Kimi Code will work toward this objective across turns, check progress, and stop when it completes, pauses, becomes blocked, or reaches its budget.":
    "Kimi Code 会围绕这个目标跨轮执行、检查进度，并在完成、暂停、阻塞或达到预算时停止。",
  Currently: "当前为",
  "; choose the permission mode for this Goal.": "；请选择 Goal 运行时的权限模式。",
  "Switch to Auto and start": "切换 Auto 并开始",
  "Keep Manual and start": "保持 Manual 并开始",
  "Do not start": "不开始",
  Unanswered: "未作答",
  "Waiting for subagent steps…": "等待子代理步骤…",
  "This check is taking longer than expected. A VPN may add delay; you can also continue now and retry later.":
    "检查时间较长。若正在使用 VPN，可能额外增加延迟；也可以先继续，稍后再重试。",
  "If you use a VPN or the network is unstable, confirm connectivity before retrying.":
    "若使用 VPN 或网络不稳定，请确认连通后再重试。",
  "Loading sessions": "加载会话中",
  "Loading sessions…": "正在加载会话…",
  "Failed to open folder picker": "打开文件夹选择器失败",
  Browse: "浏览",
  "Goal lifecycle controls": "Goal 生命周期控制",
  "Pause Goal": "暂停 Goal",
  "Pause current Goal": "暂停当前 Goal",
  Pause: "暂停",
  "Resume Goal": "恢复 Goal",
  "Resume current Goal": "恢复当前 Goal",
  Resume: "恢复",
  "Cancel Goal": "取消 Goal",
  "Cancel current Goal": "取消当前 Goal",
  "Completion criterion:": "完成条件：",
  "Global config written; new derived subagents use this model. The main session model is unchanged; idle sessions apply after reconnect, busy sessions need a later reconnect.":
    "已写入全局 [secondary_model]；新派生的子代理将使用此模型。主会话 model 不变；空闲会话重连后生效，忙碌会话需稍后重连。",
  Failed: "失败",
  "Read-only observation: Desktop does not control background tasks or Cron directly.":
    "只读观察：Desktop 不直接控制后台任务或 Cron。",
  "Output path:": "输出路径：",
  "(Waiting for the Agent to return a snapshot or completion notification)":
    "（等待 Agent 返回快照或完成通知）",
  "Failed to switch session model": "切换会话模型失败",
  "Check the ACP connection or try again later.": "请检查 ACP 连接或稍后重试。",
  "The current runtime cannot modify the session model": "当前运行时无法修改会话模型",
  "Upgrade Kimi Code or check the ACP connection.": "请升级 Kimi Code 或检查 ACP 连接。",
  "Failed to update session Thinking": "更新会话 Thinking 失败",
  "The current runtime cannot modify session Thinking": "当前运行时无法修改会话 Thinking",
  "Model binding": "模型绑定",
  "Upstream:": "上游：",
  "No model binding yet": "暂无模型绑定",
  "View a summary of providers, model bindings, and capabilities. This only validates the local structure and does not send connection tests to third-party providers.":
    "查看 Provider、模型绑定与 capabilities 摘要。此处只做本地结构校验，不会向第三方 Provider 发送连接测试。",
  "“Provider configured” only means a credential source exists in config.toml / login state; it does not mean the current session will definitely work. The actual model/thinking follows the model menu in the chat area.":
    "「Provider 已配置」只表示 config.toml / 登录状态里存在凭据来源；不等于当前会话一定可用。实际 model/thinking 以聊天区模型菜单为准。",
  "Kimi account signed in": "Kimi 账号已登录",
  "Default model:": "默认模型：",
  "No provider configured yet. Add one in the advanced editor below.":
    "尚未配置 Provider。可在下方高级编辑器中添加。",
  "Structural issue": "结构问题",
  "Kimi Code configuration required": "需要完成 Kimi Code 配置",
  "Open configuration settings": "打开配置设置",
  "Failed to update Secondary model": "更新 Secondary model 失败",
  "Failed to clear Secondary model": "清除 Secondary model 失败",
  "Failed to update Secondary thinking effort": "更新 Secondary 思考档位失败",
  "Failed to enable custom subagents": "开启自定义子代理失败",
  "Failed to disable custom subagents": "关闭自定义子代理失败",
  "Experimental features": "实验功能",
  "Custom Agent discovery": "自定义 Agent 发现",
  "Saved locally in this desktop app only. When enabled, scans custom Agents; when disabled, Plugins, Skills, and running agent tasks are still kept.":
    "仅在此桌面应用本地保存。开启后扫描自定义 Agent；关闭时仍保留 Plugins、Skills 和运行中代理任务。",
  "Global defaults for new sessions. The actual model/thinking of a connected session follows the model menu in the chat area; add or edit model definitions in Config.":
    "新会话的全局默认。当前已连接会话的实际 model/thinking 以聊天区模型菜单为准；在 Config 中添加或编辑模型定义。",
  "Secondary model (experimental)": "Secondary model（实验）",
  "Enable custom subagents": "启用自定义子代理",
  "Enable [experimental].secondary-model and write [secondary_model].model at the same time; defaults to the current global model.":
    "同时开启 [experimental].secondary-model 并写入 [secondary_model].model；默认沿用当前全局模型。",
  "Custom subagents enabled; default model:": "自定义子代理已开启，默认模型为：",
  "Custom subagents disabled": "自定义子代理已关闭",
  "No configured model available": "未配置可用模型",
  "Default model for subagents": "子代理默认模型",
  "(Not configured)": "（未配置）",
  "Corresponds to the official `/secondary_model` and `[secondary_model].model`; not the session model switch in the chat area.":
    "对应官方 `/secondary_model` 与 `[secondary_model].model`；不是聊天区的会话 model 切换。",
  "The experiment flag and model alias are written to global config.toml; newly derived subagents use this model. The main session model is unchanged; idle sessions apply after reconnect, busy sessions need a later reconnect.":
    "实验开关与模型 alias 均写入全局 config.toml；新派生的子代理将使用此模型。主会话 model 不变；空闲会话重连后生效，忙碌会话需稍后重连。",
  "Currently overridden by the KIMI_SECONDARY_MODEL environment variable for the config.toml display value.":
    "当前由环境变量 KIMI_SECONDARY_MODEL 覆盖 config.toml 显示值。",
  "The current secondary model is not resolved in `[models]`; new subagents will bind only after saving a valid alias.":
    "当前 secondary model 未在 `[models]` 中解析，保存合法 alias 后新子代理才会绑定。",
  "Secondary thinking effort": "Secondary 思考档位",
  "Currently overridden by the KIMI_SECONDARY_EFFORT environment variable for the config.toml display value.":
    "当前由环境变量 KIMI_SECONDARY_EFFORT 覆盖 config.toml 显示值。",
  "Advanced: edit the full config.toml directly. Only TOML structure is validated before saving; idle sessions restart to apply after saving.":
    "高级：直接编辑完整 config.toml。保存前仅做 TOML 结构校验；保存后空闲会话会重启以应用。",
  "The current session has no AI reply to copy": "当前会话还没有可复制的 AI 回复",
  "Last AI reply copied": "已复制最后一条 AI 回复",
  "Copy failed": "复制失败",
  "Export Markdown is only available in the desktop app": "导出 Markdown 仅在桌面应用中可用",
  "Session exported": "会话已导出",
  "Export failed": "导出失败",
  "Export Markdown…": "导出 Markdown…",
  "Running tasks": "运行中任务",
  "Session influence factors": "会话影响因素",
  "Refresh influence factors": "刷新影响因素",
  "Custom Agent discovery is off; Plugins, Skills, and running agent tasks are still kept.":
    "自定义 Agent 发现已关闭；Plugins、Skills 和运行中代理任务仍会保留。",
  Detected: "检测到",
  ": may permanently override the main Agent system prompt (body is hidden by default).":
    "：可能永久覆盖主 Agent 系统提示词（正文默认不展示）。",
  "No installed plugin metadata found": "未发现已安装 plugin 元数据",
  "No disk Skill found": "未发现磁盘 Skill",
  plus: "另有",
  "Skill(s) not expanded": "个 Skill 未展开",
  Disk: "磁盘",
  "Enabled by config": "配置启用",
  "Same-name lower-priority source:": "同名低优先级来源：",
  "Disk ·": "磁盘 ·",
  "Background tasks (read-only)": "后台任务（只读）",
  "From Task/TaskOutput results the Agent has observed; Desktop does not provide direct stop or control.":
    "来自 Agent 已观察到的 Task/TaskOutput 结果；Desktop 不提供直接停止或控制。",
  "Cron schedules (cached)": "Cron 调度（缓存）",
  "Only shows CronCreate/CronList results the Agent has returned; no Desktop control API.":
    "仅展示 Agent 已返回的 CronCreate/CronList 结果；无 Desktop 控制 API。",
  "Next:": "下次：",
  "Edit model configuration": "编辑模型配置",
  "Structured changes are written to a local draft; config.toml updates only after saving.":
    "结构化修改只会写入本地草稿；点保存后才更新 config.toml。",
  "Add Provider": "添加 Provider",
  "Loading config.toml…": "加载 config.toml 中…",
  "Structured configuration cannot be safely edited right now; switch to the advanced config.toml editor or retry reading.":
    "当前无法安全编辑结构化配置；请转用高级 config.toml 编辑器或重试读取。",
  "Retry reading": "重试读取",
  "No Provider added yet": "尚未添加 Provider",
  "Delete Provider": "删除 Provider",
  "Provider name": "Provider 名称",
  "Provider Type": "Provider 类型",
  "Shown as a password; it will not appear in summaries, prompts, or logs.":
    "密码形式显示；不会出现在摘要、提示或日志中。",
  "Environment variables (TOML)": "环境变量（TOML）",
  "Custom Headers (TOML)": "自定义 Headers（TOML）",
  "This is a built-in Kimi Code Provider; its name, type, and deletion are protected, but its connection configuration can still be overridden.":
    "这是 Kimi Code 内置 Provider；名称、类型和删除操作受到保护，但仍可覆盖连接配置。",
  "Nested Provider settings detected; they will be preserved when editing fields on this page.":
    "已检测到嵌套 Provider 设置；编辑本页字段时会保留它们。",
  "Select or add a Provider to edit its connection configuration.":
    "选择或添加一个 Provider 后编辑其连接配置。",
  "No models for this Provider yet": "此 Provider 暂无模型",
  Default: "默认",
  "Delete model": "删除模型",
  "Model alias": "模型别名",
  "Model Provider": "模型 Provider",
  "Upstream model": "上游模型",
  "Wire protocol": "线路协议",
  "Leave empty for auto-detection; set it explicitly when the wire protocol cannot be inferred.":
    "留空表示自动推断；无法推断线路协议时需显式设置。",
  "(Auto)": "（自动推断）",
  "Supported thinking efforts": "支持的思考档位",
  "Comma-separated, for example low, high, max.": "以逗号分隔，例如 low, high, max。",
  "Default thinking effort": "默认思考档位",
  "When not set, the current model or Kimi Code selects the default effort.":
    "未设置时，由当前模型或 Kimi Code 选择默认档位。",
  "(Not set)": "（未设置）",
  "(Current value, not listed among supported options)": "（当前值，未列入支持项）",
  "Select or add a model to edit its definition.": "选择或添加模型后编辑其定义。",
  "Deleting the current default model automatically switches to another configured model.":
    "删除当前默认模型时会自动切换到另一个已配置模型。",
  "(No models yet)": "（尚无模型）",
  "Structured Provider / model configuration": "结构化 Provider / 模型配置",
  "After saving successfully, the Provider summary and other global configuration consumers will refresh.":
    "保存成功后将刷新 Provider 摘要和其他全局配置消费者。",
  "Back to summary": "返回摘要",
  "No Provider configured yet. Add one in the structured or advanced editor below.":
    "尚未配置 Provider。可在下方结构化编辑器或高级编辑器中添加。",
  "Update available": "可更新",
  "Read failed; the current content will not be saved.": "读取失败，当前内容不会被保存。",
};

const EN_US_RESTORE_TRANSLATIONS = Object.entries(ZH_CN_TRANSLATIONS).reduce<
  Record<string, string>
>((restoreMap, [english, chinese]) => {
  restoreMap[chinese] ??= english;
  return restoreMap;
}, {});

const TRANSLATABLE_ATTRIBUTES = ["aria-label", "title", "placeholder", "alt"] as const;

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

  const olderMessagesMatch = core.match(/^Load earlier messages \((\d+) remaining\)$/);
  if (olderMessagesMatch) {
    return `加载更早消息（剩余 ${olderMessagesMatch[1]} 条）`;
  }

  return null;
}

export function translateUiString(value: string, language: ResolvedUiLanguage): string {
  if (language !== "zh-CN") {
    return restoreUiString(value);
  }

  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const core = value.replace(/\s+/g, " ").trim();
  const translated = translateCore(core);

  return translated ? `${leading}${translated}${trailing}` : value;
}

function restoreCore(core: string): string | null {
  if (core === "展开全部") {
    return "Expand all";
  }
  if (core === "收起") {
    return "Collapse";
  }
  if (core === "显示完整输出") {
    return "Show full output";
  }

  const direct = EN_US_RESTORE_TRANSLATIONS[core];
  if (direct) {
    return direct;
  }

  const olderMessagesMatch = core.match(/^加载更早消息（剩余 (\d+) 条）$/);
  if (olderMessagesMatch) {
    return `Load earlier messages (${olderMessagesMatch[1]} remaining)`;
  }

  const truncatedOutputMatch = core.match(/^输出已截断（共 (\d+) 行）$/);
  if (truncatedOutputMatch) {
    return `Output truncated (${truncatedOutputMatch[1]} lines)`;
  }

  return null;
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

  return Boolean(element.closest("[data-kimi-i18n-skip], code, pre, script, style, textarea"));
}

function shouldSkipAttributeElement(element: Element): boolean {
  return Boolean(element.closest("[data-kimi-i18n-skip], code, pre, script, style"));
}

function applyTextNodeTranslation(node: Text, language: ResolvedUiLanguage): void {
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

function getAttributeRecord(element: Element, attribute: string): AttributeRecord | undefined {
  return attributeRecords.get(element)?.get(attribute);
}

function setAttributeRecord(element: Element, attribute: string, record: AttributeRecord): void {
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

function applyElementTranslation(root: Element, language: ResolvedUiLanguage): void {
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

export function UiLanguageProvider({ children }: { children: ReactNode }) {
  const [uiLanguage, setUiLanguageState] = useState<UiLanguage>(getInitialUiLanguage);
  const [systemLanguage, setSystemLanguage] = useState<ResolvedUiLanguage>(getSystemLanguage);

  const resolvedLanguage = useMemo(
    () => (uiLanguage === "system" ? systemLanguage : uiLanguage),
    [systemLanguage, uiLanguage],
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
    if (typeof window === "undefined" || uiLanguage !== "system") {
      return;
    }

    const handleLanguageChange = () => {
      setSystemLanguage(getSystemLanguage());
    };
    window.addEventListener("languagechange", handleLanguageChange);
    return () => window.removeEventListener("languagechange", handleLanguageChange);
  }, [uiLanguage]);

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
