// 客户端「项目日志终端」生命周期的离线验证。
//
// 覆盖 0.11.0 修复的核心行为：
//   1) 右侧栏收起时，切会话不创建任何终端（不制造不可见 tail）；
//   2) 右侧栏展开时后台补开：创建终端、打开页签，但立刻把焦点还原到用户原来的页签；
//   3) 已存在的 tail 复用，不重复创建；
//   4) 用户关掉 tail 后，后台对账不会自己弹回来（dismissed）；
//   5) 用户显式点运行（focus=true）时才重新创建并聚焦；
//   6) 停止/清理时关闭终端并清空注册表。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "client.js"), "utf8");

// ---- 假 DSH 客户端环境 ----
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value;
    }
  }
};
new Function("window", source)(globalThis.window);
assert.equal(registration.id, "dsh-runner");

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
const client = registration.factory((name) => {
  if (name === "react") return reactStub;
  throw new Error("client.js 出现了未预期的 require: " + name);
});
const internals = client.__limob;
assert.notEqual(internals, undefined);
assert.notEqual(internals.test, undefined);

// ---- 假 localStorage ----
const storage = new Map();
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  }
};

// ---- 假 remote.terminal ----
const terminals = new Map();
const remote = {
  async list(sessionId) {
    return { ok: true, value: [...terminals.keys()].map((id) => ({ id: id, state: "running", title: terminals.get(id).title })) };
  },
  async shells() {
    return { ok: true, value: [{ path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", name: "pwsh" }] };
  },
  async create(sessionId, request) {
    if (!terminals.has(request.id)) terminals.set(request.id, { id: request.id, title: "" });
    return { ok: true, value: { id: request.id } };
  },
  async rename(sessionId, id, title) {
    if (terminals.has(id)) terminals.get(id).title = title;
    return { ok: true, value: undefined };
  },
  attach(sessionId, id) {
    const queue = [];
    const handle = {
      send(frame) {
        if (frame.type === "write") queue.push({ type: "ack", sequence: frame.sequence });
      },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (queue.length > 0) return { done: false, value: queue.shift() };
            return { done: true };
          }
        };
      },
      dispose() {}
    };
    return handle;
  },
  async close(sessionId, id) {
    terminals.delete(id);
    return { ok: true, value: undefined };
  }
};

// ---- 假 sidebarRight ----
let expanded = false;
let activeTabId = "user-tab";
let openTabCount = 0;
let toggleCount = 0;
const focused = [];
const tabs = [];
const sidebarRight = {
  openTabs: {
    getSnapshot() {
      return tabs;
    }
  },
  isExpanded() {
    return expanded;
  },
  toggleExpanded() {
    toggleCount += 1;
    expanded = !expanded;
  },
  active() {
    return activeTabId === undefined ? undefined : { id: activeTabId };
  },
  focus(tabId) {
    focused.push(tabId);
    activeTabId = tabId;
  },
  openTab(kind, options) {
    openTabCount += 1;
    const tabId = "tab-" + String(openTabCount);
    tabs.push({ sessionId: "session-A", tabId: tabId, kind: kind, contentId: "content-" + tabId });
    activeTabId = tabId;
    expanded = true;
  },
  closeIn(sessionId, tabId) {
    const index = tabs.findIndex((tab) => tab.tabId === tabId);
    if (index >= 0) tabs.splice(index, 1);
  }
};
const webTerminals = {
  recover() {},
  views: new Map(),
  bindings: { get() { return undefined; } }
};
const ctx = {
  get(name) {
    if (name === "remote.terminal") return remote;
    if (name === "sidebarRight") return sidebarRight;
    if (name === "webTerminals") return webTerminals;
    return undefined;
  },
  logger: { error() {} }
};

const sessionId = "session-A";
const projectPath = "H:\\Proj";
const baseRunner = {
  projectPath: projectPath,
  commandId: "cmd-1",
  title: "演示命令",
  terminalTitle: "",
  logPath: "C:\\logs\\cmd-1.log",
  startedAt: 1000,
  status: "running"
};

