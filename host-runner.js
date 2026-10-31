// dsh-runner 的「项目级」后台进程管理。
//
// 第一性原理（本文件遵守的不变量）：
//   1. 进程归属项目，不归属会话：key = 规范化项目路径 + 命令 id，与 Session 无关。
//   2. Host 是进程状态的唯一事实来源。状态机只前进：
//        running -> stopping -> stopped | exited | failed
//      stop() 在返回前必须让状态离开 running，UI 不需要靠猜/等 exit 事件。
//   3. 子进程的 stdout/stderr 直接写日志文件（继承 fd），不经过 Host 转发：
//      Host 退出/重载不会破坏日志，也没有管道背压。
//   4. 进程生命周期 = Host lifetime，但状态跨 Host 重启：启动时读 state 文件对账，
//      校验 pid + 命令行标记后接管仍在运行的项目进程；
//      校验不通过（进程没了 / pid 被复用）的记录直接丢弃，绝不误杀别的进程。
//   5. 插件卸载不杀进程：项目级后台任务不应该因为 UI/插件重载而中断。
//      停止只通过 stop / stopProject 显式触发。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, openSync, writeSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 1;
const ACTIVE_STATUSES = new Set(["running", "stopping"]);
const STOP_TIMEOUT_MS = 4000;
const ADOPTED_REFRESH_MS = 1500;
const MARKER_PREFIX = "dsh-runner-";

let cachedShellPath;

/** 优先 pwsh，退回 Windows PowerShell；结果在进程内缓存。 */
function resolvePowerShell() {
  if (cachedShellPath !== undefined) return cachedShellPath;
  try {
    const result = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const line = result.stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item !== "");
      if (line !== undefined) {
        cachedShellPath = line;
        return cachedShellPath;
      }
    }
  } catch (_error) {
    /* 退回 powershell.exe */
  }
  cachedShellPath = "powershell.exe";
  return cachedShellPath;
}

function safeFilePart(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "value";
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

/** 项目路径的规范形态：去空白、统一反斜杠、去尾部斜杠、小写。 */
export function normalizeProjectPath(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}

export function samePath(left, right) {
  const a = normalizeProjectPath(left);
  const b = normalizeProjectPath(right);
  return a !== "" && a === b;
}

function projectHash(projectPath) {
  return createHash("sha1").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 12);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isActive(record) {
  return record !== undefined && record !== null && ACTIVE_STATUSES.has(record.status);
}

/**
 * 命令行标记：写进 PowerShell 脚本的第一个语句，进程表里可见。
 * 用于 Host 重启接管时确认「这个 pid 确实是我们上次启动的那个进程」，避免 pid 复用误杀。
 */
function createMarker(key) {
  const digest = createHash("sha1")
    .update(String(key))
    .update("|")
    .update(String(Date.now()))
    .update("|")
    .update(randomBytes(8).toString("hex"))
    .digest("hex")
    .slice(0, 16);
  return MARKER_PREFIX + digest;
}

/** 组装实际执行的 PowerShell 脚本（单行）。 */
function buildCommandText(command, cwd, marker) {
  const parts = [
    "$null = '" + escapePowerShell(marker) + "'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "chcp 65001 | Out-Null",
    "$env:PATH = (Join-Path $env:USERPROFILE '.cargo\\bin') + ';' + $env:PATH"
  ];
  if (typeof cwd === "string" && cwd.trim() !== "") {
    parts.push("Set-Location -LiteralPath '" + escapePowerShell(cwd.trim()) + "'");
  }
  parts.push(String(command.command));
  return parts.join("; ");
}

function appendLogLine(logPath, line) {
  if (typeof logPath !== "string" || logPath === "") return Promise.resolve();
  return appendFile(logPath, line, "utf8").catch(() => {});
}

/** 读取进程表：pid -> 命令行。进程不存在时不会出现在结果里；读取失败时抛错（调用方必须保守处理）。 */
function queryProcessTable(pids) {
  const ids = Array.from(new Set(pids.filter((pid) => typeof pid === "number" && Number.isFinite(pid) && pid > 0)));
  if (ids.length === 0) return new Map();
  if (process.platform !== "win32") {
    const map = new Map();
    for (const pid of ids) {
      try {
        process.kill(pid, 0);
        map.set(pid, "");
      } catch (_error) {
        /* 进程不存在 */
      }
    }
    return map;
  }
  const filter = ids.map((pid) => "ProcessId=" + String(pid)).join(" OR ");
  const script = "Get-CimInstance Win32_Process -Filter \"" + filter + "\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }";
  const result = spawnSync(resolvePowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000
  });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (typeof result.stdout !== "string") throw new Error("无法读取 Windows 进程表");
  const map = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf("|");
    if (index <= 0) continue;
    const pid = Number(line.slice(0, index).trim());
    if (!Number.isFinite(pid)) continue;
    map.set(pid, line.slice(index + 1));
  }
  return map;
}

