// Host 项目级运行器的离线验证：启动短命令、检查日志、按项目过滤、停止。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { ProjectRunnerService } from "../host-runner.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-runner-host-"));
try {
  const runner = new ProjectRunnerService({ logDir: dir });
  const project = "H:\\运行插件";
  const short = await runner.start({
    id: "smoke-short",
    title: "短命令",
    command: "Write-Output 'hello-project-runner'; Write-Output ((Get-Location).Path)",
    cwd: "",
    scope: "project",
    enabled: true
  }, project);
  assert.equal(short.status, "running");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const status = runner.list(project).find((item) => item.commandId === "smoke-short");
  assert.notEqual(status, undefined);
  assert.notEqual(status.status, "running");
  const log = await readFile(status.logPath, "utf8");
  assert.match(log, /hello-project-runner/);
  assert.match(log, /H:\\运行插件/i);
  assert.equal(runner.list("H:\\OtherProject").length, 0);

  const long = await runner.start({
    id: "smoke-long",
    title: "长命令",
    command: "Start-Sleep -Seconds 20",
    cwd: "",
    scope: "project",
    enabled: true
  }, project);
  assert.equal(long.status, "running");
  assert.equal(await runner.stop(project, "smoke-long"), true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const stopped = runner.list(project).find((item) => item.commandId === "smoke-long");
  assert.notEqual(stopped.status, "running");
  await runner.disposeAll();
  console.log(JSON.stringify({ ok: true, status: stopped.status, logPath: status.logPath }, null, 2));
} finally {
  await rm(dir, { recursive: true, force: true });
}
