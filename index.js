// dsh-runner 的宿主侧（Host）实现。
//
// 职责：
//   1) 配置存储的 RPC/工具入口（commands.json，配置模型 version 2）；
//   2) 项目级后台进程管理的 RPC/工具入口（ProjectRunnerService）；
//   3) 注册浏览器 RPC（POST /api/dsh-runner/<endpoint>）与两个 AI Tool：
//        dsh_runner_config —— 维护启动命令配置；
//        dsh_runner_run    —— 启动/停止/诊断长驻服务（不要用终端工具）。
//
// 单一事实来源：配置、进程状态、日志都在 Host；Client 只通过 RPC 读写。
import os from "node:os";
import path from "node:path";
import { RpcId, clientRequestSchema } from "@deepseek-ai/dsh-client-connection";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  ConfigError,
  createCommand,
  deleteCommand,
  findCommand,
  loadConfig,
  normalizePath,
  reorderCommands,
  saveConfigFile,
  setUi,
  updateCommand
} from "./host-config.js";
import { ProjectRunnerService, RunnerError, commandMatchesProject } from "./host-runner.js";

export const name = "dsh-runner";
// tools：注册 AI Tool；connection 在 apply 里按需注入（浏览器 RPC 需要）。
export const inject = ["tools"];

/** 配置文件固定位置：无环境变量覆盖、无旧路径迁移。 */
export const CONFIG_PATH = path.join(os.homedir(), ".dsh", "dsh-runner", "commands.json");

const RPC_CHANNEL = "/api";
const RPC_NAMESPACE = "dsh-runner";
const RPC_ENDPOINTS = [
  "config/get",
  "config/create",
  "config/update",
  "config/delete",
  "config/reorder",
  "config/ui",
  "project/status",
  "project/start",
  "project/stop",
  "project/restart",
  "project/startAll",
  "project/stopAll",
  "project/diagnose",
  "project/killPort",
  "project/log",
  "project/log/clear"
];

/** RPC 层结构化错误：会被转成 {ok:false, error:{code,message,details}}。 */
class RpcError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.details = details === undefined || details === null ? {} : details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error === undefined || error === null ? "" : error);
}

function reportHostError(logger, message, error) {
  const suffix = error === undefined ? "" : "：" + messageOf(error);
  const text = "dsh-runner: " + message + suffix;
  if (logger !== undefined && logger !== null && typeof logger.error === "function") {
    try {
      logger.error(text, error);
      return;
    } catch (loggingError) {
      // logger 自身失败时退回 console，保证错误至少被记录一次。
    }
  }
  // eslint-disable-next-line no-console
  console.error(text, error);
}

/** 读取配置；加载期被丢弃的非法命令逐条写 Host 日志。 */
async function loadHostConfig(logger) {
  const loaded = await loadConfig(CONFIG_PATH);
  for (const message of loaded.errors) reportHostError(logger, message);
  return loaded;
}

/** 容错读 Host 服务：插件上下文与会话上下文不一定都暴露同一个服务。 */
function getHostService(source, key) {
  try {
    if (source === null || source === undefined || typeof source.get !== "function") return undefined;
    const value = source.get(key);
    return value === undefined ? undefined : value;
  } catch (error) {
    return undefined;
  }
}

/**
 * 当前 AI 调用所在会话的「项目根路径」（用于项目作用域的默认值）。
 *
 * 第一性原理：项目作用域要匹配的是会话所属的 DSH 工作区（workspace），
 * 不是会话当前 cwd。两者可能不同（会话可能在子目录里），用 cwd 当 projectRoot
 * 会让命令只在那个子目录会话里出现。因此优先从 workspaceRegistry 反查
 * 包含该 session 的工作区，取不到再回退 cwd。
 */
