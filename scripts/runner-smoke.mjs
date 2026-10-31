// Host 项目级运行器的离线验证。
//
// 覆盖第一性原理里的关键不变量：
//   1) 启动 -> 日志落盘 -> 按项目过滤；
//   2) stop() 返回时状态必须已经离开 running（UI 不依赖 exit 事件时序）；
//   3) stopProject() 对路径写法（大小写/斜杠/尾斜杠）不敏感，且按真实停止数计数；
//   4) Host 重启后从 state 文件接管仍在运行的进程（pid + 命令行标记校验）；
//   5) shutdown() 不杀进程；停止后 state 文件不再包含该进程。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { ProjectRunnerService } from "../host-runner.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-runner-host-"));
const statePath = path.join(dir, "runner-state.json");
const logDir = path.join(dir, "logs");
const project = "H:\\运行插件";

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

let runner;
try {
  // 1) 短命令：日志 + 项目过滤 + 退出状态
  runner = new ProjectRunnerService({ logDir, statePath });
  await runner.init();
  const short = await runner.start({
    id: "smoke-short",
    title: "短命令",
    command: "Write-Output 'hello-project-runner'; Write-Output ((Get-Location).Path)",
    cwd: "",
    scope: "project",
    enabled: true
  }, project);
  assert.equal(short.status, "running");
  const finished = await waitFor(() => {
    const item = runner.list(project).find((entry) => entry.commandId === "smoke-short");
    return item !== undefined && item.status !== "running" ? item : undefined;
  }, 15000, "短命令退出");
  const shortLog = await readFile(finished.logPath, "utf8");
  assert.match(shortLog, /hello-project-runner/);
  assert.match(shortLog, /H:\\运行插件/i);
  assert.match(shortLog, /进程结束/);
  assert.equal(finished.exitCode, 0);
  assert.equal(runner.list("H:\\OtherProject").length, 0);

  // 2) stop() 返回时状态必须已离开 running（旧实现在这里会返回 running）
  const long = await runner.start({
    id: "smoke-long",
    title: "长命令",
    command: "Start-Sleep -Seconds 30",
    cwd: "",
    scope: "project",
    enabled: true
  }, project);
  assert.equal(long.status, "running");
  assert.equal(await runner.stop(project, "smoke-long"), true);
  const stoppedNow = runner.list(project).find((entry) => entry.commandId === "smoke-long");
  assert.notEqual(stoppedNow.status, "running", "stop() 返回后状态必须立即不是 running");
  assert.equal(await runner.stop(project, "smoke-long"), false, "重复停止应返回 false");

  // 3) stopProject() 路径写法归一化：大小写 + 正斜杠 + 尾斜杠都要能停
  const pathTarget = await runner.start({
    id: "smoke-path",
    title: "路径命令",
    command: "Start-Sleep -Seconds 30",
    cwd: "",
    scope: "project",
    enabled: true
  }, project);
  assert.equal(pathTarget.status, "running");
  const stoppedCount = await runner.stopProject("h:/运行插件/");
  assert.equal(stoppedCount, 1, "不同写法的项目路径必须能停到同一条命令");
  assert.notEqual(
    runner.list(project).find((entry) => entry.commandId === "smoke-path").status,
    "running",
    "stopProject 后进程必须是停止状态"
  );

  // 4) Host 重启接管：shutdown() 不杀进程，新实例 init() 后必须接管
  const adoptedTarget = await runner.start({
    id: "smoke-adopt",
    title: "接管命令",
    command: "Start-Sleep -Seconds 60",
    cwd: "",
    scope: "project",
    enabled: true
  }, project);
  assert.equal(adoptedTarget.status, "running");
  await runner.shutdown();
  runner = new ProjectRunnerService({ logDir, statePath });
  await runner.init();
  const adopted = runner.list(project).find((entry) => entry.commandId === "smoke-adopt");
  assert.notEqual(adopted, undefined, "Host 重启后应接管仍在运行的进程");
  assert.equal(adopted.status, "running");
  assert.equal(adopted.adopted, true);
  assert.equal(await runner.stop(project, "smoke-adopt"), true, "接管进程必须能被停止");
  const afterAdoptStop = runner.list(project).find((entry) => entry.commandId === "smoke-adopt");
  assert.notEqual(afterAdoptStop.status, "running");
  const adoptedLog = await readFile(afterAdoptStop.logPath, "utf8");
  assert.match(adoptedLog, /接管进程已结束|进程结束/);

  // 5) 停止后 state 文件不再包含该进程
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.runners.some((entry) => entry.commandId === "smoke-adopt"), false);

  // 6) 不存在的工作目录要给出可读错误，而不是 spawn 失败
  await assert.rejects(
    () => runner.start({ id: "smoke-missing-cwd", title: "x", command: "echo x", cwd: path.join(dir, "does-not-exist"), scope: "project", enabled: true }, project),
    /工作目录不存在/
  );

  console.log(JSON.stringify({ ok: true, logPath: finished.logPath, adoptedPid: adopted.pid }, null, 2));
} finally {
  if (runner !== undefined) {
    try {
      await runner.stopProject(project);
    } catch (_error) {
      /* ignore */
    }
    await runner.shutdown();
  }
  await rm(dir, { recursive: true, force: true });
}
