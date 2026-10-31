// dsh-runner 宿主侧配置存储（配置模型 version 2）。
//
// 数据流：AI Tool / 浏览器设置页 -> 本文件的 CRUD -> commands.json
//         进程启动时由 index.js 读取，runner 只消费归一化后的命令对象。
//
// 约定（与 SPEC 第 1 节一致）：
//   - 配置文件固定 ~/.dsh/dsh-runner/commands.json，没有环境变量覆盖、没有旧路径迁移。
//   - 加载时非法命令丢弃并返回错误说明（由 Host 记日志）；保存时整份配置必须合法，非法直接抛错。
//   - 归一化时忽略未知字段（旧文件里的 terminalTitle/utf8CodePage/longRunning 等直接丢弃，不回写）。
//   - 可选字段的缺省值不是兼容分支：env/ports/readyPort/readyTimeoutMs/dependsOn/enabled。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const CONFIG_VERSION = 2;
const DEFAULT_READY_TIMEOUT_MS = 120000;
const MIN_READY_TIMEOUT_MS = 1000;
const MAX_READY_TIMEOUT_MS = 1800000;
const MAX_PORT = 65535;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPES = new Set(["project", "global"]);

/** 配置校验错误（调用方据此返回 bad-request；普通 I/O 错误不会用它）。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

let tempCounter = 0;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function makeId(existingIds) {
  for (;;) {
    const id = "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    if (existingIds === undefined || !existingIds.has(id)) return id;
  }
}

/**
 * 路径比较用归一化：统一反斜杠、去掉末尾斜杠、小写。
 * 只用于比较，不用于存储。
 */
export function normalizePath(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}

/**
 * 存储用路径形态：统一反斜杠、去掉非根目录的末尾斜杠、保留大小写。
 * 盘符根目录保留为 "H:\"，与 normalizePath 的 "h:" 不同（后者只用于比较）。
 */
export function cleanProjectPath(value) {
  const text = String(value === undefined || value === null ? "" : value).trim().replace(/\//g, "\\");
  if (text === "") return "";
  if (/^[a-zA-Z]:\\?$/.test(text)) return text.slice(0, 2) + "\\";
  return text.replace(/\\+$/g, "");
}

/** 是否绝对路径（Windows 盘符/UNC/根路径都算；相对路径拒绝）。 */
function isAbsolutePath(value) {
  return typeof value === "string" && value !== "" && path.isAbsolute(value);
}

function normalizeEnv(raw) {
  if (raw === undefined || raw === null) return { env: {} };
  if (!isPlainObject(raw)) return { error: "env 必须是对象（Record<string,string>）" };
  const env = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      return { error: "env 键不合法：" + key + "（必须匹配 " + ENV_KEY_PATTERN.source + "）" };
    }
    if (typeof value !== "string") {
      return { error: "env[" + key + "] 必须是字符串（数字/布尔请由调用方转成字符串）" };
    }
    env[key] = value;
  }
  return { env };
}

function normalizePorts(raw) {
  if (raw === undefined || raw === null) return { ports: [] };
  if (!Array.isArray(raw)) return { error: "ports 必须是整数数组" };
  const ports = [];
  for (const value of raw) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_PORT) {
      return { error: "ports 的每一项必须是 0–" + MAX_PORT + " 的整数（收到 " + String(value) + "）" };
    }
    if (ports.indexOf(value) === -1) ports.push(value);
  }
  return { ports };
}

function normalizeReadyPort(raw, ports) {
  if (raw === undefined || raw === null) return { readyPort: null };
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_PORT) {
    return { error: "readyPort 必须是 0–" + MAX_PORT + " 的整数或 null" };
  }
  if (ports.indexOf(raw) === -1) {
    return { error: "readyPort " + raw + " 必须出现在 ports 里" };
  }
  return { readyPort: raw };
}

function normalizeReadyTimeoutMs(raw) {
  if (raw === undefined || raw === null) return { readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS };
  if (!Number.isInteger(raw) || raw < MIN_READY_TIMEOUT_MS || raw > MAX_READY_TIMEOUT_MS) {
    return { error: "readyTimeoutMs 必须是 " + MIN_READY_TIMEOUT_MS + "–" + MAX_READY_TIMEOUT_MS + " 的整数" };
  }
  return { readyTimeoutMs: raw };
}

