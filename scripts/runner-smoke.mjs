// Host 项目级运行器的离线验证（真实启动 powershell / node 子进程）。
//
// 覆盖 SPEC 第 5 节 runner-smoke 的 8 项：
//   1) 短命令 -> 日志 -> exited/exitCode；
//   2) stop 返回时状态立即非 running；stopProject 路径写法归一化；restart；
//   3) 端口冲突 -> diagnose(listening/!managed) -> killPort -> start 成功；
//   4) readyPort：监听端口 -> start 返回 ready=true；diagnose managed=true；ready 超时；
//   5) dependsOn 递归启动；startAll 拓扑序与失败收集；
//   6) env 注入与 cwd；
//   7) 重启接管（shutdown 不杀 -> 新实例 init 接管 -> stop）；
//   8) log 读取/清空/截断；缺失 cwd 报错。
//
// 所有测试端口都用动态空闲端口（先 listen(0) 再关闭），不碰用户正在占用的 8001/5174 等。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { ProjectRunnerService, RunnerError } from "../host-runner.js";

const SNAPSHOT_KEYS = [
  "commandId",
  "projectPath",
  "title",
  "command",
  "cwd",
  "ports",
  "readyPort",
  "status",
  "ready",
  "exitCode",
  "pid",
  "startedAt",
  "logPath",
  "logBytes",
  "adopted"
];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(120);
  }
  throw new Error("等待超时：" + label);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function getFreePorts(count) {
  const ports = [];
  while (ports.length < count) {
    const port = await freePort();
    if (ports.indexOf(port) === -1) ports.push(port);
  }
  return ports;
}

function canConnect(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: port, timeout: timeoutMs });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-runner-smoke-"));
const projectRoot = path.join(dir, "project");
const depProjectRoot = path.join(dir, "project-deps");
const subDir = path.join(projectRoot, "sub");
const logDir = path.join(dir, "logs");
const statePath = path.join(dir, "runner-state.json");

await mkdir(projectRoot, { recursive: true });
await mkdir(depProjectRoot, { recursive: true });
await mkdir(subDir, { recursive: true });

// 监听端口的测试脚本：端口来自环境变量，命令用 node 启动它（形成 powershell -> node 的进程树）。
const listenScript = path.join(dir, "listen.cjs");
await writeFile(listenScript, [
  'const net = require("node:net");',
  "const port = Number(process.env.SMOKE_PORT);",
  "const server = net.createServer((socket) => socket.end());",
  'server.listen(port, "127.0.0.1");',
  "server.on(\"error\", () => process.exit(1));",
  "setInterval(() => {}, 1000);"
].join("\n"), "utf8");

function makeCommand(overrides = {}) {
  const command = {
    id: "smoke-cmd",
    title: "冒烟命令",
    command: "Write-Output hi",
    cwd: "",
    scope: "project",
    projectRoot: projectRoot,
    enabled: true,
    env: {},
    ports: [],
    readyPort: null,
    readyTimeoutMs: 120000,
    dependsOn: []
  };
  return Object.assign(command, overrides);
}

function createRunner() {
  return new ProjectRunnerService({
    logDir,
    statePath,
    logger: {
      error(message, error) {
        // 测试里把 Host 记录的异常打印出来，方便定位失败原因。
        console.error("[runner-logger] " + message + (error === undefined ? "" : " :: " + String(error)));
      }
    }
  });
}