const { ensureProjectTail, closeProjectTails, reconcileSessionTails, projectTailTitle, projectTabKey } = internals.test;

// 标题
assert.equal(projectTailTitle(baseRunner), "项目日志 · 演示命令");
assert.equal(projectTailTitle(Object.assign({}, baseRunner, { terminalTitle: "自定义" })), "自定义");
assert.match(projectTabKey(projectPath, "cmd-1"), /::cmd-1$/);

// 1) 右侧栏收起：后台对账不创建任何终端
let result = await ensureProjectTail(ctx, sessionId, baseRunner, { focus: false });
assert.equal(result.action, "collapsed");
assert.equal(terminals.size, 0);

// 2) 右侧栏展开：后台补开终端，但焦点必须还原到用户原来的页签
expanded = true;
activeTabId = "user-tab";
result = await ensureProjectTail(ctx, sessionId, baseRunner, { focus: false });
assert.equal(result.ok, true);
assert.equal(result.action, "prepared");
assert.equal(terminals.size, 1, "后台补开应创建一个 tail 终端");
assert.equal(openTabCount, 1);
assert.equal(focused[focused.length - 1], "user-tab", "后台补开必须把焦点还原到用户原来的页签");
assert.equal(expanded, true);
assert.equal(toggleCount, 0, "右侧栏已展开时不应切换展开状态");

// 3) 再次对账：复用，不重复创建
result = await ensureProjectTail(ctx, sessionId, baseRunner, { focus: false });
assert.equal(result.action, "reused");
assert.equal(terminals.size, 1);
assert.equal(openTabCount, 1);

// 4) 用户手动关闭 tail：后台对账不应把它弹回来
for (const id of [...terminals.keys()]) terminals.delete(id);
result = await ensureProjectTail(ctx, sessionId, baseRunner, { focus: false });
assert.equal(result.action, "dismissed");
assert.equal(terminals.size, 0, "用户关掉的 tail 不能被自动重开");
assert.equal(openTabCount, 1);

// 5) 用户显式点击：才重新创建并聚焦
result = await ensureProjectTail(ctx, sessionId, baseRunner, { focus: true });
assert.equal(result.action, "opened");
assert.equal(terminals.size, 1);
assert.equal(openTabCount, 2);

// 6) 命令重启（startedAt 变化）：允许自动重开
for (const id of [...terminals.keys()]) terminals.delete(id);
result = await ensureProjectTail(ctx, sessionId, Object.assign({}, baseRunner, { startedAt: 2000 }), { focus: false });
assert.equal(result.action, "prepared");
assert.equal(terminals.size, 1);

// 7) 对账：命令已停止 -> 关闭 tail 并清掉注册表
await reconcileSessionTails(ctx, sessionId, projectPath, []);
assert.equal(terminals.size, 0, "命令停止后对账应关闭 tail");
let registry = JSON.parse(globalThis.localStorage.getItem("dsh.runner.projectTabs.v1"));
assert.equal((registry.sessions[sessionId] || {})[projectTabKey(projectPath, "cmd-1")], undefined);

// 8) 停止所有：关闭终端并清空注册表
await ensureProjectTail(ctx, sessionId, Object.assign({}, baseRunner, { startedAt: 3000 }), { focus: true });
assert.equal(terminals.size, 1);
const closed = await closeProjectTails(ctx, projectPath);
assert.equal(closed, true);
assert.equal(terminals.size, 0);
registry = JSON.parse(globalThis.localStorage.getItem("dsh.runner.projectTabs.v1"));
assert.deepEqual(registry.sessions, {});

console.log(JSON.stringify({
  ok: true,
  checks: ["collapsed", "background", "reuse", "dismissed", "focus-reopen", "restart", "reconcile-stop", "stop-all"]
}, null, 2));