function sessionWorkspacePath(exec, ctx) {
  const header = exec !== undefined && exec !== null && exec.agent !== undefined && exec.agent !== null && exec.agent.session !== undefined
    ? exec.agent.session.header
    : undefined;
  const cwd = header !== undefined && header !== null && typeof header.cwd === "string" ? header.cwd.trim() : "";
  const sessionId = header !== undefined && header !== null ? header.id : undefined;
  const sources = [
    exec !== undefined && exec !== null && exec.agent !== undefined && exec.agent !== null ? exec.agent.ctx : undefined,
    ctx
  ];
  for (const source of sources) {
    const registry = getHostService(source, "workspaceRegistry");
    if (registry === undefined || registry === null || typeof registry.list !== "function") continue;
    let workspaces;
    try {
      workspaces = registry.list();
    } catch (error) {
      // 取不到工作区列表时继续尝试下一个来源（不是吞错：下面还有 cwd 回退）。
      continue;
    }
    if (!Array.isArray(workspaces)) continue;
    if (sessionId !== undefined) {
      const owner = workspaces.find((workspace) => {
        return workspace !== null && workspace !== undefined && Array.isArray(workspace.sessionIds)
          && workspace.sessionIds.indexOf(sessionId) !== -1
          && typeof workspace.path === "string" && workspace.path !== "";
      });
      if (owner !== undefined) return owner.path;
    }
    if (cwd !== "") {
      const byPath = workspaces.find((workspace) => {
        return workspace !== null && workspace !== undefined && typeof workspace.path === "string"
          && normalizePath(workspace.path) === normalizePath(cwd);
      });
      if (byPath !== undefined) return byPath.path;
    }
  }
  return cwd !== "" ? cwd : undefined;
}

/** 把 Tool 参数里出现的命令字段收集成 patch，避免 undefined 覆盖已有值。 */
function pickCommandPatch(args) {
  const patch = {};
  const fields = [
    "title",
    "command",
    "cwd",
    "scope",
    "projectRoot",
    "enabled",
    "env",
    "ports",
    "readyPort",
    "readyTimeoutMs",
    "dependsOn"
  ];
  for (const field of fields) {
    if (args[field] !== undefined) patch[field] = args[field];
  }
  return patch;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RpcError("bad-request", field + " 必须是非空字符串", { field: field });
  }
  return value.trim();
}

function requireProjectPath(payload) {
  return requireString(payload.projectPath, "projectPath");
}

function requireCommandId(payload) {
  return requireString(payload.commandId, "commandId");
}

/** 在配置里按 id 找命令并做 not-found/disabled 判定。 */
function findRunnableCommand(config, commandId) {
  const command = config.commands.find((item) => item.id === commandId);
  if (command === undefined) throw new RpcError("not-found", "找不到命令：" + commandId, { commandId: commandId });
  if (command.enabled === false) {
    throw new RpcError("disabled", "命令「" + command.title + "」已停用", { commandId: commandId });
  }
  return command;
}

/** project 作用域命令必须覆盖当前项目路径（global 命令永远可运行）。 */
function assertCommandProject(command, projectPath) {
  if (commandMatchesProject(command, projectPath)) return;
  throw new RpcError(
    "project-mismatch",
    "命令「" + command.title + "」不属于当前项目：" + projectPath,
    { commandId: command.id, projectRoot: command.projectRoot }
  );
}

function ok(value) {
  return { ok: true, value: value };
}

function fail(code, message, details) {
  return { ok: false, error: { code: code, message: message, details: details === undefined ? {} : details } };
}

/** 把内部错误映射成 RPC 结构化错误（未知错误一律 internal）。 */
function toRpcError(error) {
  if (error instanceof RpcError) return error;
  if (error instanceof ConfigError) return new RpcError("bad-request", error.message);
  if (error instanceof RunnerError) return new RpcError(error.code, error.message, error.details);
  return new RpcError("internal", messageOf(error));
}

/**
 * RPC 分派。
 * project/* 入口先 await runner.init()（启动对账），避免漏掉上次 Host 留下的运行中进程。
 */
