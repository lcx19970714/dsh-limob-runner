// dsh-runner 的宿主侧配置存储（不依赖 DSH 运行时，方便离线测试）。
//
// 为什么需要它：
//   浏览器端插件的配置原本只存在 localStorage 里，AI（Host 侧的 Agent）看不到；
//   为了让 AI 能直接创建/修改运行命令，把配置改存到 Host 侧 JSON 文件，
//   浏览器通过 RPC 读写同一个文件，AI 通过 Tool 读写同一个文件。
//
// 数据流：AI Tool / 浏览器设置页  ->  本文件的 CRUD  ->  commands.json
//         启动时浏览器 RPC config/get 读取它，写操作 RPC config/save 回写它。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const CONFIG_VERSION = 1;

// 与 client.js 的 BUILTIN_COMMANDS 保持一致（同一份默认命令的宿主侧副本）。
// 为什么保留副本：Host 与浏览器是两个独立的 JS 运行时，无法共享同一个模块；
// 修改默认命令时两边要一起改（README 的「开发与测试」里会提醒）。
const BUILTIN_COMMANDS = [
  {
    id: "dev",
    title: "开发调试",
    terminalTitle: "Limob-dev",
    cwd: "H:\\Limob-windows",
    command: "pnpm 客户端-调试",
    scope: "global",
    projectRoot: "",
    enabled: true,
    utf8CodePage: true,
    longRunning: true
  },
  {
    id: "cargo-check",
    title: "Rust 检查（cargo check）",
    terminalTitle: "Limob-cargo-check",
    cwd: "H:\\Limob-windows\\src-tauri",
    command: "cargo check",
    scope: "global",
    projectRoot: "",
    enabled: true,
    utf8CodePage: false,
    longRunning: false
  },
  {
    id: "build-debug",
    title: "快速构建（tauri build --debug）",
    terminalTitle: "Limob-build-debug",
    cwd: "H:\\Limob-windows",
    command: "pnpm exec tauri build --debug --no-bundle",
    scope: "global",
    projectRoot: "",
    enabled: true,
    utf8CodePage: true,
    longRunning: true
  },
  {
    id: "build-release",
    title: "正式构建（pnpm 构建桌面端）",
    terminalTitle: "Limob-build-release",
    cwd: "H:\\Limob-windows",
    command: "pnpm 构建桌面端",
    scope: "global",
    projectRoot: "",
    enabled: true,
    utf8CodePage: true,
    longRunning: true
  }
];

/** 新建命令的稳定 id（只要求不重复，不参与业务判断）。 */
function makeId() {
  return "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** 默认配置：4 条内置全局命令 + 运行按钮显示。 */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    commands: BUILTIN_COMMANDS.map((command) => Object.assign({}, command)),
    ui: { visible: true }
  };
}

/** 路径比较用的归一化：统一反斜杠、去掉末尾斜杠、小写。 */
export function normalizePath(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}

/** 存储用的项目路径形态：保留大小写，统一反斜杠，去掉非根目录的末尾斜杠。 */
export function cleanProjectPath(value) {
  const text = String(value === undefined || value === null ? "" : value).trim().replace(/\//g, "\\");
  if (text === "") return "";
  if (/^[a-zA-Z]:\\?$/.test(text)) return text.replace(/\\+$/g, "") + "\\";
  return text.replace(/\\+$/g, "");
}

/**
 * 把任意来源（AI 参数、旧 JSON、浏览器配置）的命令对象收敛成稳定结构。
 * 返回 null 表示这条命令不合法（缺名称/命令，或者项目作用域缺项目路径）。
 */
export function normalizeCommand(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (title === "" || command === "") return null;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : makeId();
  const scope = raw.scope === "project" ? "project" : "global";
  const projectRoot = cleanProjectPath(typeof raw.projectRoot === "string" ? raw.projectRoot : "");
  if (scope === "project" && projectRoot === "") return null;
  const cwd = typeof raw.cwd === "string" && raw.cwd.trim() !== ""
    ? cleanProjectPath(raw.cwd)
    : (scope === "project" ? projectRoot : "");
  return {
    id: id,
    title: title,
    terminalTitle: typeof raw.terminalTitle === "string" ? raw.terminalTitle.trim() : "",
    cwd: cwd,
    command: command,
    scope: scope,
    projectRoot: scope === "project" ? projectRoot : "",
    enabled: raw.enabled !== false,
    utf8CodePage: raw.utf8CodePage === true || /[^\x00-\x7f]/.test(command),
    longRunning: raw.longRunning === true
  };
}

/** 收敛整份配置；commands 非法项直接丢弃，保持列表可渲染。 */
export function normalizeConfig(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object") return defaultConfig();
  const commands = [];
  if (Array.isArray(raw.commands)) {
    for (const item of raw.commands) {
      const normalized = normalizeCommand(item);
      if (normalized !== null) commands.push(normalized);
    }
  }
  const ui = raw.ui !== null && typeof raw.ui === "object" ? raw.ui : {};
  return {
    version: CONFIG_VERSION,
    commands: commands,
    ui: { visible: ui.visible !== false }
  };
}

/**
 * 读取配置文件。
 * 返回 {exists, config, error?}；文件不存在时给默认配置，便于 Tool 直接 create。
 */
export async function loadConfig(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return { exists: true, config: normalizeConfig(parsed) };
  } catch (error) {
    if (error !== null && error !== undefined && error.code === "ENOENT") {
      return { exists: false, config: defaultConfig() };
    }
    return { exists: false, config: defaultConfig(), error: String(error) };
  }
}