async function readStateEntries(statePath) {
  try {
    const text = await readFile(statePath, "utf8");
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.runners)) return parsed.runners;
    return [];
  } catch (_error) {
    return [];
  }
}

/** 一个项目路径下，一个命令最多一个进程；状态跨 Host 重启保留。 */
export class ProjectRunnerService {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(os.homedir(), ".dsh", "dsh-runner", "logs");
    this.statePath = options.statePath || path.join(path.dirname(this.logDir), "runner-state.json");
    this.logger = options.logger;
    this.records = new Map();
    this.persistQueue = Promise.resolve();
    this.initPromise = null;
    this.lastRefreshAt = 0;
  }

  key(projectPath, commandId) {
    return normalizeProjectPath(projectPath) + "\u0000" + String(commandId);
  }

  /** 幂等初始化：对账上次 Host 留下的状态。RPC / Tool 使用前必须 await。 */
  init() {
    if (this.initPromise === null) this.initPromise = this.reconcile();
    return this.initPromise;
  }

  async reconcile() {
    const entries = await readStateEntries(this.statePath);
    const candidates = entries.filter((entry) => {
      return entry !== null && typeof entry === "object"
        && typeof entry.pid === "number" && Number.isFinite(entry.pid) && entry.pid > 0
        && typeof entry.marker === "string" && entry.marker !== ""
        && typeof entry.logPath === "string" && entry.logPath !== "";
    });
    if (candidates.length === 0) {
      await this.persist();
      return;
    }
    let table;
    try {
      table = queryProcessTable(candidates.map((entry) => entry.pid));
    } catch (error) {
      // 读不到进程表时保守处理：不接管、不改写 state 文件（留待下次启动再试）。
      this.reportError("无法校验上次的后台进程，跳过接管", error);
      return;
    }
    for (const entry of candidates) {
      const commandLine = table.get(entry.pid);
      const alive = commandLine !== undefined
        && (process.platform !== "win32" || commandLine.indexOf(entry.marker) !== -1);
      if (!alive) {
        if (commandLine === undefined) {
          await appendLogLine(entry.logPath, "\r\n[dsh-runner] 上次记录的后台进程已结束（Host 重启时发现）\r\n");
        }
        continue;
      }
      const key = typeof entry.key === "string" && entry.key !== "" ? entry.key : this.key(entry.projectPath, entry.commandId);
      if (this.records.has(key)) continue;
      this.records.set(key, {
        key: key,
        projectPath: String(entry.projectPath === undefined ? "" : entry.projectPath),
        commandId: String(entry.commandId === undefined ? "" : entry.commandId),
        title: String(entry.title === undefined ? "" : entry.title),
        terminalTitle: String(entry.terminalTitle === undefined ? "" : entry.terminalTitle),
        command: String(entry.command === undefined ? "" : entry.command),
        cwd: String(entry.cwd === undefined ? "" : entry.cwd),
        logPath: entry.logPath,
        marker: entry.marker,
        pid: entry.pid,
        startedAt: typeof entry.startedAt === "number" ? entry.startedAt : Date.now(),
        status: "running",
        exitCode: undefined,
        stopRequested: false,
        adopted: true,
        child: null,
        finished: false
      });
    }
    await this.persist();
  }

  /** 接管进程的存活刷新：确认已退出的接管进程并落状态。 */
  async refresh() {
    const adopted = [];
    for (const record of this.records.values()) {
      if (record.adopted === true && record.status === "running") adopted.push(record);
    }
    if (adopted.length === 0) return;
    const now = Date.now();
    if (now - this.lastRefreshAt < ADOPTED_REFRESH_MS) return;
    this.lastRefreshAt = now;
    let table;
    try {
      table = queryProcessTable(adopted.map((record) => record.pid));
    } catch (error) {
      this.reportError("无法校验接管进程状态", error);
      return;
    }
    for (const record of adopted) {
      const commandLine = table.get(record.pid);
      const alive = commandLine !== undefined
        && (process.platform !== "win32" || commandLine.indexOf(record.marker) !== -1);
      if (alive) continue;
      await this.finish(record, "exited", -1, undefined, "接管进程已结束（Host 重启后检测）");
    }
  }

  async start(command, projectPath) {
    if (command === null || command === undefined || typeof command !== "object") throw new Error("start 需要命令对象");
    if (typeof projectPath !== "string" || projectPath.trim() === "") throw new Error("项目级运行需要项目路径");
    const workspace = projectPath.trim();
    const key = this.key(workspace, command.id);
    const previous = this.records.get(key);
    if (previous !== undefined && isActive(previous)) {
      if (previous.status === "stopping") {
        await this.waitExit(previous, STOP_TIMEOUT_MS);
        if (isActive(previous)) throw new Error("上一个进程仍在停止中，请稍后再试");
      } else {
        return this.snapshot(previous);
      }
    }

    const effectiveCwd = typeof command.cwd === "string" && command.cwd.trim() !== "" ? command.cwd.trim() : workspace;
    try {
      accessSync(effectiveCwd);
    } catch (_error) {
      throw new Error("工作目录不存在：" + effectiveCwd);
    }

    const dir = path.join(this.logDir, projectHash(workspace));
    await mkdir(dir, { recursive: true });
    const logPath = path.join(dir, safeFilePart(command.id) + ".log");
    const marker = createMarker(key);
    const shell = resolvePowerShell();
    const logFd = openSync(logPath, "a");
    let child;
    try {
      writeSync(logFd, "\r\n[dsh-runner] " + new Date().toLocaleString() + " 启动：" + command.title + "（" + workspace + "）\r\n");
      child = spawn(shell, ["-NoLogo", "-NoProfile", "-Command", buildCommandText(command, effectiveCwd, marker)], {
        cwd: effectiveCwd,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd]
      });
    } finally {
      closeSync(logFd);
    }

    const record = {
      key: key,
      projectPath: workspace,
      commandId: command.id,
      title: command.title,
      terminalTitle: command.terminalTitle,
      command: command.command,
      cwd: effectiveCwd,
      logPath: logPath,
      marker: marker,
      pid: child.pid,
      startedAt: Date.now(),
      status: "running",
      exitCode: undefined,
      stopRequested: false,
      adopted: false,
      child: child,
      finished: false
    };
    record.exited = new Promise((resolve) => {
      record.resolveExited = resolve;
    });
    this.records.set(key, record);

    child.on("error", (error) => {
      void this.finish(record, "failed", -1, undefined, "启动失败：" + String(error));
    });
    child.on("exit", (code, signal) => {
      const status = record.stopRequested ? "stopped" : "exited";
      void this.finish(record, status, typeof code === "number" ? code : -1, signal);
    });

    await this.persist();
    return this.snapshot(record);
  }

  /** 停止一个项目命令；返回前状态一定已经离开 running/stopping。 */
  async stop(projectPath, commandId) {
    const record = this.records.get(this.key(projectPath, commandId));
    if (!isActive(record)) return false;
    record.stopRequested = true;
    if (record.status === "running") record.status = "stopping";
    await this.persist();
    this.killTree(record.pid);
    if (record.child !== null && record.child !== undefined) {
      await this.waitExit(record, STOP_TIMEOUT_MS);
    } else if (typeof record.pid === "number") {
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        let alive = false;
        try {
          alive = queryProcessTable([record.pid]).has(record.pid);
        } catch (_error) {
          alive = false;
        }
        if (!alive) break;
        await sleep(120);
      }
    }
    if (isActive(record)) {
      await this.finish(record, "stopped", record.exitCode === undefined ? -1 : record.exitCode, undefined, "进程未在超时内确认退出，状态按已停止记录");
    }
    return true;
  }

  async stopProject(projectPath) {
    const targets = [];
    for (const record of this.records.values()) {
      if (isActive(record) && samePath(record.projectPath, projectPath)) targets.push(record);
    }
    let stopped = 0;
    for (const record of targets) {
      // 用 record 自己的 projectPath 建 key，避免调用方路径写法不同导致停不掉。
      if (await this.stop(record.projectPath, record.commandId)) stopped += 1;
    }
    return stopped;
  }

  async finish(record, status, exitCode, signal, note) {
    if (record === undefined || record === null || record.finished === true) return;
    record.finished = true;
    record.status = status;
    record.exitCode = exitCode;
    record.child = null;
    if (typeof note === "string" && note !== "") {
      await appendLogLine(record.logPath, "\r\n[dsh-runner] " + note + "\r\n");
    }
    await appendLogLine(record.logPath, "\r\n[dsh-runner] 进程结束（code=" + String(exitCode) + (signal === undefined || signal === null ? "" : ", signal=" + signal) + "）\r\n");
    try {
      if (typeof record.resolveExited === "function") record.resolveExited();
    } catch (_error) {
      /* ignore */
    }
    await this.persist();
  }

  waitExit(record, timeoutMs) {
    const exit = record.exited !== undefined ? record.exited : Promise.resolve();
    return Promise.race([exit, sleep(timeoutMs)]);
  }

  killTree(pid) {
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return;
    if (process.platform !== "win32") {
      try {
        process.kill(pid, "SIGTERM");
      } catch (_error) {
        /* ignore */
      }
      return;
    }
    try {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
    } catch (_error) {
      /* 进程可能已退出 */
    }
  }

  snapshot(record) {
    return {
      key: record.key,
      projectPath: record.projectPath,
      commandId: record.commandId,
      title: record.title,
      terminalTitle: record.terminalTitle,
      command: record.command,
      cwd: record.cwd,
      logPath: record.logPath,
      pid: record.pid,
      startedAt: record.startedAt,
      status: record.status,
      exitCode: record.exitCode,
      adopted: record.adopted === true
    };
  }

  list(projectPath) {
    const all = [...this.records.values()];
    const filtered = typeof projectPath === "string" && projectPath.trim() !== ""
      ? all.filter((record) => samePath(record.projectPath, projectPath))
      : all;
    return filtered.sort((left, right) => left.startedAt - right.startedAt).map((record) => this.snapshot(record));
  }

  /** 插件卸载/进程退出前落盘；不杀任何子进程（项目级后台任务继续运行，下次启动接管）。 */
  async shutdown() {
    await this.persist();
  }

  persist() {
    this.persistQueue = this.persistQueue.then(() => this.writeState()).catch(() => {});
    return this.persistQueue;
  }

  async writeState() {
    const runners = [];
    for (const record of this.records.values()) {
      if (!isActive(record)) continue;
      runners.push(Object.assign(this.snapshot(record), {
        marker: record.marker,
        adopted: record.adopted === true
      }));
    }
    const payload = JSON.stringify({
      version: STATE_VERSION,
      updatedAt: new Date().toISOString(),
      runners: runners
    }, null, 2);
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const tempPath = this.statePath + "." + String(process.pid) + ".tmp";
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, this.statePath);
  }

  reportError(message, error) {
    if (this.logger !== undefined && this.logger !== null && typeof this.logger.error === "function") {
      try {
        this.logger.error("dsh-runner: " + message, error);
        return;
      } catch (_ignored) {
        /* 退回 console */
      }
    }
    // eslint-disable-next-line no-console
    console.error("dsh-runner: " + message, error);
  }
}
