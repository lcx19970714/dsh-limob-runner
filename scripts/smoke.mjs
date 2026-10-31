// dsh-runner 0.12.0 的离线冒烟测试（CI 与本地都用它）。
//
// 覆盖（SPEC 第 5 节 smoke 要求）：
// 1. 用假的 window.__ModuleLoader__ / react / localStorage 执行 client.js，确认模块 id 与注入；
// 2. client.js 的 PLUGIN_VERSION 与 package.json version 一致（0.12.0）；
// 3. slot 注册集合恰为 6 个：conversation.composer.dock / main / sidebar.panellist /
//    settings.section / plugins.detail.badge / plugins.detail.section；
// 4. __test 纯函数断言：stripAnsi / formatUptime / formatBytes / commandMatchesProject /
//    visibleCommandsForProject / runnerStatusText；
// 5. 用最小 props 渲染 RunnerPage（无会话 → 提示）、composer 按钮、settings 页、导航图标，
//    不报错且关键 data-* 属性存在。
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
assert.ok(registration !== null, "client.js 必须通过 window.__ModuleLoader__.load 注册");
assert.equal(registration.id, "dsh-runner", "client.js 的模块 id 必须等于包名");

// ---- 2. 假 react（只实现 client.js 用到的 hook；不提供 useSyncExternalStore，走 fallback shim）----
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children };
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

const __test = moduleExports.__test;
assert.notEqual(__test, undefined, "client.js 必须导出 __test 纯函数入口");
assert.deepEqual(
  Object.keys(__test).sort(),
  ["commandMatchesProject", "formatBytes", "formatUptime", "runnerStatusText", "stripAnsi", "visibleCommandsForProject"],
  "__test 只应包含契约要求的 6 个纯函数"
);

// ---- 3. 版本一致性（source 里的 PLUGIN_VERSION 必须与 package.json 一致）----
const versionMatch = /var PLUGIN_VERSION = "([^"]+)";/.exec(source);
assert.ok(versionMatch !== null, "client.js 必须有 PLUGIN_VERSION 常量");
assert.equal(versionMatch[1], manifest.version, "PLUGIN_VERSION 必须与 package.json version 一致");
assert.equal(manifest.version, "0.12.0", "目标版本是 0.12.0");

// ---- 4. 纯函数断言 ----
assert.equal(__test.stripAnsi("\u001b[31mred\u001b[0m"), "red");
assert.equal(__test.stripAnsi("\u001b]0;title\u0007hi"), "hi");
assert.equal(__test.stripAnsi(undefined), "");
assert.equal(__test.stripAnsi("plain"), "plain");

assert.equal(__test.formatUptime(0), "0s");
assert.equal(__test.formatUptime(59_000), "59s");
assert.equal(__test.formatUptime(65_000), "1m 05s");
assert.equal(__test.formatUptime(3_725_000), "1h 02m");
assert.equal(__test.formatUptime(-1), "—");

assert.equal(__test.formatBytes(0), "0 B");
assert.equal(__test.formatBytes(512), "512 B");
assert.equal(__test.formatBytes(65536), "64.0 KB");
assert.equal(__test.formatBytes(1024 * 1024), "1.0 MB");

const projectCommand = {
  id: "p1",
  title: "项目命令",
  command: "echo hi",
  scope: "project",
  projectRoot: "H:\\Limob-windows"
};
assert.equal(__test.commandMatchesProject(projectCommand, "H:\\Limob-windows"), true);
assert.equal(__test.commandMatchesProject(projectCommand, "h:/limob-windows/src-tauri"), true);
assert.equal(__test.commandMatchesProject(projectCommand, "H:\\Other"), false);
assert.equal(__test.commandMatchesProject(projectCommand, undefined), false);
assert.equal(__test.commandMatchesProject({ scope: "global" }, "H:\\Limob-windows"), false);