function normalizeDependsOn(raw, selfId) {
  if (raw === undefined || raw === null) return { dependsOn: [] };
  if (!Array.isArray(raw)) return { error: "dependsOn 必须是命令 id 数组" };
  const dependsOn = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.trim() === "") {
      return { error: "dependsOn 的每一项必须是非空命令 id" };
    }
    const id = value.trim();
    if (id === selfId) return { error: "dependsOn 不能包含自身" };
    if (dependsOn.indexOf(id) === -1) dependsOn.push(id);
  }
  return { dependsOn };
}

/**
 * 把单个命令对象归一化成稳定结构。
 * 返回 {command} 或 {error}（error 是可读的非法原因）。
 * allCommands 传入时额外校验 dependsOn 引用存在性；整个配置的环检测在 normalizeConfigDetailed 里做。
 */
function normalizeCommandDetailed(raw, allCommands) {
  if (!isPlainObject(raw)) return { error: "命令必须是对象" };
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title === "") return { error: "title 必须是非空字符串" };
  const commandText = typeof raw.command === "string" ? raw.command.trim() : "";
  if (commandText === "") return { error: "command 必须是非空字符串" };
  if (typeof raw.scope !== "string" || !SCOPES.has(raw.scope)) {
    return { error: "scope 必须是 \"project\" 或 \"global\"" };
  }
  const scope = raw.scope;
  const hasAllCommands = Array.isArray(allCommands);
  const existingIds = new Set(
    hasAllCommands
      ? allCommands.filter((item) => isPlainObject(item) && typeof item.id === "string").map((item) => item.id)
      : []
  );
  let id;
  if (raw.id === undefined || raw.id === null) {
    id = makeId(existingIds);
  } else if (typeof raw.id === "string" && raw.id.trim() !== "") {
    id = raw.id.trim();
  } else {
    return { error: "id 必须是非空字符串" };
  }

  let projectRoot = "";
  if (scope === "project") {
    if (raw.projectRoot !== undefined && raw.projectRoot !== null && typeof raw.projectRoot !== "string") {
      return { error: "projectRoot 必须是字符串" };
    }
    projectRoot = cleanProjectPath(raw.projectRoot);
    if (projectRoot === "") return { error: "项目作用域命令必须提供 projectRoot" };
    if (!isAbsolutePath(projectRoot)) return { error: "projectRoot 必须是绝对路径：" + projectRoot };
  }

  if (raw.cwd !== undefined && raw.cwd !== null && typeof raw.cwd !== "string") {
    return { error: "cwd 必须是字符串" };
  }
  const cwdRaw = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
  const cwd = cwdRaw === "" ? "" : cleanProjectPath(cwdRaw);
  if (cwd !== "" && !isAbsolutePath(cwd)) return { error: "cwd 必须是绝对路径或空字符串：" + cwd };

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return { error: "enabled 必须是布尔值" };
  }
  const enabled = raw.enabled !== false;

  const envResult = normalizeEnv(raw.env);
  if (envResult.error !== undefined) return { error: envResult.error };
  const portsResult = normalizePorts(raw.ports);
  if (portsResult.error !== undefined) return { error: portsResult.error };
  const readyPortResult = normalizeReadyPort(raw.readyPort, portsResult.ports);
  if (readyPortResult.error !== undefined) return { error: readyPortResult.error };
  const timeoutResult = normalizeReadyTimeoutMs(raw.readyTimeoutMs);
  if (timeoutResult.error !== undefined) return { error: timeoutResult.error };
  const dependsResult = normalizeDependsOn(raw.dependsOn, id);
  if (dependsResult.error !== undefined) return { error: dependsResult.error };

  if (hasAllCommands) {
    for (const dependencyId of dependsResult.dependsOn) {
      if (!existingIds.has(dependencyId)) {
        return { error: "dependsOn 引用了不存在的命令：" + dependencyId };
      }
    }
  }

  return {
    command: {
      id: id,
      title: title,
      command: commandText,
      cwd: cwd,
      scope: scope,
      projectRoot: projectRoot,
      enabled: enabled,
      env: envResult.env,
      ports: portsResult.ports,
      readyPort: readyPortResult.readyPort,
      readyTimeoutMs: timeoutResult.readyTimeoutMs,
      dependsOn: dependsResult.dependsOn
    }
  };
}

/** 归一化单条命令；非法返回 null。allCommands 用于 dependsOn 存在性校验。 */
export function normalizeCommand(raw, allCommands) {
  const detailed = normalizeCommandDetailed(raw, allCommands);
  return detailed.error === undefined ? detailed.command : null;
}

