// dsh-runner 的宿主侧（Host）实现。
//
// 浏览器端的「运行」按钮只负责调用 DSH 自带终端执行命令；命令配置真正存到
// 宿主侧的 commands.json，并同时提供两种入口：
//   1) 给 AI 用的 Tool：dsh_runner_config（list/create/update/delete）；
//   2) 给浏览器设置页用的 RPC：config/get、config/save。
// 这样 AI 在任意项目里都能直接给插件加启动命令，设置页刷新/打开菜单时自动同步。
import os from "node:os";
import path from "node:path";
import { RpcId, clientRequestSchema } from "@deepseek-ai/dsh-client-connection";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  createCommand,
  deleteCommand,
  loadConfig,
  normalizePath,
  saveConfigFile,
  updateCommand
} from "./host-config.js";
import { ProjectRunnerService } from "./host-runner.js";

export const name = "dsh-runner";
// tools：注册 AI Tool；connection 在 apply 里按需注入（浏览器 RPC 需要）。
export const inject = ["tools"];

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".dsh", "dsh-runner", "commands.json");
// 旧版插件名改过来之前的配置文件位置；首次读取时自动迁移到新路径。
const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".dsh", "limob-runner", "commands.json");

// 配置文件的默认位置；测试时可用环境变量指向临时文件，避免污染真实配置。
export const CONFIG_PATH = process.env.DSH_RUNNER_CONFIG
  || process.env.DSH_LIMOB_RUNNER_CONFIG
  || DEFAULT_CONFIG_PATH;

const RPC_CHANNEL = "/api";
const RPC_NAMESPACE = "dsh-runner";
const RPC_ENDPOINTS = ["config/get", "config/save", "project/status", "project/start", "project/stop", "project/stopAll"];

/** 读取配置；如果新路径还不存在而旧版文件存在，就自动迁移一次。 */
async function ensureConfigFile() {
  const current = await loadConfig(CONFIG_PATH);
  if (current.exists || CONFIG_PATH !== DEFAULT_CONFIG_PATH) return current;
  const legacy = await loadConfig(LEGACY_CONFIG_PATH);
  if (!legacy.exists) return current;
  await saveConfigFile(CONFIG_PATH, legacy.config);
  return { exists: true, config: legacy.config };
}

