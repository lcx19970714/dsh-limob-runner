// Host 侧配置存储的离线冒烟测试。
// 不启动 DSH，只验证 commands.json 的读写和 CRUD，避免 AI Tool 改坏配置格式。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createCommand,
  defaultConfig,
  deleteCommand,
  loadConfig,
  normalizeConfig,
  saveConfigFile,
  updateCommand
} from "../host-config.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-limob-host-"));
const file = path.join(dir, "commands.json");
try {
  const defaults = defaultConfig();
  assert.equal(defaults.commands.length, 4);

  // 文件不存在时给默认配置
  const missing = await loadConfig(file);
  assert.equal(missing.exists, false);
  assert.equal(missing.config.commands.length, 4);

  // 写入并读回
  await saveConfigFile(file, defaults);
  const loaded = await loadConfig(file);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.config.commands.length, 4);
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.version, 1);

  // 项目作用域默认使用调用方工作区
  const created = createCommand(loaded.config, {
    title: "启动开发服务器",
    command: "pnpm dev"
  }, "H:\\Limob-windows");
  assert.equal(created.command.scope, "project");
  assert.equal(created.command.projectRoot, "H:\\Limob-windows");
  assert.equal(created.command.cwd, "H:\\Limob-windows");
  assert.equal(created.command.utf8CodePage, false);

  // 全局命令默认不锁死 cwd（运行时用当前项目路径）
  const globalCreated = createCommand(created.config, {
    title: "全局启动",
    command: "pnpm dev",
    scope: "global"
  }, "H:\\Limob-windows");
  assert.equal(globalCreated.command.scope, "global");
  assert.equal(globalCreated.command.projectRoot, "");
  assert.equal(globalCreated.command.cwd, "");

  // 中文命令自动 chcp
  const chinese = createCommand(created.config, {
    command: "pnpm 客户端-调试"
  }, "H:\\Limob-windows");
  assert.equal(chinese.command.utf8CodePage, true);

  // 更新：按标题找到并改名
  const updated = updateCommand(chinese.config, "启动开发服务器", { title: "启动开发服务器-改" });
  assert.equal(updated.command.id, created.command.id);
  assert.equal(updated.command.title, "启动开发服务器-改");

  // 删除
  const deleted = deleteCommand(updated.config, updated.command.id);
  assert.equal(deleted.config.commands.some((command) => command.id === created.command.id), false);
  assert.equal(deleted.command.title, "启动开发服务器-改");

  // 保存后读回仍合法
  const saved = await saveConfigFile(file, deleted.config);
  assert.equal(saved.commands.length, 5);
  const reloaded = await loadConfig(file);
  assert.equal(reloaded.config.commands.length, 5);

  // 非法配置收敛
  assert.equal(normalizeConfig({ commands: "bad" }).commands.length, 0);
  assert.throws(() => createCommand(defaultConfig(), { command: "" }, undefined), /需要 command/);

  console.log(JSON.stringify({ ok: true, file, commands: saved.commands.length }, null, 2));
} finally {
  await rm(dir, { recursive: true, force: true });
}