/** 找出所有处于依赖环里的命令 id。 */
function findCyclicIds(commands) {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const state = new Map(); // 0/未访问、1/访问中、2/已完成
  const cyclic = new Set();
  const visit = (id, stack) => {
    const current = state.get(id) || 0;
    if (current === 1) {
      const index = stack.indexOf(id);
      for (let position = index; position < stack.length; position += 1) cyclic.add(stack[position]);
      return;
    }
    if (current === 2) return;
    state.set(id, 1);
    stack.push(id);
    const command = byId.get(id);
    if (command !== undefined) {
      for (const dependencyId of command.dependsOn) visit(dependencyId, stack);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const command of commands) visit(command.id, []);
  return cyclic;
}

/**
 * 整份配置归一化。
 * strict=true 时遇到任何非法直接抛 ConfigError（保存用）；
 * strict=false 时丢弃非法命令并把原因写进 errors（加载用）。
 */
function normalizeConfigDetailed(raw, strict) {
  const fail = (message) => {
    if (strict) throw new ConfigError(message);
    errors.push(message);
  };
  const errors = [];
  if (!isPlainObject(raw)) {
    fail("配置根节点必须是对象");
    return { config: defaultConfig(), errors: errors };
  }

  const rawCommands = raw.commands;
  if (rawCommands !== undefined && rawCommands !== null && !Array.isArray(rawCommands)) {
    fail("commands 必须是数组");
  }
  const entries = Array.isArray(rawCommands) ? rawCommands : [];

  const commands = [];
  const seenIds = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const detailed = normalizeCommandDetailed(entries[index]);
    if (detailed.error !== undefined) {
      fail("第 " + (index + 1) + " 条命令已丢弃：" + detailed.error);
      continue;
    }
    if (seenIds.has(detailed.command.id)) {
      fail("第 " + (index + 1) + " 条命令的 id 重复：" + detailed.command.id);
      continue;
    }
    seenIds.add(detailed.command.id);
    commands.push(detailed.command);
  }

  // dependsOn 引用缺失 / 环：反复清理直到稳定（删除命令会让依赖它的命令也变非法）。
  for (;;) {
    let changed = false;
    const ids = new Set(commands.map((command) => command.id));
    const referencedOk = [];
    for (const command of commands) {
      const missing = command.dependsOn.find((dependencyId) => !ids.has(dependencyId));
      if (missing !== undefined) {
        fail("命令「" + command.title + "」的 dependsOn 引用了不存在的命令：" + missing);
        changed = true;
        continue;
      }
      referencedOk.push(command);
    }
    commands.length = 0;
    commands.push(...referencedOk);

    const cyclic = findCyclicIds(commands);
    if (cyclic.size > 0) {
      const labels = [...cyclic].join("、");
      fail("dependsOn 存在环，涉及命令：" + labels);
      const remaining = commands.filter((command) => !cyclic.has(command.id));
      commands.length = 0;
      commands.push(...remaining);
      changed = true;
    }

    // 端口契约：同一作用域（同一 projectRoot / 全局）内端口不允许重复声明。
    const portConflicts = findDuplicatePortCommands(commands);
    if (portConflicts.length > 0) {
      for (const conflict of portConflicts) {
        fail("命令「" + conflict.command.title + "」的端口 " + String(conflict.port)
          + " 与「" + conflict.owner.title + "」在同一作用域重复，已丢弃该命令");
      }
      const dropped = new Set(portConflicts.map((conflict) => conflict.command.id));
      const remaining = commands.filter((command) => !dropped.has(command.id));
      commands.length = 0;
      commands.push(...remaining);
      changed = true;
    }
    if (!changed) break;
  }

  const uiRaw = raw.ui;
  let visible = true;
  if (uiRaw !== undefined && uiRaw !== null) {
    if (!isPlainObject(uiRaw)) {
      fail("ui 必须是对象");
    } else if (uiRaw.visible !== undefined) {
      if (typeof uiRaw.visible !== "boolean") fail("ui.visible 必须是布尔值");
      else visible = uiRaw.visible;
    }
  }

  return {
    config: {
      version: CONFIG_VERSION,
      ui: { visible: visible },
      commands: commands
    },
    errors: errors
  };
}

/**
 * 端口契约：同一作用域内端口只能声明一次。
 * 作用域 = project 作用域的 projectRoot，或 global。
 */