/** 容错读 Host 服务：插件上下文与会话上下文不一定都暴露同一个服务。 */
function getHostService(source, key) {
  try {
    if (source === null || source === undefined || typeof source.get !== "function") return undefined;
    const value = source.get(key);
    return value === undefined ? undefined : value;
  } catch (_error) {
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
  const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : undefined;
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
    } catch (_error) {
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

/** 把 Tool 参数里出现的字段收集成 patch，避免 undefined 覆盖已有值。 */
function pickPatch(args) {
  const patch = {};
  const fields = ["title", "command", "cwd", "scope", "projectRoot", "terminalTitle", "enabled", "utf8CodePage"];
  for (const field of fields) {
    if (args[field] !== undefined) patch[field] = args[field];
  }
  return patch;
}

/** 注册给 AI 的配置 Tool。 */
function registerConfigTool(ctx) {
  return ctx.tools.register(defineTool({
    name: "dsh_runner_config",
    description:
      "Manage the dsh-runner launch commands (the commands shown under the composer's Run button). "
      + "Use action=list to inspect existing commands; action=create to add one; action=update to edit; action=delete to remove. "
      + "When the user asks to add a startup/launch/run command for the current project, call create with command (and optional title); "
      + "the Tool defaults to project scope and uses the workspace that owns the current session as projectRoot, so it only appears in that project. "
      + "Use scope=global only when the user explicitly wants the command in every project. "
      + "The command runs in DSH's built-in terminal; this Tool only saves configuration, it does not execute the command.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "create", "update", "delete"],
        description: "list | create | update | delete"
      },
      id: { type: "string", description: "Command id (or exact title) for update/delete; get it from action=list." },
      title: { type: "string", description: "Display name of the command." },
      command: { type: "string", description: "The PowerShell command to run, e.g. pnpm dev." },
      cwd: { type: "string", description: "Working directory; defaults to projectRoot/current workspace." },
      scope: { type: "string", enum: ["global", "project"], description: "project (default when in a workspace) or global." },
      projectRoot: { type: "string", description: "Project workspace path for scope=project; defaults to the current session workspace." },
      terminalTitle: { type: "string", description: "Optional DSH terminal tab title." },
      enabled: { type: "boolean", description: "Whether the command appears in the menu; default true." },
      utf8CodePage: { type: "boolean", description: "Run chcp 65001 before the command; auto-enabled for non-ASCII commands." }
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const loaded = await ensureConfigFile();
      if (args.action === "list") {
        return {
          ok: true,
          filePath: CONFIG_PATH,
          exists: loaded.exists,
          commands: loaded.config.commands,
          ui: loaded.config.ui
        };
      }
      if (args.action === "create") {
        const created = createCommand(loaded.config, args, sessionWorkspacePath(exec, ctx));
        const saved = await saveConfigFile(CONFIG_PATH, created.config);
        return {
          ok: true,
          filePath: CONFIG_PATH,
          command: created.command,
          commands: saved.commands,
          message: "已创建命令「" + created.command.title + "」"
        };
      }
      if (args.action === "update") {
        if (args.id === undefined && args.title === undefined) throw new Error("update 需要 id 或 title");
        const updated = updateCommand(loaded.config, args.id !== undefined ? args.id : args.title, pickPatch(args));
        const saved = await saveConfigFile(CONFIG_PATH, updated.config);
        return {
          ok: true,
          filePath: CONFIG_PATH,
          command: updated.command,
          commands: saved.commands,
          message: "已修改命令「" + updated.command.title + "」"
        };
      }
      if (args.action === "delete") {
        if (args.id === undefined && args.title === undefined) throw new Error("delete 需要 id 或 title");
        const removed = deleteCommand(loaded.config, args.id !== undefined ? args.id : args.title);
        const saved = await saveConfigFile(CONFIG_PATH, removed.config);
        return {
          ok: true,
          filePath: CONFIG_PATH,
          command: removed.command,
          commands: saved.commands,
          message: "已删除命令「" + removed.command.title + "」"
        };
      }
      throw new Error("未知 action：" + String(args.action));
    }
  }));
}

/** 统一的 RPC 响应信封（与 dsh-client-connection 的 client.rpc.call 对应）。 */
function respond(rpcId, result) {
  return Response.json({
    type: "server-response",
    rpcId: RpcId(rpcId),
    result: result
  });
}

function ok(value) {
  return { ok: true, value: value };
}

function fail(code, message) {
  return { ok: false, error: { code: code, message: message, details: {} } };
}

