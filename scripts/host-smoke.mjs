// Host 侧配置存储（commands.json version 2）的离线冒烟测试。
//
// 覆盖 SPEC 第 1 节与第 5 节 host-smoke：
//   - 默认配置为空；
//   - normalize 校验（env key、ports、readyPort∈ports、dependsOn 存在/环、未知字段忽略）；
//   - CRUD / reorder / ui；
//   - 加载时非法命令丢弃并给出错误，保存时非法直接抛错；
//   - 路径归一化与原子写入后的文件内容。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  CONFIG_VERSION,
  ConfigError,
  cleanProjectPath,
  createCommand,
  defaultConfig,
  deleteCommand,
  findCommand,
  loadConfig,
  normalizeCommand,
  normalizeConfig,
  normalizePath,
  reorderCommands,
  saveConfigFile,
  setUi,
  updateCommand
} from "../host-config.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-runner-host-smoke-"));
const file = path.join(dir, "commands.json");

function isConfigError(error) {
  return error instanceof ConfigError;
}

try {
  // ── 1. 默认配置为空（不再内置任何命令） ───────────────────────────────
  assert.equal(CONFIG_VERSION, 2);
  assert.deepEqual(defaultConfig(), { version: 2, ui: { visible: true }, commands: [] });

  const missing = await loadConfig(file);
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.config, defaultConfig());
  assert.deepEqual(missing.errors, []);

  // ── 2. normalizeCommand：合法命令的缺省值与 trim/归一化 ─────────────────
  const base = normalizeCommand({
    title: " 调试后端 ",
    command: " python -m uvicorn main:app --port 8001 ",
    scope: "project",
    projectRoot: "H:/proj/",
    cwd: "H:/proj/backend/",
    env: { APP_ENV: "dev" },
    ports: [8001, 8001]
  });
  assert.ok(base, "合法命令不应被丢弃");
  assert.equal(base.title, "调试后端");
  assert.equal(base.command, "python -m uvicorn main:app --port 8001");
  assert.equal(base.projectRoot, "H:\\proj");
  assert.equal(base.cwd, "H:\\proj\\backend");
  assert.deepEqual(base.ports, [8001], "ports 去重");
  assert.equal(base.readyPort, null);
  assert.equal(base.readyTimeoutMs, 120000);
  assert.deepEqual(base.env, { APP_ENV: "dev" });
  assert.deepEqual(base.dependsOn, []);
  assert.equal(base.enabled, true);
  assert.match(base.id, /^cmd-[a-z0-9]+-[a-z0-9]+$/);

  // 未知/旧字段被忽略，不保留、不回写
  const legacy = normalizeCommand({
    title: "旧命令",
    command: "echo hi",
    scope: "global",
    cwd: "",
    terminalTitle: "legacy-title",
    utf8CodePage: true,
    longRunning: true
  });
  assert.ok(legacy);
  for (const field of ["terminalTitle", "utf8CodePage", "longRunning"]) {
    assert.equal(Object.hasOwn(legacy, field), false, "旧字段必须被丢弃：" + field);
  }

  // 非法命令 → null
  const invalidCommands = [
    { command: "echo hi", scope: "global", cwd: "" }, // 缺 title
    { title: "x", command: "", scope: "global", cwd: "" }, // 空 command
    { title: "x", command: "echo", scope: "bad", cwd: "" }, // 非法 scope
    { title: "x", command: "echo", scope: "global", cwd: "relative/path" }, // cwd 非绝对
    { title: "x", command: "echo", scope: "project", projectRoot: "", cwd: "" }, // 项目缺 projectRoot
    { title: "x", command: "echo", scope: "project", projectRoot: "relative", cwd: "" }, // projectRoot 非绝对
    { title: "x", command: "echo", scope: "global", cwd: "", env: { "1BAD": "x" } }, // env key 非法
    { title: "x", command: "echo", scope: "global", cwd: "", env: { OK: 1 } }, // env value 非字符串
    { title: "x", command: "echo", scope: "global", cwd: "", env: ["A=1"] }, // env 非对象
    { title: "x", command: "echo", scope: "global", cwd: "", ports: [70000] }, // 端口越界
    { title: "x", command: "echo", scope: "global", cwd: "", ports: [1.5] }, // 端口非整数
    { title: "x", command: "echo", scope: "global", cwd: "", ports: [8001], readyPort: 8002 }, // readyPort 不在 ports
    { title: "x", command: "echo", scope: "global", cwd: "", readyTimeoutMs: 500 }, // 超时越界
    { id: "self-dep", title: "x", command: "echo", scope: "global", cwd: "", dependsOn: ["self-dep"] } // 依赖自身
  ];
  for (const entry of invalidCommands) {
    assert.equal(normalizeCommand(entry), null, "非法命令应返回 null：" + JSON.stringify(entry));
  }

  // dependsOn 存在性（传入 allCommands 时）
  const commandA = normalizeCommand({ id: "a", title: "A", command: "echo a", scope: "global", cwd: "" });
  assert.ok(commandA);
  assert.equal(
    normalizeCommand({ id: "b", title: "B", command: "echo b", scope: "global", cwd: "", dependsOn: ["missing"] }, [commandA]),
    null,
    "dependsOn 引用不存在的命令应非法"
  );
  const commandB = normalizeCommand({ id: "b", title: "B", command: "echo b", scope: "global", cwd: "", dependsOn: ["a", "a"] }, [commandA]);
  assert.ok(commandB);
  assert.deepEqual(commandB.dependsOn, ["a"], "dependsOn 去重");

  // ── 3. normalizeConfig：丢弃非法命令、吞掉未知字段、检测依赖环 ──────────
  const normalized = normalizeConfig({
    version: 1,
    ui: { visible: false },
    commands: [
      {
        id: "a",
        title: "A",
        command: "echo a",
        scope: "global",
        cwd: "",
        terminalTitle: "x",
        utf8CodePage: true,
        longRunning: true
      },
      { id: "bad", title: "", command: "x", scope: "global", cwd: "" },
      { id: "b", title: "B", command: "echo b", scope: "global", cwd: "", ports: [3000, 3000] }
    ]
  });
  assert.equal(normalized.version, 2);
  assert.equal(normalized.ui.visible, false);
  assert.deepEqual(normalized.commands.map((command) => command.id), ["a", "b"]);
  assert.deepEqual(normalized.commands[1].ports, [3000]);
  assert.equal(Object.hasOwn(normalized.commands[0], "terminalTitle"), false);
  assert.equal(Object.hasOwn(normalized.commands[0], "utf8CodePage"), false);

  assert.deepEqual(normalizeConfig(null), defaultConfig());
  assert.deepEqual(normalizeConfig("bad"), defaultConfig());
  assert.deepEqual(normalizeConfig({ commands: "bad" }).commands, []);

  // 依赖环：环内命令与依赖它们的命令级联丢弃，剩下的合法
  const graph = normalizeConfig({
    commands: [
      { id: "a", title: "A", command: "echo", scope: "global", cwd: "", dependsOn: ["b"] },
      { id: "b", title: "B", command: "echo", scope: "global", cwd: "", dependsOn: ["a"] },
      { id: "c", title: "C", command: "echo", scope: "global", cwd: "", dependsOn: ["a"] },
      { id: "d", title: "D", command: "echo", scope: "global", cwd: "" }
    ]
  });
  assert.deepEqual(graph.commands.map((command) => command.id), ["d"]);

  // 端口契约：同一作用域（同一 projectRoot / 全局）端口不允许重复声明
  const dupPortConfig = normalizeConfig({
    version: 2,
    ui: { visible: true },
    commands: [
      { id: "p1", title: "P1", command: "echo", scope: "project", projectRoot: "H:\\A", ports: [9000] },
      { id: "p2", title: "P2", command: "echo", scope: "project", projectRoot: "H:\\A", ports: [9000] },
      { id: "p3", title: "P3", command: "echo", scope: "project", projectRoot: "H:\\B", ports: [9000] },
      { id: "g1", title: "G1", command: "echo", scope: "global", cwd: "", ports: [9001] },
      { id: "g2", title: "G2", command: "echo", scope: "global", cwd: "", ports: [9001] }
    ]
  });
  assert.deepEqual(
    dupPortConfig.commands.map((command) => command.id),
    ["p1", "p3", "g1"],
    "同一作用域的重复端口命令必须被丢弃，不同项目可复用端口"
  );

  const dupPath = path.join(dir, "dup-ports.json");
  await assert.rejects(
    () => saveConfigFile(dupPath, {
      version: 2,
      ui: { visible: true },
      commands: [
        { id: "p1", title: "P1", command: "echo", scope: "project", projectRoot: "H:\\A", ports: [9000] },
        { id: "p2", title: "P2", command: "echo", scope: "project", projectRoot: "H:\\A", ports: [9000] }
      ]
    }),
    /端口/
  );

  // ── 4. loadConfig：非法命令丢弃并给出 errors；保留合法命令 ──────────────
  const rawPath = path.join(dir, "raw.json");
  await writeFile(rawPath, JSON.stringify({
    version: 1,
    ui: { visible: true },
    commands: [
      {
        id: "ok",
        title: "OK",
        command: "echo ok",
        scope: "global",
        cwd: "",
        terminalTitle: "legacy",
        utf8CodePage: true,
        longRunning: true
      },
      { id: "bad-env", title: "Bad", command: "echo", scope: "global", cwd: "", env: { "1x": "v" } }
    ]
  }), "utf8");
  const loadedRaw = await loadConfig(rawPath);
  assert.equal(loadedRaw.exists, true);
  assert.deepEqual(loadedRaw.config.commands.map((command) => command.id), ["ok"]);
  assert.equal(loadedRaw.errors.length, 1, "加载时应报告被丢弃的命令");
  assert.equal(Object.hasOwn(loadedRaw.config.commands[0], "terminalTitle"), false);

  const corruptPath = path.join(dir, "corrupt.json");
  await writeFile(corruptPath, "{not json", "utf8");
  await assert.rejects(() => loadConfig(corruptPath), /不是合法 JSON/);

  // ── 5. createCommand：默认作用域/projectRoot/cwd/新字段 ─────────────────
  const created = createCommand(defaultConfig(), { title: "启动开发服务器", command: "pnpm dev" }, "H:\\Limob-windows");
  assert.equal(created.command.scope, "project");
  assert.equal(created.command.projectRoot, "H:\\Limob-windows");
  assert.equal(created.command.cwd, "H:\\Limob-windows");

  const created2 = createCommand(created.config, {
    command: "python app.py",
    scope: "project",
    projectRoot: "H:/proj2/",
    ports: [8123],
    readyPort: 8123,
    readyTimeoutMs: 5000,
    env: { APP_PORT: "8123" },
    dependsOn: [created.command.id]
  }, undefined);
  assert.equal(created2.command.scope, "project");
  assert.equal(created2.command.projectRoot, "H:\\proj2");
  assert.equal(created2.command.cwd, "H:\\proj2");
  assert.deepEqual(created2.command.ports, [8123]);
  assert.equal(created2.command.readyPort, 8123);
  assert.equal(created2.command.readyTimeoutMs, 5000);
  assert.deepEqual(created2.command.env, { APP_PORT: "8123" });
  assert.deepEqual(created2.command.dependsOn, [created.command.id]);

  const globalCreated = createCommand(defaultConfig(), { command: "pnpm dev", scope: "global" }, undefined);
  assert.equal(globalCreated.command.scope, "global");
  assert.equal(globalCreated.command.projectRoot, "");
  assert.equal(globalCreated.command.cwd, "");

  assert.throws(
    () => createCommand(defaultConfig(), { command: "x", scope: "project" }, undefined),
    isConfigError,
    "project 作用域没有 projectRoot/工作区时必须抛错"
  );
  assert.throws(() => createCommand(defaultConfig(), { title: "x" }, undefined), isConfigError, "create 缺 command 必须抛错");

  // ── 6. updateCommand：id 不可改、依赖校验 ──────────────────────────────
  const updated = updateCommand(created2.config, created.command.id, { title: "改名", ports: [9000], readyPort: null });
  assert.equal(updated.command.id, created.command.id);
  assert.equal(updated.command.title, "改名");
  assert.deepEqual(updated.command.ports, [9000]);
  assert.equal(updated.command.readyPort, null);

  const idIgnored = updateCommand(updated.config, created.command.id, { id: "hacked" });
  assert.equal(idIgnored.command.id, created.command.id, "id 创建后不可改");

  assert.throws(() => updateCommand(updated.config, created.command.id, { dependsOn: ["nope"] }), isConfigError);
  assert.throws(
    () => updateCommand(updated.config, created.command.id, { dependsOn: [created2.command.id] }),
    isConfigError,
    "A 依赖 B、B 依赖 A 时应检测到环"
  );

  // ── 7. deleteCommand：级联清理 dependsOn，整份配置仍合法 ────────────────
  const deleted = deleteCommand(updated.config, created.command.id);
  assert.equal(deleted.command.id, created.command.id);
  assert.equal(deleted.config.commands.some((command) => command.id === created.command.id), false);
  const survivor = deleted.config.commands.find((command) => command.id === created2.command.id);
  assert.deepEqual(survivor.dependsOn, [], "删除被依赖命令时应级联移除 dependsOn");

  // ── 8. reorderCommands / setUi / 保存读回 ──────────────────────────────
  const three = createCommand(deleted.config, { command: "echo third", scope: "global" }, undefined).config;
  const ids = three.commands.map((command) => command.id);
  const reordered = reorderCommands(three, [...ids].reverse());
  assert.deepEqual(reordered.config.commands.map((command) => command.id), [...ids].reverse());
  assert.throws(() => reorderCommands(three, ids.slice(1)), isConfigError, "缺 id 的排列非法");
  assert.throws(() => reorderCommands(three, [...ids.slice(1), ids[1]]), isConfigError, "重复 id 的排列非法");

  const hidden = setUi(three, { visible: false }).config;
  assert.equal(hidden.ui.visible, false);
  assert.throws(() => setUi(three, { visible: "yes" }), isConfigError);
  assert.throws(() => setUi(three, {}), isConfigError);

  const saved = await saveConfigFile(file, hidden);
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.version, 2);
  assert.equal(raw.ui.visible, false);
  assert.deepEqual(saved.commands.map((command) => command.id), ids);
  const reloaded = await loadConfig(file);
  assert.equal(reloaded.exists, true);
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual(reloaded.config, saved);

  // ── 9. 非法保存：整份配置非法直接抛错，不写盘 ──────────────────────────
  const validCommand = { id: "x", title: "X", command: "echo x", scope: "global", cwd: "" };
  const badConfigs = [
    { version: 2, commands: [validCommand, { ...validCommand, id: "y", env: { "bad-key": "1" } }] },
    { version: 2, commands: [validCommand, { ...validCommand, id: "y", ports: [8001], readyPort: 8002 }] },
    { version: 2, commands: [validCommand, { ...validCommand, id: "y", dependsOn: ["nope"] }] },
    {
      version: 2,
      commands: [
        { ...validCommand, id: "a", dependsOn: ["b"] },
        { ...validCommand, id: "b", dependsOn: ["a"] }
      ]
    },
    { version: 2, commands: [validCommand, { ...validCommand, id: "dupe" }, { ...validCommand, id: "dupe" }] },
    { version: 2, ui: { visible: "yes" }, commands: [validCommand] },
    { version: 2, commands: [{ ...validCommand, cwd: "relative" }] }
  ];
  for (const bad of badConfigs) {
    const target = path.join(dir, "bad-" + Math.random().toString(36).slice(2) + ".json");
    await assert.rejects(() => saveConfigFile(target, bad), ConfigError, "非法配置保存必须抛错：" + JSON.stringify(bad).slice(0, 120));
  }

  // ── 10. 路径工具与 findCommand ─────────────────────────────────────────
  assert.equal(normalizePath("H:/Proj/Sub/"), "h:\\proj\\sub");
  assert.equal(normalizePath(""), "");
  assert.equal(cleanProjectPath("H:/Proj/Sub/"), "H:\\Proj\\Sub");
  assert.equal(cleanProjectPath("H:\\"), "H:\\");
  assert.equal(cleanProjectPath("H:/"), "H:\\");
  assert.equal(cleanProjectPath(""), "");

  assert.equal(findCommand(three, ids[0]).id, ids[0]);
  assert.equal(findCommand(three, three.commands[0].title.toUpperCase()).id, ids[0]);
  assert.equal(findCommand(three, "不存在的命令"), undefined);

  console.log(JSON.stringify({
    ok: true,
    file,
    commandsSaved: saved.commands.length,
    invalidCommandCases: invalidCommands.length,
    invalidSaveCases: badConfigs.length
  }, null, 2));
} finally {
  await rm(dir, { recursive: true, force: true });
}