async function dispatch(runner, endpoint, payload, logger) {
  if (endpoint.indexOf("project/") === 0) await runner.init();
  const data = payload === undefined || payload === null ? {} : payload;
  if (!isPlainObject(data)) throw new RpcError("bad-request", endpoint + " 需要对象参数");

  if (endpoint === "config/get") {
    const loaded = await loadHostConfig(logger);
    return { config: loaded.config, filePath: CONFIG_PATH };
  }
  if (endpoint === "config/create") {
    if (!isPlainObject(data.command)) throw new RpcError("bad-request", "config/create 需要 {command}");
    const loaded = await loadHostConfig(logger);
    const created = createCommand(loaded.config, data.command);
    const saved = await saveConfigFile(CONFIG_PATH, created.config);
    return { config: saved, command: findCommand(saved, created.command.id) };
  }
  if (endpoint === "config/update") {
    const commandId = requireString(data.id, "id");
    if (!isPlainObject(data.patch)) throw new RpcError("bad-request", "config/update 需要 {id, patch}");
    const loaded = await loadHostConfig(logger);
    const updated = updateCommand(loaded.config, commandId, data.patch);
    const saved = await saveConfigFile(CONFIG_PATH, updated.config);
    return { config: saved, command: findCommand(saved, updated.command.id) };
  }
  if (endpoint === "config/delete") {
    const commandId = requireString(data.id, "id");
    const loaded = await loadHostConfig(logger);
    const removed = deleteCommand(loaded.config, commandId);
    const saved = await saveConfigFile(CONFIG_PATH, removed.config);
    return { config: saved, deleted: true };
  }
  if (endpoint === "config/reorder") {
    if (!Array.isArray(data.ids) || data.ids.some((item) => typeof item !== "string")) {
      throw new RpcError("bad-request", "config/reorder 需要 {ids: string[]}");
    }
    const loaded = await loadHostConfig(logger);
    const reordered = reorderCommands(loaded.config, data.ids);
    const saved = await saveConfigFile(CONFIG_PATH, reordered.config);
    return { config: saved };
  }
  if (endpoint === "config/ui") {
    if (typeof data.visible !== "boolean") throw new RpcError("bad-request", "config/ui 需要 {visible: boolean}");
    const loaded = await loadHostConfig(logger);
    const updated = setUi(loaded.config, { visible: data.visible });
    const saved = await saveConfigFile(CONFIG_PATH, updated.config);
    return { config: saved };
  }

  if (endpoint === "project/status") {
    const projectPath = requireProjectPath(data);
    await runner.refresh();
    return { runners: runner.list(projectPath) };
  }
  if (endpoint === "project/start") {
    const projectPath = requireProjectPath(data);
    const commandId = requireCommandId(data);
    const loaded = await loadHostConfig(logger);
    const command = findRunnableCommand(loaded.config, commandId);
    assertCommandProject(command, projectPath);
    await runner.refresh();
    const started = await runner.start(command, projectPath, { commands: loaded.config.commands });
    return { runner: started, runners: runner.list(projectPath) };
  }
  if (endpoint === "project/stop") {
    const projectPath = requireProjectPath(data);
    const commandId = requireCommandId(data);
    await runner.refresh();
    const stopped = await runner.stop(projectPath, commandId);
    return { stopped: stopped, runners: runner.list(projectPath) };
  }
  if (endpoint === "project/restart") {
    const projectPath = requireProjectPath(data);
    const commandId = requireCommandId(data);
    const loaded = await loadHostConfig(logger);
    const command = findRunnableCommand(loaded.config, commandId);
    assertCommandProject(command, projectPath);
    await runner.refresh();
    const restarted = await runner.restart(command, projectPath, { commands: loaded.config.commands });
    return { runner: restarted, runners: runner.list(projectPath) };
  }
  if (endpoint === "project/startAll") {
    const projectPath = requireProjectPath(data);
    const loaded = await loadHostConfig(logger);
    const result = await runner.startAll(loaded.config.commands, projectPath);
    return { started: result.started, failed: result.failed, runners: result.runners };
  }
  if (endpoint === "project/stopAll") {
    const projectPath = requireProjectPath(data);
    await runner.refresh();
    const stopped = await runner.stopProject(projectPath);
    return { stopped: stopped, runners: runner.list(projectPath) };
  }
  if (endpoint === "project/diagnose") {
    const projectPath = requireProjectPath(data);
    const loaded = await loadHostConfig(logger);
    const entries = await runner.diagnose(loaded.config.commands, projectPath);
    return { entries: entries };
  }
  if (endpoint === "project/killPort") {
    const projectPath = requireProjectPath(data);
    if (!Number.isInteger(data.port)) throw new RpcError("bad-request", "project/killPort 需要 {projectPath, port}", { port: data.port });
    if (data.pid !== undefined && data.pid !== null && (!Number.isInteger(data.pid) || data.pid <= 0)) {
      throw new RpcError("bad-request", "project/killPort 的 pid 必须是正整数", { pid: data.pid });
    }
    const result = await runner.killPort(projectPath, data.port, data.pid === undefined || data.pid === null ? undefined : data.pid);
    return { killed: result.killed, pid: result.pid, occupant: result.occupant };
  }
  if (endpoint === "project/log") {
    const projectPath = requireProjectPath(data);
    const commandId = requireCommandId(data);
    const log = await runner.readLog(commandId, projectPath, data.maxBytes);
    return { text: log.text, bytes: log.bytes, path: log.path, truncated: log.truncated };
  }
  if (endpoint === "project/log/clear") {
    const projectPath = requireProjectPath(data);
    const commandId = requireCommandId(data);
    await runner.clearLog(commandId, projectPath);
    return { cleared: true };
  }
  throw new RpcError("bad-request", "未知 endpoint：" + endpoint);
}

