// dsh-runner 的离线冒烟测试（CI 与本地都用它）。
//
// 覆盖：
// 1. 用假的 window.__ModuleLoader__ / react / ctx 执行 client.js，确认插件能注册 4 个 slot；
// 2. client.js 的 PLUGIN_VERSION 与 package.json version 一致；
// 3. 版本比较与 GitHub 更新检查（mock fetch/localStorage）；
// 4. 配置模型：默认 4 条命令、命令校验、全局/项目作用域匹配、可见命令过滤；
// 5. 浮动按钮 / 设置页组件能在最小 props 下完成首次渲染。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "client.js"), "utf8");

// ---- 1. 假 window.__ModuleLoader__ ----
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value;
    }
  }
};
new Function("window", source)(globalThis.window);
assert.equal(registration.id, "dsh-runner", "client.js 的模块 id 必须等于包名");

// ---- 2. 假 react ----
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect() {},
  memo(fn) {
    return fn;
  }
};
const moduleExports = registration.factory((name) => {
  if (name === "react") return reactStub;
  throw new Error("client.js 出现了未预期的 require: " + name);
});
assert.equal(moduleExports.name, "dsh-runner");
assert.deepEqual(moduleExports.inject, ["slots", "connection"]);

const internals = moduleExports.__limob;
assert.notEqual(internals, undefined, "client.js 必须导出 __limob 测试入口");

// ---- 3. 版本一致性 ----
assert.equal(internals.pluginVersion, manifest.version, "PLUGIN_VERSION 必须与 package.json version 一致");
assert.equal(internals.installSpec, "github:" + internals.repoSlug);

// ---- 4. semver ----
const compareCases = [
  ["0.3.0", "0.2.9", 1],
  ["v0.3.0", "0.3.0", 0],
  ["0.3.0-beta.1", "0.3.0", -1],
  ["0.3.0", "0.3.0-beta.1", 1],
  ["1.10.0", "1.9.9", 1],
  ["0.3.0-rc.1", "0.3.0-rc.2", -1]
];
for (const [left, right, expected] of compareCases) {
  assert.equal(internals.compareVersions(left, right), expected, `compareVersions(${left}, ${right})`);
}
assert.deepEqual(internals.parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
assert.equal(internals.parseVersion("not-a-version"), null);

// ---- 5. 假 localStorage / fetch ----
function createStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    }
  };
}
globalThis.localStorage = createStorage();
const realFetch = globalThis.fetch;
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}
async function withFetch(impl, run) {
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 5.1 有更新的 release
globalThis.localStorage.clear();
await withFetch(async () => jsonResponse({ tag_name: "v9.9.9", html_url: "https://example.test/release" }), async () => {
  const result = await internals.checkForUpdate(true);
  assert.equal(result.phase, "ready");
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, "9.9.9");
});

// 5.2 同版本无更新
globalThis.localStorage.clear();
await withFetch(async () => jsonResponse({ tag_name: "v0.3.0", html_url: "https://example.test/release" }), async () => {
  const result = await internals.checkForUpdate(true);
  assert.equal(result.available, false);
});

// 5.3 无 release 回退 package.json
globalThis.localStorage.clear();
let step = 0;
await withFetch(async () => {
  step += 1;
  if (step === 1) return jsonResponse({}, 404);
  return jsonResponse({ version: "9.9.9" });
}, async () => {
  const result = await internals.checkForUpdate(true);
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, "9.9.9");
});

// 5.4 断网兜底
globalThis.localStorage.clear();
await withFetch(async () => {
  throw new Error("offline");
}, async () => {
  const result = await internals.checkForUpdate(true);
  assert.equal(result.phase, "error");
  assert.equal(result.available, false);
});

// ---- 6. 配置模型 ----
const defaults = internals.config.defaults();
assert.equal(defaults.commands.length, 4, "默认应有 4 条内置命令");
assert.ok(defaults.commands.every((command) => command.scope === "global"), "内置命令默认全局");
assert.equal(internals.config.normalizePath("H:\\Limob-windows\\"), "h:\\limob-windows");

// 全局命令：任何会话都可见
const globalVisible = internals.config.visibleCommands(defaults, "H:\\Other", true);
assert.equal(globalVisible.length, 4);