async function dispatch(runner, endpoint, payload) {
  // 进程相关端点必须等启动对账完成，否则会漏掉「上次 Host 留下的运行中进程」；
  // 配置端点不需要等（避免设置页被 powershell 进程校验收阻塞）。
  if (endpoint.indexOf("project/") === 0) await runner.init();
  if (endpoint === "config/get") {
    const loaded = await ensureConfigFile();
    return {
      config: loaded.exists ? loaded.config : null,
      filePath: CONFIG_PATH,
      exists: loaded.exists
    };
  }
  if (endpoint === "config/save") {
    if (payload === null || payload === undefined || typeof payload !== "object" || payload.config === undefined) {
      throw new Error("config/save 需要 {config}");
    }
    const saved = await saveConfigFile(CONFIG_PATH, payload.config);
    return { saved: true, filePath: CONFIG_PATH, config: saved };
  }
  if (endpoint === "project/status") {
    const projectPath = payload !== null && payload !== undefined && typeof payload === "object" && typeof payload.projectPath === "string"
      ? payload.projectPath
      : undefined;
    await runner.refresh();
    return { runners: runner.list(projectPath) };
  }
  if (endpoint === "project/start") {
    if (payload === null || payload === undefined || typeof payload !== "object"
      || typeof payload.commandId !== "string" || typeof payload.projectPath !== "string" || payload.projectPath.trim() === "") {
      throw new Error("project/start 需要 {commandId, projectPath}");
    }
    const loaded = await ensureConfigFile();
    const command = loaded.config.commands.find((item) => item.id === payload.commandId);
    if (command === undefined) throw new Error("找不到命令：" + payload.commandId);
    if (command.enabled === false) throw new Error("命令已停用");
    if (command.scope === "project") {
      const root = normalizePath(command.projectRoot);
      const current = normalizePath(payload.projectPath);
      if (root === "" || !(current === root || current.indexOf(root + "\\") === 0)) {
        throw new Error("当前项目不匹配这条项目级命令");
      }
    }
    await runner.refresh();
    return { runner: await runner.start(command, payload.projectPath), runners: runner.list(payload.projectPath) };
  }
  if (endpoint === "project/stop") {
    if (payload === null || payload === undefined || typeof payload !== "object"
      || typeof payload.commandId !== "string" || typeof payload.projectPath !== "string") {
      throw new Error("project/stop 需要 {commandId, projectPath}");
    }
    await runner.refresh();
    const stopped = await runner.stop(payload.projectPath, payload.commandId);
    return { stopped: stopped, runners: runner.list(payload.projectPath) };
  }
  if (endpoint === "project/stopAll") {
    if (payload === null || payload === undefined || typeof payload !== "object" || typeof payload.projectPath !== "string") {
      throw new Error("project/stopAll 需要 {projectPath}");
    }
    await runner.refresh();
    const count = await runner.stopProject(payload.projectPath);
    return { stopped: count, runners: runner.list(payload.projectPath) };
  }
  throw new Error("未知 endpoint：" + endpoint);
}

/** 注册浏览器 RPC 路由（POST /api/dsh-runner/config/get 等）。 */
function registerRpc(ctx, runner) {
  for (const endpoint of RPC_ENDPOINTS) {
    const routePath = RPC_CHANNEL + "/" + RPC_NAMESPACE + "/" + endpoint;
    const method = RPC_NAMESPACE + "/" + endpoint;
    const register = () => {
      const dispose = ctx.connection.fetch.register({
        path: routePath,
        methods: ["POST"],
        requestBody: "buffered",
        async fetch(request) {
          let body;
          try {
            body = await request.json();
          } catch (_error) {
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
            result = ok(await dispatch(runner, endpoint, message.payload));
          } catch (error) {
            result = fail("internal", error instanceof Error ? error.message : String(error));
          }
          return respond(message.rpcId, result);
        }
      });
      return () => {
        dispose();
      };
    };
    if (typeof ctx.effect === "function") {
      ctx.effect(register, "dsh-runner: rpc " + endpoint);
    } else {
      register();
    }
  }
}

export function apply(ctx) {
  const runner = new ProjectRunnerService({
    logger: ctx !== undefined && ctx !== null ? ctx.logger : undefined
  });
  // 启动对账：接管上次 Host 留下的运行中进程（pid + 命令行标记双重校验）。
  const ready = runner.init().catch((error) => {
    try {
      if (ctx !== undefined && ctx !== null && ctx.logger !== undefined) ctx.logger.error("dsh-runner: 启动对账失败", error);
      else console.error("dsh-runner: 启动对账失败", error);
    } catch (_ignored) {
      /* ignore */
    }
  });
  ctx.effect(() => () => {
    // 只落盘，不杀进程：项目级后台任务不因插件卸载/重载而中断。
    void ready;
    runner.shutdown();
  }, "dsh-runner: project runner state flush");
  registerConfigTool(ctx);
  ctx.inject(["connection"], (connectionCtx) => {
    registerRpc(connectionCtx, runner);
  });
}