/** 统一的 RPC 响应信封（与 dsh-client-connection 的 client.rpc.call 对应）。 */
function respond(rpcId, result) {
  return Response.json({
    type: "server-response",
    rpcId: RpcId(rpcId),
    result: result
  });
}

/** 注册浏览器 RPC 路由（POST /api/dsh-runner/<endpoint>）。 */
function registerRpc(ctx, runner, logger) {
  for (const endpoint of RPC_ENDPOINTS) {
    const routePath = RPC_CHANNEL + "/" + RPC_NAMESPACE + "/" + endpoint;
    const method = RPC_NAMESPACE + "/" + endpoint;
    const register = () => {
      return ctx.connection.fetch.register({
        path: routePath,
        methods: ["POST"],
        requestBody: "buffered",
        async fetch(request) {
          let body;
          try {
            body = await request.json();
          } catch (error) {
            return new Response("body is not JSON", { status: 400 });
          }
          const envelope = clientRequestSchema.safeParse(body);
          if (!envelope.success) return new Response("invalid client-request envelope", { status: 400 });
          const message = envelope.data;
          if (message.method !== method) {
            return respond(message.rpcId, fail("bad-request", "method mismatch: " + message.method));
          }
          let result;
          try {
            result = ok(await dispatch(runner, endpoint, message.payload, logger));
          } catch (error) {
            const rpcError = toRpcError(error);
            result = fail(rpcError.code, rpcError.message, rpcError.details);
          }
          return respond(message.rpcId, result);
        }
      });
    };
    if (typeof ctx.effect === "function") {
      ctx.effect(register, "dsh-runner: rpc " + endpoint);
    } else {
      register();
    }
  }
}