/** 原子写入配置文件（先写临时文件再 rename，避免 AI/浏览器同时写坏 JSON）。 */
export async function saveConfigFile(filePath, raw) {
  const config = normalizeConfig(raw);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + ".tmp";
  await writeFile(tempPath, JSON.stringify(config, null, 2), "utf8");
  await rename(tempPath, filePath);
  return config;
}

/** 从命令的 title 生成默认标题（AI 只给 command 时用）。 */
function defaultTitle(command) {
  const value = String(command === undefined || command === null ? "" : command).trim();
  if (value === "") return "启动命令";
  return value.length > 24 ? value.slice(0, 24) : value;
}

/**
 * 新增命令。项目作用域的默认值来自调用方所在会话的工作区：
 * AI 在 A 项目里说“创建启动命令”，就不需要再手写 projectRoot。
 */
export function createCommand(config, input, workspacePath) {
  if (input === null || input === undefined || typeof input !== "object") {
    throw new Error("create 需要参数对象");
  }
  const commandText = typeof input.command === "string" ? input.command.trim() : "";
  if (commandText === "") throw new Error("create 需要 command（要执行的命令）");
  const workspace = typeof workspacePath === "string" && workspacePath.trim() !== ""
    ? workspacePath.trim()
    : undefined;
  const scope = input.scope === "global" ? "global" : (input.scope === "project" ? "project" : (workspace !== undefined ? "project" : "global"));
  const projectRoot = scope === "project"
    ? (typeof input.projectRoot === "string" && input.projectRoot.trim() !== "" ? input.projectRoot.trim() : (workspace || ""))
    : "";
  if (scope === "project" && projectRoot === "") {
    throw new Error("项目作用域需要 projectRoot：请从当前工作区调用，或显式传 projectRoot");
  }
  const command = normalizeCommand({
    id: makeId(),
    title: typeof input.title === "string" && input.title.trim() !== "" ? input.title : defaultTitle(commandText),
    command: commandText,
    // 全局命令默认不锁死 cwd：运行时使用当前项目路径；项目命令才默认项目目录。
    cwd: typeof input.cwd === "string" && input.cwd.trim() !== ""
      ? input.cwd
      : (scope === "project" ? (projectRoot || workspace || "") : ""),
    scope: scope,
    projectRoot: projectRoot,
    terminalTitle: input.terminalTitle,
    enabled: input.enabled !== false,
    utf8CodePage: input.utf8CodePage
  });
  if (command === null) throw new Error("命令不合法：请检查名称、工作目录和命令");
  return {
    config: Object.assign({}, config, { commands: config.commands.concat([command]) }),
    command: command
  };
}

/** 按 id 或标题查找命令（AI 通常先 list 拿到 id，也允许直接用标题）。 */
export function findCommand(config, idOrTitle) {
  const key = String(idOrTitle === undefined || idOrTitle === null ? "" : idOrTitle).trim();
  if (key === "") return undefined;
  return config.commands.find((command) => command.id === key)
    || config.commands.find((command) => command.title.toLowerCase() === key.toLowerCase());
}

/** 修改命令；未提供的字段保持原值。 */
export function updateCommand(config, idOrTitle, patch) {
  const target = findCommand(config, idOrTitle);
  if (target === undefined) throw new Error("找不到要修改的命令：" + String(idOrTitle));
  const merged = Object.assign({}, target, patch, { id: target.id });
  const normalized = normalizeCommand(merged);
  if (normalized === null) throw new Error("修改后的命令不合法：请检查名称、工作目录、命令和项目路径");
  return {
    config: Object.assign({}, config, {
      commands: config.commands.map((command) => (command.id === target.id ? normalized : command))
    }),
    command: normalized
  };
}

/** 删除命令；返回删除后的配置和被删命令，方便 Tool 汇报。 */
export function deleteCommand(config, idOrTitle) {
  const target = findCommand(config, idOrTitle);
  if (target === undefined) throw new Error("找不到要删除的命令：" + String(idOrTitle));
  return {
    config: Object.assign({}, config, {
      commands: config.commands.filter((command) => command.id !== target.id)
    }),
    command: target
  };
}
