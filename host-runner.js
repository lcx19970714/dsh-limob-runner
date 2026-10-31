// dsh-runner 的「项目级」后台进程管理。
//
// DSH 自带的右侧栏终端是会话级的：切换会话终端就不见了。项目级命令不应该跟会话走，
// 所以这里由 Host 按「项目路径 + 命令」启动独立进程，输出写到项目日志文件；
// 浏览器在任意会话里开一个「跟随日志」的原生终端来显示，从而做到切会话仍可见。
//
// 这是只读日志方案：真正的进程在 Host，右侧终端只负责 Get-Content -Wait。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  return String(value === undefined || value === null ? "" : value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "value";
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

function samePath(left, right) {
  const a = String(left === undefined || left === null ? "" : left).trim().replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
  const b = String(right === undefined || right === null ? "" : right).trim().replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
  return a !== "" && a === b;
}

function projectHash(projectPath) {
  return createHash("sha1").update(String(projectPath).toLowerCase()).digest("hex").slice(0, 12);
}

function buildCommandText(command, cwd) {
  const parts = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "chcp 65001 | Out-Null",
    "$env:PATH = (Join-Path $env:USERPROFILE '.cargo\\bin') + ';' + $env:PATH"
  ];
  if (typeof cwd === "string" && cwd.trim() !== "") {
    parts.push("Set-Location -LiteralPath '" + escapePowerShell(cwd.trim()) + "'");
  }
  parts.push(command.command);
  return parts.join("; ");
}

/** 一个项目路径下，一个命令最多一个进程。 */
export class ProjectRunnerService {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(os.homedir(), ".dsh", "dsh-runner", "logs");
    this.records = new Map();
  }

  key(projectPath, commandId) {
    return String(projectPath).toLowerCase() + "\u0000" + String(commandId);
  }

  async start(command, projectPath) {
    if (command === null || command === undefined || typeof command !== "object") throw new Error("start 需要命令对象");
    if (typeof projectPath !== "string" || projectPath.trim() === "") throw new Error("项目级运行需要项目路径");
    const workspace = projectPath.trim();
    const key = this.key(workspace, command.id);
    const previous = this.records.get(key);
    if (previous !== undefined && previous.status === "running") return this.snapshot(previous);

    const effectiveCwd = typeof command.cwd === "string" && command.cwd.trim() !== "" ? command.cwd.trim() : workspace;
    const dir = path.join(this.logDir, projectHash(workspace));
    await mkdir(dir, { recursive: true });
    const logPath = path.join(dir, safeFilePart(command.id) + ".log");
    const log = createWriteStream(logPath, { flags: "a" });
    log.write("\r\n[dsh-runner] " + new Date().toLocaleString() + " 启动：" + command.title + "（" + workspace + "）\r\n");

    const shell = resolvePowerShell();
    const child = spawn(shell, ["-NoLogo", "-NoProfile", "-Command", buildCommandText(command, effectiveCwd)], {
      cwd: effectiveCwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const record = {
      key: key,
      projectPath: workspace,
      commandId: command.id,
      title: command.title,
      terminalTitle: command.terminalTitle,
      command: command.command,
      cwd: effectiveCwd,
      logPath: logPath,
      logStream: log,
      child: child,
      pid: child.pid,
      startedAt: Date.now(),
      status: "running",
      exitCode: undefined,
      stopRequested: false
    };
    this.records.set(key, record);

    child.stdout.on("data", (chunk) => { log.write(chunk); });
    child.stderr.on("data", (chunk) => { log.write(chunk); });
    child.on("error", (error) => {
      log.write("\r\n[dsh-runner] 启动失败：" + String(error) + "\r\n");
      record.status = "failed";
      record.exitCode = -1;
      record.logStream.end();
    });
    child.on("exit", (code, signal) => {
      record.exitCode = typeof code === "number" ? code : -1;
      record.status = record.stopRequested ? "stopped" : "exited";
      log.write("\r\n[dsh-runner] 进程结束（code=" + String(record.exitCode) + (signal === null ? "" : ", signal=" + signal) + "）\r\n");
      record.logStream.end();
    });
    return this.snapshot(record);
  }

  async stop(projectPath, commandId) {
    const record = this.records.get(this.key(projectPath, commandId));
    if (record === undefined || record.status !== "running") return false;
    record.stopRequested = true;
    if (typeof record.pid === "number") {
      try {
        spawnSync("taskkill.exe", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true });
      } catch (_error) {
        /* child.kill 兜底 */
      }
    }
    try { record.child.kill(); } catch (_error) { /* ignore */ }
    return true;
  }

  async stopProject(projectPath) {
    const keys = [...this.records.values()].filter((record) => samePath(record.projectPath, projectPath) && record.status === "running").map((record) => record.commandId);
    for (const commandId of keys) await this.stop(projectPath, commandId);
    return keys.length;
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
      exitCode: record.exitCode
    };
  }

  list(projectPath) {
    const all = [...this.records.values()];
    const filtered = typeof projectPath === "string" && projectPath.trim() !== ""
      ? all.filter((record) => samePath(record.projectPath, projectPath))
      : all;
    return filtered.map((record) => this.snapshot(record));
  }

  async disposeAll() {
    const running = [...this.records.values()].filter((record) => record.status === "running");
    await Promise.all(running.map((record) => this.stop(record.projectPath, record.commandId)));
  }
}