/** 注册给 AI 的配置 Tool。 */
function registerConfigTool(ctx, logger) {
  ctx.tools.register(defineTool({
    name: "dsh_runner_config",
    description:
      "Manage dsh-runner launch commands (the commands shown in the run panel and the composer's Run menu). "
      + "action=list to inspect, create to add one, update to edit, delete to remove, reorder to change order. "
      + "When the user asks to add a startup/launch/run command for the current project, call create with command (and optional title); "
      + "scope defaults to project and projectRoot defaults to the workspace that owns the current session, so the command only appears in that project. "
      + "Use scope=global only when the user wants the command in every project. "
      + "env is a JSON object of string values; ports lists the TCP ports the command listens on; "
      + "readyPort (must be one of ports) makes dsh-runner wait until that port accepts connections; "
      + "readyTimeoutMs defaults to 120000; dependsOn lists ids of commands that must be started first. "
      + "This Tool only saves configuration — it does not execute anything. Use dsh_runner_run to start or stop long-running services (not terminal tools).",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "create", "update", "delete", "reorder"],
        description: "list | create | update | delete | reorder"
      },
      id: { type: "string", description: "Command id for update/delete; get it from action=list." },
      ids: { type: "array", items: { type: "string" }, description: "reorder: complete list of command ids in the desired order." },
      title: { type: "string", description: "Display name of the command." },
      command: { type: "string", description: "The command to run, e.g. pnpm dev." },
      cwd: { type: "string", description: "Absolute working directory; empty means projectRoot (or the current project path for global commands)." },
      scope: { type: "string", enum: ["project", "global"], description: "project (default in a workspace) or global." },
      projectRoot: { type: "string", description: "Project workspace path for scope=project; defaults to the current session workspace." },
      enabled: { type: "boolean", description: "Whether the command is enabled; default true." },
      env: { type: "object", additionalProperties: true, description: "Environment variables as a JSON object; values must be strings, e.g. {\"APP_ENV\":\"dev\"}." },
      ports: { type: "array", items: { type: "integer" }, description: "TCP ports the command listens on; used for a pre-start port check and diagnostics." },
      readyPort: { oneOf: [{ type: "integer" }, { type: "null" }], description: "Port that signals readiness; must be one of ports. Omit/null when not needed." },
      readyTimeoutMs: { type: "integer", description: "Readiness timeout in ms (1000-1800000), default 120000." },
      dependsOn: { type: "array", items: { type: "string" }, description: "Ids of commands that must be running before this one starts." }
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      if (args.action === "list") {
        const loaded = await loadHostConfig(logger);
        return {
          ok: true,
          filePath: CONFIG_PATH,
          exists: loaded.exists,
          commands: loaded.config.commands,
          ui: loaded.config.ui
        };
      }
      if (args.action === "create") {
        if (typeof args.command !== "string" || args.command.trim() === "") throw new Error("create 需要 command（要执行的命令）");
        const loaded = await loadHostConfig(logger);
        const created = createCommand(loaded.config, pickCommandPatch(args), sessionWorkspacePath(exec, ctx));
        const saved = await saveConfigFile(CONFIG_PATH, created.config);
        return {
          ok: true,
          filePath: CONFIG_PATH,
          command: findCommand(saved, created.command.id),
          commands: saved.commands,
          message: "已创建命令「" + created.command.title + "」"
        };
      }
      if (args.action === "update") {
        if (typeof args.id !== "string" || args.id.trim() === "") throw new Error("update 需要 id");
        const loaded = await loadHostConfig(logger);
        const updated = updateCommand(loaded.config, args.id.trim(), pickCommandPatch(args));
        const saved = await saveConfigFile(CONFIG_PATH, updated.config);
        return {
          ok: true,
          filePath: CONFIG_PATH,
          command: findCommand(saved, updated.command.id),
          commands: saved.commands,
          message: "已修改命令「" + updated.command.title + "」"
        };
      }
      if (args.action === "delete") {
        if (typeof args.id !== "string" || args.id.trim() === "") throw new Error("delete 需要 id");
        const loaded = await loadHostConfig(logger);
        const removed = deleteCommand(loaded.config, args.id.trim());
        const saved = await saveConfigFile(CONFIG_PATH, removed.config);
        return {
          ok: true,
          filePath: CONFIG_PATH,
          commands: saved.commands,
          message: "已删除命令「" + removed.command.title + "」"
        };
      }
      if (args.action === "reorder") {
        if (!Array.isArray(args.ids)) throw new Error("reorder 需要 ids（完整排列）");
        const loaded = await loadHostConfig(logger);
        const reordered = reorderCommands(loaded.config, args.ids);
        const saved = await saveConfigFile(CONFIG_PATH, reordered.config);
        return {
          ok: true,
          filePath: CONFIG_PATH,
          commands: saved.commands,
          message: "已重排命令顺序"
        };
      }
      throw new Error("未知 action：" + String(args.action));
    }
  }));
}

