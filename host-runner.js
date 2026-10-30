// dsh-runner 的「全局命令」后台进程管理。
//
// 为什么需要它：
//   DSH 自带的右侧栏终端是会话级的，切换会话就看不到；全局命令不应该跟会话走。
//   所以这里由 Host 启动一个独立进程（按命令 id 管理），输出写到日志文件，
//   浏览器在任意会话里开一个「跟随日志」的原生终端来显示，从而做到切项目仍在。
//
// 注意：这是只读日志式的全局运行（不接管键盘输入）；命令本身由 Host 执行。
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 找到 pwsh，找不到就退回 Windows PowerShell。 */
function resolvePowerShell() {
  try {
    const result = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const line = result.stdout.split(/\r?\n/).map((item) => item.trim()).find((item) => item !== "");
      if (line !== undefined) return line;
    }
  } catch (_error) {
    /* fallback */
  }
  return "powershell.exe";
}

function safeFilePart(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "command";
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

function buildCommandText(command) {
  const parts = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "chcp 65001 | Out-Null",
    "$env:PATH = (Join-Path $env:USERPROFILE '.cargo\\bin') + ';' + $env:PATH"
  ];
  if (typeof command.cwd === "string" && command.cwd.trim() !== "") {
    parts.push("Set-Location -LiteralPath '" + escapePowerShell(command.cwd.trim()) + "'");
  }
  parts.push(command.command);
  return parts.join("; ");
}

/**
 * 全局进程管理器。
 * 一个 commandId 同一时间最多一个进程；停止后保留最近一次状态供页面展示。
 */
export class GlobalRunnerService {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(os.homedir(), ".dsh", "dsh-runner", "logs");
    this.records = new Map();
    this.disposed = false;
  }

  async start(command) {
    if (command === null || command === undefined || typeof command !== "object") {
      throw new Error("start 需要命令对象");
    }
    if (command.scope !== "global") throw new Error("只有全局命令可以由全局运行器启动");
    const previous = this.records.get(command.id);
    if (previous !== undefined && previous.status === "running") return this.snapshot(previous);

    await mkdir(this.logDir, { recursive: true });
    const logPath = path.join(this.logDir, safeFilePart(command.id) + ".log");
    const log = createWriteStream(logPath, { flags: "a" });
    log.write("\r\n[dsh-runner] " + new Date().toLocaleString() + " 启动：" + command.title + "\r\n");

    const shell = resolvePowerShell();
    const child = spawn(shell, ["-NoLogo", "-NoProfile", "-Command", buildCommandText(command)], {
      cwd: typeof command.cwd === "string" && command.cwd.trim() !== "" ? command.cwd : undefined,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const record = {
      commandId: command.id,
      title: command.title,
      command: command.command,
      logPath: logPath,
      logStream: log,
      child: child,
      pid: child.pid,
      startedAt: Date.now(),
      status: "running",
      exitCode: undefined,
      stopRequested: false
    };
    this.records.set(command.id, record);

    child.stdout.on("data", (chunk) => {
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log.write(chunk);
    });
    child.on("error", (error) => {
      log.write("\r\n[dsh-runner] 启动失败：" + String(error) + "\r\n");
      record.status = "failed";
      record.exitCode = -1;
      record.logStream.end();
    });
    child.on("exit", (code, signal) => {
      record.exitCode = typeof code === "number" ? code : (signal === null ? -1 : -1);
      if (record.stopRequested) record.status = "stopped";
      else record.status = "exited";
      log.write("\r\n[dsh-runner] 进程结束（code=" + String(record.exitCode) + (signal === null ? "" : ", signal=" + signal) + "）\r\n");
      record.logStream.end();
    });
    return this.snapshot(record);
  }

  async stop(commandId) {
    const record = this.records.get(String(commandId));
    if (record === undefined || record.status !== "running") return false;
    record.stopRequested = true;
    if (typeof record.pid === "number") {
      try {
        spawnSync("taskkill.exe", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true });
      } catch (_error) {
        /* 还会走 child.kill 兜底 */
      }
    }
    try {
      record.child.kill();
    } catch (_error) {
      /* ignore */
    }
    return true;
  }

  snapshot(record) {
    return {
      commandId: record.commandId,
      title: record.title,
      command: record.command,
      logPath: record.logPath,
      pid: record.pid,
      startedAt: record.startedAt,
      status: record.status,
      exitCode: record.exitCode
    };
  }

  list() {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  async disposeAll() {
    this.disposed = true;
    const running = [...this.records.values()].filter((record) => record.status === "running");
    await Promise.all(running.map((record) => this.stop(record.commandId)));
  }
}