// 项目命令：只有匹配项目（含子目录）才可见
const projectCommand = internals.config.normalizeCommand({
  id: "p1",
  title: "项目命令",
  cwd: "H:\\Limob-windows",
  command: "echo hi",
  scope: "project",
  projectRoot: "H:\\Limob-windows"
});
assert.notEqual(projectCommand, null);
assert.equal(internals.config.commandMatchesProject(projectCommand, "H:\\Limob-windows"), true);
assert.equal(internals.config.commandMatchesProject(projectCommand, "h:/limob-windows/src-tauri"), true);
assert.equal(internals.config.commandMatchesProject(projectCommand, "H:\\Other"), false);
const withProject = internals.config.normalize({
  commands: defaults.commands.concat([projectCommand]),
  ui: { floating: { x: 10, y: 20 }, visible: true }
});
assert.equal(withProject.ui.floating, undefined, "旧配置里的 ui.floating 应被忽略");
assert.equal(internals.config.visibleCommands(withProject, "H:\\Other", true).length, 4);
assert.equal(internals.config.visibleCommands(withProject, "H:\\Limob-windows", true).length, 5);
assert.equal(internals.config.visibleCommands(withProject, "H:\\Limob-windows", false).length, 4);

// 非法命令被丢弃
assert.equal(internals.config.normalizeCommand({ title: "", command: "x" }), null);
assert.equal(internals.config.normalizeCommand({ title: "t", command: "x", scope: "project" }), null);

// 配置非法/缺失时回到默认
assert.equal(internals.config.normalize(null).commands.length, 4);
assert.equal(internals.config.normalize({ commands: "bad" }).commands.length, 0);

// 归一化规则必须与 Host 端保持一致（否则每次同步都会互相改写）：
// 项目命令 cwd 默认 projectRoot、projectRoot 去尾斜杠、非 ASCII 自动 chcp、
// 全局命令不保留 projectRoot。
const normalizedProject = internals.config.normalizeCommand({
  id: "p2",
  title: "项目",
  command: "pnpm 开发",
  scope: "project",
  projectRoot: "H:\\Limob-windows\\"
});
assert.equal(normalizedProject.projectRoot, "H:\\Limob-windows");
assert.equal(normalizedProject.cwd, "H:\\Limob-windows");
assert.equal(normalizedProject.utf8CodePage, true);
const normalizedGlobal = internals.config.normalizeCommand({
  id: "g2",
  title: "全局",
  command: "echo hi",
  scope: "global",
  projectRoot: "H:\\Limob-windows"
});
assert.equal(normalizedGlobal.projectRoot, "");
assert.equal(normalizedGlobal.cwd, "");
// 终端 id 里的项目短 hash：路径写法不同必须得到同一个 id，不同项目不能碰撞。
assert.equal(internals.config.projectIdOf("H:\\Limob-windows\\"), internals.config.projectIdOf("h:/limob-windows"));
assert.notEqual(internals.config.projectIdOf("H:\\Limob-windows"), internals.config.projectIdOf("H:\\Other"));

// ---- 7. apply 注册 ----
const registered = [];
const ctx = {
  slots: {
    inject(key, callback) {
      const dispose = callback();
      assert.equal(typeof dispose, "function", "slots.inject 回调必须返回 disposer");
      return dispose;
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    }
  },
  get() {
    return undefined;
  },
  logger: { error() {} }
};
moduleExports.apply(ctx);
assert.deepEqual(
  registered.map((entry) => entry.options.name).sort(),
  ["conversation.composer.dock", "plugins.detail.badge", "plugins.detail.section", "settings.section", "shell.overlay"].sort(),
  "应注册输入框按钮、设置页、插件页更新提示、项目终端补开器"
);
assert.equal(registered.find((entry) => entry.options.name === "settings.section").options.label, "dsh-runner");

// ---- 8. 首次渲染（最小 props） ----
const runButton = registered.find((entry) => entry.options.name === "conversation.composer.dock").component;
const runTree = runButton({ sessionId: "session-test" });
assert.equal(runTree.props.className, "dshLimobRunDock", "输入框下方按钮根节点应渲染");

const settings = registered.find((entry) => entry.options.name === "settings.section").component;
const settingsTree = settings({});
assert.equal(settingsTree.props.className, "dshLimobCfgPage", "设置页根节点应渲染");

const badge = registered.find((entry) => entry.options.name === "plugins.detail.badge").component;
const section = registered.find((entry) => entry.options.name === "plugins.detail.section").component;
assert.equal(badge({ subject: { kind: "bundle", pkg: { name: "other" } } }), null);
assert.equal(section({ subject: { kind: "bundle", pkg: { name: "other" } } }), null);

console.log(JSON.stringify({
  ok: true,
  name: manifest.name,
  version: manifest.version,
  slots: registered.map((entry) => entry.options.name),
  config: "passed",
  updateLogic: "passed"
}, null, 2));