/** 注册给 AI 的运行 Tool（长驻服务入口）。 */
function registerRunTool(ctx, runner, logger) {
  ctx.tools.register(defineTool({
    name: "dsh_runner_run",
    description:
      "Start/stop/inspect long-running project services managed by dsh-runner. "
      + "action=status shows the project's runners; start/stop/restart operate one command; "
      + "startAll starts every enabled project-scope command in dependency order; stopAll stops them all; "
      + "diagnose reports TCP ports occupied by non-managed processes (process name/PID/window title/parent chain); "
      + "killPort ends a confirmed non-managed port occupant (optionally verifying its pid); log returns the tail of a command's log. "
      + "Use this Tool to start and stop long-running services (dev servers, watchers, backends). "
      + "Do NOT use terminal tools for long-running services — terminal tools are for short-lived commands; "
      + "services started in a terminal die with the tool session and have no managed log/port diagnostics. "
      + "Commands are configured with dsh_runner_config. projectPath defaults to the workspace that owns the current session.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["status", "start", "stop", "restart", "startAll", "stopAll", "diagnose", "killPort", "log"],
        description: "status | start | stop | restart | startAll | stopAll | diagnose | killPort | log"
      },
      projectPath: { type: "string", description: "Project path; defaults to the workspace that owns the current session." },
      commandId: { type: "string", description: "Command id for start/stop/restart/log; get it from dsh_runner_config action=list." },
      port: { type: "integer", description: "killPort only: TCP port whose non-managed occupant should be ended." },
      pid: { type: "integer", description: "killPort only: expected occupant pid from diagnose; rejects if the port changed hands." },
      maxBytes: { type: "integer", description: "log only: max bytes of the tail to read (1024-1048576), default 65536." }
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const explicitPath = typeof args.projectPath === "string" && args.projectPath.trim() !== "" ? args.projectPath.trim() : undefined;
      const projectPath = explicitPath !== undefined ? explicitPath : sessionWorkspacePath(exec, ctx);
      if (projectPath === undefined || projectPath === "") {
        throw new Error("无法确定项目路径：请在项目会话中调用，或显式传 projectPath");
      }
      await runner.init();
      if (args.action === "status") {
        await runner.refresh();
        return { runners: runner.list(projectPath) };
      }
      if (args.action === "start" || args.action === "restart") {
        const commandId = typeof args.commandId === "string" ? args.commandId.trim() : "";
        if (commandId === "") throw new Error(args.action + " 需要 commandId");
        const loaded = await loadHostConfig(logger);
        const command = findRunnableCommand(loaded.config, commandId);
        assertCommandProject(command, projectPath);
        await runner.refresh();
        const runnerSnapshot = args.action === "start"
          ? await runner.start(command, projectPath, { commands: loaded.config.commands })
          : await runner.restart(command, projectPath, { commands: loaded.config.commands });
        return { runner: runnerSnapshot, runners: runner.list(projectPath) };
      }
      if (args.action === "stop") {
        const commandId = typeof args.commandId === "string" ? args.commandId.trim() : "";
        if (commandId === "") throw new Error("stop 需要 commandId");
        await runner.refresh();
        const stopped = await runner.stop(projectPath, commandId);
        return { stopped: stopped, runners: runner.list(projectPath) };
      }
      if (args.action === "startAll") {
        const loaded = await loadHostConfig(logger);
        const result = await runner.startAll(loaded.config.commands, projectPath);
        return { started: result.started, failed: result.failed, runners: result.runners };
      }
      if (args.action === "stopAll") {
        await runner.refresh();
        const stopped = await runner.stopProject(projectPath);
        return { stopped: stopped, runners: runner.list(projectPath) };
      }
      if (args.action === "diagnose") {
        const loaded = await loadHostConfig(logger);
        const entries = await runner.diagnose(loaded.config.commands, projectPath);
        return { entries: entries };
      }
      if (args.action === "killPort") {
        if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
          throw new Error("killPort 需要 0-65535 的整数 port");
        }
        if (args.pid !== undefined && args.pid !== null && (!Number.isInteger(args.pid) || args.pid <= 0)) {
          throw new Error("killPort 的 pid 必须是正整数");
        }
        const result = await runner.killPort(projectPath, args.port, args.pid === undefined || args.pid === null ? undefined : args.pid);
        return { killed: result.killed, pid: result.pid, occupant: result.occupant };
      }
      if (args.action === "log") {
        const commandId = typeof args.commandId === "string" ? args.commandId.trim() : "";
        if (commandId === "") throw new Error("log 需要 commandId");
        return runner.readLog(commandId, projectPath, args.maxBytes);
      }
      throw new Error("未知 action：" + String(args.action));
    }
  }));
}

export function apply(ctx) {
  const logger = ctx !== undefined && ctx !== null ? ctx.logger : undefined;
  const runner = new ProjectRunnerService({ logger: logger });
  // 启动对账：接管上次 Host 留下的运行中进程（pid + 命令行标记双重校验）。
  const ready = runner.init().catch((error) => {
    reportHostError(logger, "启动对账失败", error);
  });
  ctx.effect(() => () => {
    // 只落盘，不杀进程：项目级后台任务不因插件卸载/重载而中断。
    void ready;
    runner.shutdown();
  }, "dsh-runner: project runner state flush");
  registerConfigTool(ctx, logger);
  registerRunTool(ctx, runner, logger);
  ctx.inject(["connection"], (connectionCtx) => {
    registerRpc(connectionCtx, runner, logger);
  });
}