let runner;
let occupant;
try {
  runner = createRunner();
  await runner.init();

  // ── 1) 短命令：日志 + 退出状态 + snapshot 契约字段 ──────────────────────
  const shortCommand = makeCommand({
    id: "short",
    title: "短命令",
    command: "Write-Output 'hello-runner'; Write-Output ((Get-Location).Path)"
  });
  const shortStarted = await runner.start(shortCommand, projectRoot);
  assert.equal(shortStarted.status, "running");
  assert.equal(shortStarted.ready, null, "没有 readyPort 时 ready 必须是 null");
  assert.equal(shortStarted.readyPort, null);
  assert.equal(shortStarted.adopted, false);
  assert.deepEqual(Object.keys(shortStarted).sort(), SNAPSHOT_KEYS.slice().sort(), "snapshot 字段必须与契约一致");

  const shortFinished = await waitFor(() => {
    const record = runner.list(projectRoot).find((entry) => entry.commandId === "short");
    return record !== undefined && record.status !== "running" ? record : undefined;
  }, 20000, "短命令退出");
  assert.equal(shortFinished.status, "exited");
  assert.equal(shortFinished.exitCode, 0);
  assert.ok(shortFinished.logBytes > 0, "日志应有内容");
  const shortLog = await readFile(shortFinished.logPath, "utf8");
  assert.match(shortLog, /hello-runner/);
  assert.match(shortLog, /\[dsh-runner\].*启动：短命令/);
  assert.match(shortLog, /进程结束（code=0/);
  assert.match(shortLog, new RegExp(escapeRegExp(projectRoot), "i"), "cwd 为空时应使用 projectRoot");
  assert.equal(runner.list("H:\\OtherProject").length, 0, "按项目过滤");

  // ── 2) stop 立即落状态；stopProject 路径写法归一化；restart ─────────────
  const longCommand = makeCommand({ id: "long", title: "长命令", command: "Start-Sleep -Seconds 30" });
  const longStarted = await runner.start(longCommand, projectRoot);
  assert.equal(longStarted.status, "running");
  const longAgain = await runner.start(longCommand, projectRoot);
  assert.equal(longAgain.pid, longStarted.pid, "已运行时再次 start 应直接返回现有 runner");
  assert.equal(await runner.stop(projectRoot, "long"), true);
  const longStopped = runner.list(projectRoot).find((entry) => entry.commandId === "long");
  assert.notEqual(longStopped.status, "running", "stop() 返回后状态必须立即不是 running");
  assert.equal(await runner.stop(projectRoot, "long"), false, "重复停止应返回 false");
  assert.equal(pidAlive(longStarted.pid), false, "stop 返回后进程应已退出");

  const pathCommand = makeCommand({ id: "path", title: "路径命令", command: "Start-Sleep -Seconds 30" });
  const pathStarted = await runner.start(pathCommand, projectRoot);
  assert.equal(pathStarted.status, "running");
  const variantProjectPath = projectRoot.replace(/\\/g, "/").toLowerCase() + "/";
  assert.equal(await runner.stopProject(variantProjectPath), 1, "不同写法的项目路径必须能停到同一条命令");
  assert.notEqual(
    runner.list(projectRoot).find((entry) => entry.commandId === "path").status,
    "running",
    "stopProject 后进程必须是停止状态"
  );

  const restartCommand = makeCommand({ id: "restart", title: "重启命令", command: "Start-Sleep -Seconds 30" });
  const restartFirst = await runner.start(restartCommand, projectRoot);
  const restartSecond = await runner.restart(restartCommand, projectRoot);
  assert.equal(restartSecond.status, "running");
  assert.notEqual(restartSecond.pid, restartFirst.pid, "restart 必须换新进程");
  await runner.stop(projectRoot, "restart");

  // ── 3) 端口冲突：port-conflict -> diagnose -> killPort -> 再 start 成功 ──
  const [occupantPort] = await getFreePorts(1);
  occupant = spawn(process.execPath, [listenScript], {
    env: Object.assign({}, process.env, { SMOKE_PORT: String(occupantPort) }),
    windowsHide: true,
    stdio: "ignore"
  });
  await waitFor(() => canConnect(occupantPort), 15000, "外部占用进程开始监听");

  const conflictCommand = makeCommand({
    id: "conflict",
    title: "冲突命令",
    command: "Start-Sleep -Seconds 30",
    ports: [occupantPort]
  });
  const conflictCommands = [conflictCommand];
  await assert.rejects(
    () => runner.start(conflictCommand, projectRoot, { commands: conflictCommands }),
    (error) => {
      assert.ok(error instanceof RunnerError, "端口冲突应抛 RunnerError");
      assert.equal(error.code, "port-conflict");
      assert.ok(Array.isArray(error.details.ports), "port-conflict 应带 ports 列表");
      assert.equal(error.details.ports.length, 1);
      const conflict = error.details.ports[0];
      assert.equal(conflict.port, occupantPort);
      const occupantInfo = conflict.occupant;
      assert.ok(occupantInfo !== null && typeof occupantInfo === "object");
      assert.equal(occupantInfo.pid, occupant.pid, "occupant 应带占用者 pid");
      assert.equal(occupantInfo.managed, false, "外部进程不应标记为托管");
      assert.ok(typeof occupantInfo.name === "string" && occupantInfo.name !== "", "occupant 应带进程名");
      assert.ok(
        typeof occupantInfo.commandLine === "string" && occupantInfo.commandLine.includes("listen.cjs"),
        "occupant 应带命令行"
      );
      assert.ok(Array.isArray(occupantInfo.ancestors), "occupant 应带父进程链");
      assert.ok(occupantInfo.ancestors.length > 0, "外部 node 进程应有父进程");
      assert.ok(Array.isArray(occupantInfo.children), "occupant 应带子进程列表");
      assert.ok(typeof occupantInfo.windowTitle === "string", "occupant 应带窗口标题字段");
      assert.ok(String(error.message).includes(occupantInfo.name), "错误消息应带进程名");
      return true;
    }
  );

  const diagnoseEntries = await runner.diagnose(conflictCommands, projectRoot);
  const occupiedEntry = diagnoseEntries.find((entry) => entry.port === occupantPort);
  assert.ok(occupiedEntry !== undefined, "diagnose 应包含该端口");
  assert.equal(occupiedEntry.listening, true);
  assert.equal(occupiedEntry.occupant.pid, occupant.pid);
  assert.equal(occupiedEntry.occupant.managed, false);
  assert.equal(occupiedEntry.commandId, "conflict");
  assert.equal(occupiedEntry.title, "冲突命令");

  // 确认后端口换了主人：expected pid 不一致时必须拒绝，避免误杀
  await assert.rejects(
    () => runner.killPort(projectRoot, occupantPort, occupant.pid + 1),
    (error) => {
      assert.equal(error.code, "port-changed");
      assert.equal(error.details.pid, occupant.pid);
      assert.equal(error.details.expectedPid, occupant.pid + 1);
      return true;
    }
  );

  const killedResult = await runner.killPort(projectRoot, occupantPort, occupant.pid);
  assert.equal(killedResult.killed, true);
  assert.equal(killedResult.pid, occupant.pid);
  assert.equal(killedResult.occupant.pid, occupant.pid);
  await waitFor(async () => !(await canConnect(occupantPort)), 8000, "killPort 后端口释放");
  const afterKillDiagnose = await runner.diagnose(conflictCommands, projectRoot);
  const releasedEntry = afterKillDiagnose.find((entry) => entry.port === occupantPort);
  assert.ok(releasedEntry !== undefined);
  assert.equal(releasedEntry.listening, false, "killPort 后 diagnose 应显示端口未监听");
  assert.equal(releasedEntry.occupant, undefined);

  const conflictStarted = await runner.start(conflictCommand, projectRoot, { commands: conflictCommands });
  assert.equal(conflictStarted.status, "running");
  await runner.stop(projectRoot, "conflict");

  // ── 4) readyPort：start 等到端口可连；diagnose managed=true ─────────────
  const [readyPort] = await getFreePorts(1);
  const readyCommand = makeCommand({
    id: "ready",
    title: "就绪服务",
    command: 'node "' + listenScript + '"',
    env: { SMOKE_PORT: String(readyPort) },
    ports: [readyPort],
    readyPort: readyPort,
    readyTimeoutMs: 20000
  });
  const readyStarted = await runner.start(readyCommand, projectRoot, { commands: [readyCommand] });
  assert.equal(readyStarted.status, "running");
  assert.equal(readyStarted.ready, true, "readyPort 可连接后 ready 必须是 true");
  assert.equal(readyStarted.readyPort, readyPort);
  assert.equal(await canConnect(readyPort), true, "start 返回时端口应已可连接");

  const readyDiagnose = await runner.diagnose([readyCommand], projectRoot);
  const readyEntry = readyDiagnose.find((entry) => entry.port === readyPort);
  assert.ok(readyEntry !== undefined);
  assert.equal(readyEntry.listening, true);
  assert.equal(readyEntry.occupant.managed, true, "监听进程应属于运行中 runner 的进程树");
  assert.equal(readyEntry.occupant.runnerCommandId, "ready");
  assert.equal(readyEntry.occupant.runnerTitle, "就绪服务");

  await assert.rejects(
    () => runner.killPort(projectRoot, readyPort, readyEntry.occupant.pid),
    (error) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "managed-port", "托管 runner 的端口不允许 killPort");
      assert.equal(error.details.runnerCommandId, "ready");
      assert.equal(error.details.occupant.managed, true);
      return true;
    }
  );

  await runner.stop(projectRoot, "ready");
  const readyStopped = runner.list(projectRoot).find((entry) => entry.commandId === "ready");
  assert.notEqual(readyStopped.status, "running");
  await waitFor(async () => !(await canConnect(readyPort)), 8000, "停止后 ready 端口释放");

  // ready 超时：Host 必须杀进程并报 ready-timeout
  const [timeoutPort] = await getFreePorts(1);
  const timeoutCommand = makeCommand({
    id: "ready-timeout",
    title: "就绪超时",
    command: "Start-Sleep -Seconds 30",
    ports: [timeoutPort],
    readyPort: timeoutPort,
    readyTimeoutMs: 1000
  });
  await assert.rejects(
    () => runner.start(timeoutCommand, projectRoot),
    (error) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "ready-timeout");
      assert.equal(error.details.port, timeoutPort);
      assert.equal(error.details.timeoutMs, 1000);
      return true;
    }
  );
  const timedOut = runner.list(projectRoot).find((entry) => entry.commandId === "ready-timeout");
  assert.notEqual(timedOut.status, "running", "ready 超时后进程不能还在 running");
  assert.equal(pidAlive(timedOut.pid), false, "ready 超时后 Host 必须杀掉进程");

  // ── 5) dependsOn：递归启动；startAll 拓扑序与失败收集 ───────────────────
  const depCommandA = makeCommand({
    id: "dep-a",
    title: "依赖A",
    command: "Start-Sleep -Seconds 30",
    projectRoot: depProjectRoot
  });
  const depCommandB = makeCommand({
    id: "dep-b",
    title: "依赖B",
    command: "Start-Sleep -Seconds 30",
    projectRoot: depProjectRoot,
    dependsOn: ["dep-a"]
  });
  const disabledDependency = makeCommand({
    id: "dep-disabled",
    title: "停用的依赖",
    command: "Start-Sleep -Seconds 30",
    projectRoot: depProjectRoot,
    enabled: false
  });
  const dependentOnDisabled = makeCommand({
    id: "dep-c",
    title: "依赖停用命令",
    command: "Start-Sleep -Seconds 30",
    projectRoot: depProjectRoot,
    dependsOn: ["dep-disabled"]
  });
  const missingCwdCommand = makeCommand({
    id: "dep-bad",
    title: "坏工作目录",
    command: "echo x",
    cwd: path.join(dir, "does-not-exist"),
    projectRoot: depProjectRoot
  });
  const globalCommand = makeCommand({
    id: "dep-global",
    title: "全局命令",
    command: "Start-Sleep -Seconds 30",
    scope: "global",
    projectRoot: ""
  });
  const depCommands = [depCommandA, depCommandB, disabledDependency, dependentOnDisabled, missingCwdCommand, globalCommand];

  const depStarted = await runner.start(depCommandB, depProjectRoot, { commands: depCommands });
  assert.equal(depStarted.status, "running");
  const depRunners = runner.list(depProjectRoot);
  assert.equal(depRunners.find((entry) => entry.commandId === "dep-a").status, "running", "依赖 A 应被自动启动");
  assert.equal(depRunners.find((entry) => entry.commandId === "dep-b").status, "running");
  await runner.stopProject(depProjectRoot);

  await assert.rejects(
    () => runner.start(dependentOnDisabled, depProjectRoot, { commands: depCommands }),
    (error) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "dependency-failed");
      assert.equal(error.details.commandId, "dep-disabled");
      assert.ok(typeof error.details.message === "string" && error.details.message !== "");
      return true;
    }
  );

  const allResult = await runner.startAll(depCommands, depProjectRoot);
  assert.ok(allResult.started.includes("dep-a"));
  assert.ok(allResult.started.includes("dep-b"));
  assert.ok(
    allResult.started.indexOf("dep-a") < allResult.started.indexOf("dep-b"),
    "startAll 必须按依赖拓扑序启动（A 先于 B）"
  );
  assert.equal(allResult.started.includes("dep-global"), false, "startAll 只启动 project 作用域命令");
  assert.ok(allResult.started.includes("dep-bad") === false);
  assert.ok(allResult.failed.some((item) => item.commandId === "dep-bad" && item.code === "spawn-failed"), "失败要收集");
  assert.ok(allResult.failed.some((item) => item.commandId === "dep-c" && item.code === "dependency-failed"));
  assert.equal(allResult.failed.some((item) => item.commandId === "dep-disabled"), false);
  assert.equal(allResult.runners.filter((entry) => entry.status === "running").length, 2, "A/B 应在运行");
  await runner.stopProject(depProjectRoot);

  // ── 6) env 注入与 cwd ──────────────────────────────────────────────────
  const envCommand = makeCommand({
    id: "env",
    title: "环境变量",
    command: 'Write-Output ("FOO=" + $env:FOO); Write-Output ((Get-Location).Path)',
    cwd: subDir,
    env: { FOO: "bar-baz" }
  });
  await runner.start(envCommand, projectRoot);
  const envFinished = await waitFor(() => {
    const record = runner.list(projectRoot).find((entry) => entry.commandId === "env");
    return record !== undefined && record.status !== "running" ? record : undefined;
  }, 20000, "env 命令退出");
  assert.equal(envFinished.exitCode, 0);
  const envLog = await runner.readLog("env", projectRoot);
  assert.match(envLog.text, /FOO=bar-baz/, "命令应看到注入的环境变量");
  assert.match(envLog.text, new RegExp(escapeRegExp(subDir), "i"), "命令应在 cwd 里执行");

  // ── 7) 重启接管：shutdown 不杀 -> 新实例 init 接管 -> stop ──────────────
  const adoptCommand = makeCommand({ id: "adopt", title: "接管命令", command: "Start-Sleep -Seconds 60" });
  const adoptStarted = await runner.start(adoptCommand, projectRoot);
  assert.equal(adoptStarted.status, "running");
  await runner.shutdown();
  assert.equal(pidAlive(adoptStarted.pid), true, "shutdown 只落盘，不应杀进程");

  runner = createRunner();
  await runner.init();
  const adopted = runner.list(projectRoot).find((entry) => entry.commandId === "adopt");
  assert.ok(adopted !== undefined, "Host 重启后应接管仍在运行的进程");
  assert.equal(adopted.status, "running");
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.pid, adoptStarted.pid);
  assert.equal(await runner.stop(projectRoot, "adopt"), true, "接管进程必须能被停止");
  const afterAdoptStop = runner.list(projectRoot).find((entry) => entry.commandId === "adopt");
  assert.notEqual(afterAdoptStop.status, "running");
  assert.equal(pidAlive(adoptStarted.pid), false);
  const adoptLog = await readFile(afterAdoptStop.logPath, "utf8");
  assert.match(adoptLog, /接管进程已结束|进程结束/);
  const stateAfterStop = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(stateAfterStop.runners.some((entry) => entry.commandId === "adopt"), false, "停止后 state 不再包含该进程");

  // ── 8) log 读取/清空/截断；缺失 cwd 报错 ───────────────────────────────
  const bigCommand = makeCommand({
    id: "big",
    title: "大日志",
    command: "1..300 | ForEach-Object { Write-Output ('line-' + $_) }"
  });
  await runner.start(bigCommand, projectRoot);
  const bigFinished = await waitFor(() => {
    const record = runner.list(projectRoot).find((entry) => entry.commandId === "big");
    return record !== undefined && record.status !== "running" ? record : undefined;
  }, 20000, "大日志命令退出");
  assert.equal(bigFinished.exitCode, 0);
  const bigTail = await runner.readLog("big", projectRoot, 1024);
  assert.equal(bigTail.truncated, true, "日志超过 maxBytes 时 truncated=true");
  assert.ok(bigTail.bytes > 1024);
  assert.match(bigTail.text, /line-300/);
  const bigFull = await runner.readLog("big", projectRoot);
  assert.equal(bigFull.truncated, false);

  await runner.clearLog("big", projectRoot);
  const clearedLog = await runner.readLog("big", projectRoot);
  assert.equal(clearedLog.text, "", "清空后日志为空");
  assert.equal(clearedLog.bytes, 0);

  const emptyLog = await runner.readLog("no-such-command", projectRoot);
  assert.equal(emptyLog.text, "");
  assert.equal(emptyLog.bytes, 0);
  assert.equal(emptyLog.truncated, false);

  await assert.rejects(
    () => runner.readLog("big", projectRoot, 10),
    (error) => error instanceof RunnerError && error.code === "bad-request",
    "maxBytes 越界应报 bad-request"
  );

  await assert.rejects(
    () => runner.start(makeCommand({ id: "missing-cwd", title: "缺目录", command: "echo x", cwd: path.join(dir, "does-not-exist") }), projectRoot),
    (error) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "spawn-failed");
      assert.match(error.message, /工作目录不存在/);
      return true;
    }
  );
  assert.equal(runner.list(projectRoot).some((entry) => entry.commandId === "missing-cwd"), false, "缺 cwd 不应留下 runner 记录");

  console.log(JSON.stringify({
    ok: true,
    ports: { occupant: occupantPort, ready: readyPort, timeout: timeoutPort },
    snapshotKeys: SNAPSHOT_KEYS.length
  }, null, 2));
} finally {
  if (occupant !== undefined && pidAlive(occupant.pid)) {
    occupant.kill("SIGKILL");
  }
  if (runner !== undefined) {
    try {
      await runner.stopProject(projectRoot);
    } catch (error) {
      // 清理阶段的停止失败不影响已完成的断言，打印出来便于排查。
      console.error("[cleanup] stopProject(project) 失败：" + String(error));
    }
    try {
      await runner.stopProject(depProjectRoot);
    } catch (error) {
      console.error("[cleanup] stopProject(depProject) 失败：" + String(error));
    }
    await runner.shutdown();
  }
  await rm(dir, { recursive: true, force: true });
}