const configFixture = {
  version: 2,
  ui: { visible: true },
  commands: [
    { id: "g1", title: "全局命令", command: "echo g", scope: "global", projectRoot: "", enabled: true },
    projectCommand,
    { id: "p2", title: "别的项目", command: "echo p2", scope: "project", projectRoot: "H:\\Other", enabled: true }
  ]
};
assert.deepEqual(
  __test.visibleCommandsForProject(configFixture, "H:\\Limob-windows").map((command) => command.id),
  ["g1", "p1"]
);
assert.deepEqual(
  __test.visibleCommandsForProject(configFixture, "H:\\Limob-windows\\sub").map((command) => command.id),
  ["g1", "p1"]
);
assert.deepEqual(
  __test.visibleCommandsForProject(configFixture, undefined).map((command) => command.id),
  ["g1"]
);
assert.deepEqual(__test.visibleCommandsForProject(null, "H:\\Limob-windows"), []);

assert.equal(__test.runnerStatusText("starting"), "启动中");
assert.equal(__test.runnerStatusText("running"), "运行中");
assert.equal(__test.runnerStatusText("stopping"), "停止中");
assert.equal(__test.runnerStatusText("stopped"), "已停止");
assert.equal(__test.runnerStatusText("exited"), "已退出");
assert.equal(__test.runnerStatusText("failed"), "启动失败");
assert.equal(__test.runnerStatusText("idle"), "未运行");

// ---- 5. apply 注册（slot 集合必须与契约一致）----
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
  [
    "conversation.composer.dock",
    "main",
    "plugins.detail.badge",
    "plugins.detail.section",
    "settings.section",
    "sidebar.panellist"
  ],
  "slot 注册集合必须与 SPEC 完全一致"
);

const bySlot = (slotName) => registered.find((entry) => entry.options.name === slotName);
const sidebar = bySlot("sidebar.panellist");
assert.equal(sidebar.options.id, "dsh-runner");
assert.equal(sidebar.options.order, 20);
assert.equal(sidebar.options.label, "运行");
const mainEntry = bySlot("main");
assert.equal(mainEntry.options.key, "dsh-runner");
assert.equal(bySlot("settings.section").options.label, "dsh-runner");

// ---- 6. 最小 props 渲染 ----
function collect(tree, predicate, found = []) {
  if (tree === null || tree === undefined) return found;
  if (Array.isArray(tree)) {
    for (const item of tree) collect(item, predicate, found);
    return found;
  }
  if (typeof tree !== "object") {
    if (predicate(tree)) found.push(tree);
    return found;
  }
  if (tree.props !== undefined && tree.props !== null && predicate(tree)) found.push(tree);
  for (const child of tree.children || []) collect(child, predicate, found);
  return found;
}

function textOf(tree) {
  if (tree === null || tree === undefined) return "";
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  if (tree.children !== undefined) return (tree.children || []).map(textOf).join("");
  return "";
}

// 6.1 左侧导航图标：播放三角，props.size 生效
const iconTree = sidebar.component({ size: 20 });
assert.equal(iconTree.type, "svg");
assert.equal(iconTree.props.width, 20);
assert.equal(iconTree.props.height, 20);
assert.equal(sidebar.component({}).props.width, 16, "默认图标尺寸 16");

// 6.2 RunnerPage：无会话 → 提示"请先进入一个项目会话"
const page = mainEntry.component({});
assert.equal(page.props["data-dsh-runner-page"], "1", "RunnerPage 根节点必须有 data-dsh-runner-page");
assert.ok(textOf(page).includes("请先进入一个项目会话"), "无项目时应提示先进入项目会话");

// 6.3 composer 按钮：紧凑「▶ 运行」
const composer = bySlot("conversation.composer.dock").component;
const dockTree = composer({ sessionId: "session-test" });
assert.equal(dockTree.props.className, "dshLimobRunDock");
assert.ok(textOf(dockTree).includes("运行"), "输入框下方按钮应显示「运行」");

// 6.4 设置页：命令编辑器容器渲染
const settingsTree = bySlot("settings.section").component({});
assert.equal(settingsTree.props.className, "dshLimobCfgPage");

// 6.5 插件详情页只在 subject 是自己时才显示
const badge = bySlot("plugins.detail.badge").component;
const section = bySlot("plugins.detail.section").component;
assert.equal(badge({ subject: { kind: "bundle", pkg: { name: "other" } } }), null);
assert.equal(section({ subject: { kind: "bundle", pkg: { name: "other" } } }), null);

console.log(JSON.stringify({
  ok: true,
  name: manifest.name,
  version: manifest.version,
  slots: registered.map((entry) => entry.options.name),
  pureFunctions: Object.keys(__test).sort(),
  render: "passed"
}, null, 2));
