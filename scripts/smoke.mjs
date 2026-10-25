// dsh-limob-runner 的离线冒烟测试（CI 与本地都用它）。
//
// 它做三件事：
// 1. 在 Node 里用假的 window.__ModuleLoader__ / react / ctx 执行 client.js，确认插件能注册；
// 2. 校验 client.js 里的 PLUGIN_VERSION 与 package.json 的 version 一致（发布流程的一部分）；
// 3. mock fetch / localStorage，测试 GitHub 更新检查（新版本、老版本、无 release、断网、缓存）。
//
// 真正的终端/UI 行为由 DSH 内的浏览器验证，这里只覆盖纯逻辑，保证每次发版前不回归。
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "client.js"), "utf8");

// ---- 1. 假 window.__ModuleLoader__ 捕获插件注册 ----
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value;
    }
  }
};
new Function("window", source)(globalThis.window);
assert.equal(registration.id, "dsh-limob-runner", "client.js 的模块 id 必须等于包名");

// ---- 2. 假 react（只用基线 require("react")）----
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props, children };
  },
  useState(initial) {
    return [initial, () => {}];
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
assert.equal(moduleExports.name, "dsh-limob-runner");
assert.deepEqual(moduleExports.inject, ["slots"]);

const internals = moduleExports.__limob;
assert.notEqual(internals, undefined, "client.js 必须导出 __limob 测试入口");

// ---- 3. 版本一致性（发版时漏改会在这里失败）----
assert.equal(
  internals.pluginVersion,
  manifest.version,
  "client.js 的 PLUGIN_VERSION 必须与 package.json 的 version 一致"
);
assert.equal(internals.installSpec, "github:" + internals.repoSlug);

// ---- 4. semver 比较 ----
const compareCases = [
  ["0.2.0", "0.1.9", 1],
  ["v0.2.0", "0.2.0", 0],
  ["0.2.0-beta.1", "0.2.0", -1],
  ["0.2.0", "0.2.0-beta.1", 1],
  ["1.10.0", "1.9.9", 1],
  ["0.2.0-rc.1", "0.2.0-rc.2", -1]
];
for (const [left, right, expected] of compareCases) {
  assert.equal(internals.compareVersions(left, right), expected, `compareVersions(${left}, ${right})`);
}
assert.deepEqual(internals.parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
assert.equal(internals.parseVersion("not-a-version"), null);

// ---- 5. 假 localStorage 与 fetch ----
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
let fetchCalls = 0;
await withFetch(async () => {
  fetchCalls += 1;
  return jsonResponse({ tag_name: "v9.9.9", html_url: "https://example.test/release" });
}, async () => {
  const result = await internals.checkForUpdate(true);
  assert.equal(result.phase, "ready");
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, "9.9.9");
});

// 5.2 缓存命中时不再请求 GitHub
const callsBeforeCacheHit = fetchCalls;
await withFetch(async () => {
  throw new Error("缓存命中时不应请求 GitHub");
}, async () => {
  const cached = await internals.checkForUpdate(false);
  assert.equal(cached.available, true);
  assert.equal(cached.latestVersion, "9.9.9");
});
assert.equal(fetchCalls, callsBeforeCacheHit, "缓存命中时不应增加请求次数");

// 5.3 同版本 release → 无更新
globalThis.localStorage.clear();
await withFetch(async () => jsonResponse({ tag_name: "v0.2.0", html_url: "https://example.test/release" }), async () => {
  const result = await internals.checkForUpdate(true);
  assert.equal(result.available, false);
});

// 5.4 仓库还没有 release → 回退读 main 的 package.json
globalThis.localStorage.clear();
let fallbackStep = 0;
await withFetch(async () => {
  fallbackStep += 1;
  if (fallbackStep === 1) return jsonResponse({}, 404);
  return jsonResponse({ version: "9.9.9" });
}, async () => {
  const result = await internals.checkForUpdate(true);
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, "9.9.9");
});

// 5.5 断网 → error 分支，不抛异常
globalThis.localStorage.clear();
await withFetch(async () => {
  throw new Error("offline");
}, async () => {
  const result = await internals.checkForUpdate(true);
  assert.equal(result.phase, "error");
  assert.equal(result.available, false);
});

// ---- 6. apply() 注册 3 个 slots ----
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
assert.equal(registered.length, 3);
assert.deepEqual(
  registered.map((entry) => entry.options.name).sort(),
  ["conversation.input.dock", "plugins.detail.badge", "plugins.detail.section"].sort()
);
assert.equal(registered.find((entry) => entry.options.name === "conversation.input.dock").options.id, "limob-runner");

// dock 组件首次渲染（hooks 用 stub）
const dock = registered.find((entry) => entry.options.name === "conversation.input.dock").component;
const tree = dock({ sessionId: "session-test", session: { id: "session-test" } });
assert.equal(tree.props.className, "dshLimob-root");

// 插件详情组件：不是本插件时返回 null
const badge = registered.find((entry) => entry.options.name === "plugins.detail.badge").component;
const section = registered.find((entry) => entry.options.name === "plugins.detail.section").component;
assert.equal(badge({ subject: { kind: "bundle", pkg: { name: "other-plugin" } } }), null);
assert.equal(section({ subject: { kind: "bundle", pkg: { name: "other-plugin" } } }), null);

console.log(JSON.stringify({
  ok: true,
  name: manifest.name,
  version: manifest.version,
  slots: registered.map((entry) => entry.options.name),
  updateLogic: "passed"
}, null, 2));
