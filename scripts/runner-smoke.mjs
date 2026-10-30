// Host 全局运行器的离线验证：启动一个短命令并检查日志，再验证停止。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { GlobalRunnerService } from "../host-runner.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-runner-host-"));
try {
  const runner = new GlobalRunnerService({ logDir: dir });
  const short = await runner.start({
    id: "smoke-short",
    title: "短命令",
    command: "Write-Output 'hello-dsh-runner'",
    cwd: "H:\\运行插件",
    scope: "global",
    enabled: true
  });
  assert.equal(short.status, "running");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const status = runner.list().find((item) => item.commandId === "smoke-short");
  assert.notEqual(status, undefined);
  assert.notEqual(status.status, "running");
  const log = await readFile(status.logPath, "utf8");
  assert.match(log, /hello-dsh-runner/);

  const long = await runner.start({
    id: "smoke-long",
    title: "长命令",
    command: "Start-Sleep -Seconds 20",
    cwd: "H:\\运行插件",
    scope: "global",
    enabled: true
  });
  assert.equal(long.status, "running");
  assert.equal(await runner.stop("smoke-long"), true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const stopped = runner.list().find((item) => item.commandId === "smoke-long");
  assert.notEqual(stopped.status, "running");
  await runner.disposeAll();
  console.log(JSON.stringify({ ok: true, status: stopped.status, logPath: status.logPath }, null, 2));
} finally {
  await rm(dir, { recursive: true, force: true });
}