function findDuplicatePortCommands(commands) {
  const seen = new Map();
  const conflicts = [];
  for (const command of commands) {
    const scopeKey = command.scope === "project" ? "project:" + normalizePath(command.projectRoot) : "global";
    let duplicatedPort;
    let owner;
    for (const port of command.ports) {
      const key = scopeKey + "|" + String(port);
      const existing = seen.get(key);
      if (existing !== undefined && duplicatedPort === undefined) {
        duplicatedPort = port;
        owner = existing;
      }
    }
    if (duplicatedPort !== undefined) {
      conflicts.push({ command: command, port: duplicatedPort, owner: owner });
      continue;
    }
    for (const port of command.ports) seen.set(scopeKey + "|" + String(port), command);
  }
  return conflicts;
}

/** 整份配置归一化（加载语义：非法命令丢弃）。 */
export function normalizeConfig(raw) {
  return normalizeConfigDetailed(raw, false).config;
}

/** 默认配置：空命令列表 + 运行按钮显示（不再内置任何默认命令）。 */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    ui: { visible: true },
    commands: []
  };
}

/**
 * 读取配置文件。
 * - 文件不存在：{exists:false, config:默认空配置, errors:[]}
 * - JSON 损坏 / 根节点不是对象：抛错（不静默兜底）
 * - 非法命令：丢弃并放进 errors（由调用方记日志）
 */
export async function loadConfig(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error !== null && error !== undefined && error.code === "ENOENT") {
      return { exists: false, config: defaultConfig(), errors: [] };
    }
    throw new Error("读取配置文件失败：" + filePath + "：" + (error instanceof Error ? error.message : String(error)));
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("配置文件不是合法 JSON：" + filePath + "：" + (error instanceof Error ? error.message : String(error)));
  }
  if (!isPlainObject(parsed)) {
    throw new Error("配置文件根节点必须是对象：" + filePath);
  }
  const detailed = normalizeConfigDetailed(parsed, false);
  return { exists: true, config: detailed.config, errors: detailed.errors };
}

/** 整份配置严格校验；非法抛 ConfigError，合法返回归一化后的配置。 */
export function validateConfig(raw) {
  return normalizeConfigDetailed(raw, true).config;
}

/** 原子写入配置文件（严格校验；非法直接抛错，不写盘）。 */
export async function saveConfigFile(filePath, raw) {
  const config = validateConfig(raw);
  await mkdir(path.dirname(filePath), { recursive: true });
  tempCounter += 1;
  const tempPath = filePath + "." + String(process.pid) + "." + String(tempCounter) + ".tmp";
  await writeFile(tempPath, JSON.stringify(config, null, 2), "utf8");
  await rename(tempPath, filePath);
  return config;
}

/** 从命令文本生成默认标题（AI 只给 command 时用）。 */
function defaultTitle(command) {
  const value = String(command === undefined || command === null ? "" : command).trim();
  if (value === "") return "启动命令";
  return value.length > 24 ? value.slice(0, 24) : value;
}

/**
 * 新增命令。
 * scope 默认 project（有 workspacePath 时）否则 global；project 的 projectRoot 默认 workspacePath；
 * cwd 默认 projectRoot（global 默认空，运行时用当前项目路径）。
 */
export function createCommand(config, input, workspacePath) {
  if (!isPlainObject(input)) throw new ConfigError("create 需要参数对象");
  const commandText = typeof input.command === "string" ? input.command.trim() : "";
  if (commandText === "") throw new ConfigError("create 需要 command（要执行的命令）");
  if (input.scope !== undefined && (typeof input.scope !== "string" || !SCOPES.has(input.scope))) {
    throw new ConfigError("scope 必须是 \"project\" 或 \"global\"");
  }
  const workspace = typeof workspacePath === "string" && workspacePath.trim() !== ""
    ? cleanProjectPath(workspacePath)
    : "";
  const scope = input.scope !== undefined ? input.scope : (workspace !== "" ? "project" : "global");

  if (scope === "project" && input.projectRoot !== undefined && input.projectRoot !== null && typeof input.projectRoot !== "string") {
    throw new ConfigError("projectRoot 必须是字符串");
  }
  let projectRoot = "";
  if (scope === "project") {
    projectRoot = cleanProjectPath(input.projectRoot);
    if (projectRoot === "") projectRoot = workspace;
    if (projectRoot === "") {
      throw new ConfigError("项目作用域需要 projectRoot：请从当前工作区调用，或显式传 projectRoot");
    }
  }

  if (input.cwd !== undefined && input.cwd !== null && typeof input.cwd !== "string") {
    throw new ConfigError("cwd 必须是字符串");
  }
  const cwdInput = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const cwd = cwdInput !== "" ? cleanProjectPath(cwdInput) : (scope === "project" ? projectRoot : "");

  const title = typeof input.title === "string" && input.title.trim() !== "" ? input.title : defaultTitle(commandText);
  const candidate = {
    id: makeId(new Set(config.commands.map((command) => command.id))),
    title: title,
    command: commandText,
    cwd: cwd,
    scope: scope,
    projectRoot: projectRoot,
    enabled: input.enabled,
    env: input.env,
    ports: input.ports,
    readyPort: input.readyPort,
    readyTimeoutMs: input.readyTimeoutMs,
    dependsOn: input.dependsOn
  };
  const detailed = normalizeCommandDetailed(candidate, config.commands);
  if (detailed.error !== undefined) throw new ConfigError("命令不合法：" + detailed.error);
  const next = { ...config, commands: config.commands.concat([detailed.command]) };
  return { config: validateConfig(next), command: detailed.command };
}

/** 按 id 或标题查找命令（RPC 用 id；Tool 允许用标题给 AI 兜底）。 */
export function findCommand(config, idOrTitle) {
  const key = String(idOrTitle === undefined || idOrTitle === null ? "" : idOrTitle).trim();
  if (key === "") return undefined;
  const byId = config.commands.find((command) => command.id === key);
  if (byId !== undefined) return byId;
  const folded = key.toLowerCase();
  return config.commands.find((command) => command.title.toLowerCase() === folded);
}

/** 修改命令；id 不可改，未提供的字段保持原值。 */
export function updateCommand(config, id, patch) {
  const target = findCommand(config, id);
  if (target === undefined) throw new ConfigError("找不到要修改的命令：" + String(id));
  if (!isPlainObject(patch)) throw new ConfigError("update 需要 patch 对象");
  const merged = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.id = target.id;
  const detailed = normalizeCommandDetailed(merged, config.commands);
  if (detailed.error !== undefined) throw new ConfigError("修改后的命令不合法：" + detailed.error);
  const next = {
    ...config,
    commands: config.commands.map((command) => (command.id === target.id ? detailed.command : command))
  };
  return { config: validateConfig(next), command: detailed.command };
}

/**
 * 删除命令；同时从其它命令的 dependsOn 里移除被删 id（否则整份配置会因悬空依赖而非法）。
 * 这是契约未明说的必要行为，报告里会注明。
 */
export function deleteCommand(config, id) {
  const target = findCommand(config, id);
  if (target === undefined) throw new ConfigError("找不到要删除的命令：" + String(id));
  const commands = config.commands
    .filter((command) => command.id !== target.id)
    .map((command) => {
      if (command.dependsOn.indexOf(target.id) === -1) return command;
      return { ...command, dependsOn: command.dependsOn.filter((dependencyId) => dependencyId !== target.id) };
    });
  return { config: validateConfig({ ...config, commands: commands }), command: target };
}

/** 重排命令；ids 必须是现有 id 的完整排列。 */
export function reorderCommands(config, ids) {
  if (!Array.isArray(ids)) throw new ConfigError("reorder 需要 ids 数组");
  const currentIds = config.commands.map((command) => command.id);
  if (ids.length !== currentIds.length) {
    throw new ConfigError("reorder 的 ids 必须是现有命令 id 的完整排列");
  }
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== "string" || currentIds.indexOf(id) === -1) {
      throw new ConfigError("reorder 的 ids 包含未知命令：" + String(id));
    }
    if (seen.has(id)) throw new ConfigError("reorder 的 ids 有重复：" + id);
    seen.add(id);
  }
  const byId = new Map(config.commands.map((command) => [command.id, command]));
  return { config: { ...config, commands: ids.map((id) => byId.get(id)) } };
}

/** 设置 UI 状态（只接受布尔 visible）。 */
export function setUi(config, patch) {
  if (!isPlainObject(patch)) throw new ConfigError("ui 需要 {visible} 对象");
  if (patch.visible === undefined) throw new ConfigError("ui 需要 visible（布尔值）");
  if (typeof patch.visible !== "boolean") throw new ConfigError("visible 必须是布尔值");
  return { config: { ...config, ui: { visible: patch.visible } } };
}
