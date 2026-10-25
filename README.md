# dsh-limob-runner

[![release](https://img.shields.io/github/v/release/lcx19970714/dsh-limob-runner)](https://github.com/lcx19970714/dsh-limob-runner/releases)

给 **DeepSeek Harness（DSH）** 的 Web 界面加一个「运行 Limob」按钮：点击后**不打开系统终端**，而是在 **DSH 自带的右侧栏终端**里创建 PTY 并送入固定命令，输出实时滚动；同时支持从 GitHub Releases 检查新版本并在界面里提示升级。

> 适用于 DSH **0.2.1 线**（`0.2.1-rc.2` 实测）。插件依赖 DSH 的内部客户端服务，升级 DSH 后可能需要适配，见文末「版本风险」。

---

## 一键安装

### 方式 A：DSH 界面（推荐，桌面版可用）

1. 打开 DSH 侧栏 **插件** → **添加插件**（Add plugin）；
2. 选择/进入 **Install a third-party plugin**；
3. 在包名输入框粘贴：

   ```
   github:lcx19970714/dsh-limob-runner
   ```

4. 点安装。插件安装并选中 bundle 后，HMR 会自动组合，输入框上方出现 `▶ 运行 Limob`。

### 方式 B：命令行（需要先完全退出 DSH 桌面版）

```powershell
dsh plugin --profile desktop add github:lcx19970714/dsh-limob-runner
```

> 桌面版 profile 由 Electron 应用独占管理，CLI 安装前必须**完全退出** DeepSeek Harness。
> 其它 profile（如自己起的 web profile）把 `desktop` 换成对应名字即可。

### 方式 C：本地开发（clone 后安装）

```powershell
git clone https://github.com/lcx19970714/dsh-limob-runner
dsh plugin --profile desktop add file:<仓库绝对路径>
```

---

## 更新提示与升级

插件内建了**更新检查**，读取本仓库的 GitHub Releases：

- 页面加载约 1.5 秒后检查一次，之后 **6 小时内不重复请求**（结果缓存在 `localStorage`）；
- 发现比当前版本新的 release 时：
  - dock 按钮旁出现 `可更新 vX.Y.Z` 小提示；
  - 菜单顶部出现「发现新版本 vX.Y.Z」；
  - DSH「插件」页面里本插件的详情页出现「可更新」徽标和一段 **更新说明区**（当前版本 / 最新版本 / 升级命令 / 发布页链接）；
- 菜单底部的「检查更新」可以手动立即检查（忽略缓存）；
- 网络失败只在插件详情页里显示一行提示，不影响任何终端功能。

**升级方式（二选一）：**

1. DSH 界面：**插件 → 已安装 → dsh-limob-runner → 卸载**，再用「添加插件」粘贴 `github:lcx19970714/dsh-limob-runner` 安装；
2. 命令行（退出 DSH 后）：`dsh plugin --profile desktop add github:lcx19970714/dsh-limob-runner`。

> 为什么不做「一键自动升级」：DSH 的插件安装由 Host 的插件管理器执行（要写 profile、跑 pnpm、重新组合），客户端插件没有这个权限；自动升级也会绕过用户在插件页的确认。所以这里做「检测 + 提示 + 一条升级命令」，安装动作仍交给 DSH。

**发布新版本（维护者）：**

```powershell
# 1) 同时修改 package.json 与 client.js 的 PLUGIN_VERSION（scripts/smoke.mjs 会校验两者一致）
# 2) 提交并打 tag
git add .
git commit -m "release v0.2.1"
git tag v0.2.1
git push origin main --tags

# 3) 创建 GitHub Release（更新检查读取的正是 latest release）
gh release create v0.2.1 --title "v0.2.1" --generate-notes
```

也可以启用仓库里的 `contrib/github-workflows/release.yml`（复制到 `.github/workflows/`）让打 tag 自动发 Release；这需要 token 带 `workflow` 权限（`gh auth refresh -s workflow`）。已安装的插件在下一次检查时就会提示新版本。

---

## 功能

在对话输入框上方的 `conversation.input.dock` 槽位出现 `▶ 运行 Limob` 菜单：

| 菜单项 | 工作目录 | 实际执行的命令 |
|---|---|---|
| 开发调试 | `H:\Limob-windows` | `pnpm 客户端-调试`（常驻进程） |
| Rust 检查（cargo check） | `H:\Limob-windows\src-tauri` | `cargo check` |
| 快速构建（tauri build --debug） | `H:\Limob-windows` | `pnpm exec tauri build --debug --no-bundle` |
| 正式构建（pnpm 构建桌面端） | `H:\Limob-windows` | `pnpm 构建桌面端` |
| 停止 Limob 终端 | — | 关闭本会话里由本插件创建的终端（终止进程） |
| 检查更新 | — | 读取 GitHub latest release |

点击任务后：

1. 通过 DSH 的 `remote.terminal` 在 Host 侧创建一个新终端（标题 `Limob-dev` 等）；
2. 优先选择 `pwsh`（退回 Windows PowerShell）作为 shell，并把 `%USERPROFILE%\.cargo\bin` 拼到 PATH 最前面；
3. 通过 `terminal/attach` 双向流写入命令行（命令来自 `client.js` 的 `TASKS` 常量，**不拼接用户输入**）；
4. 自动展开右侧栏并打开内置 `terminal` 页签，实时看到输出，也可以继续在终端里输入（如 Ctrl+C）。

重复点击同一任务：

- 终端**还在运行** → 聚焦已有页签并提示「已在运行」，不会重复开 dev 进程；
- 终端**已退出**（构建完成/失败）→ 关闭旧终端释放配额，再新建重跑；
- 想重跑「shell 还在、但上一条命令已结束」的任务（比如 Ctrl+C 停了 dev）：先点「停止 Limob 终端」，再点任务。

所有路径与命令都是 Windows 形式，只写死在 `client.js` 的 `TASKS` 白名单里。

---

## 使用小贴士

- **日志在哪看**：右侧栏 DSH 内置 terminal 页签，标题 `Limob-dev` / `Limob-cargo-check` / `Limob-build-debug` / `Limob-build-release`。
- **「运行中」是什么意思**：表示命令已成功写入终端、且终端进程还在。dev 是常驻进程；构建/cargo 跑完后 shell 仍会保留，所以状态仍显示「运行中」，这是正常的。
- **中文命令不乱码**：`pnpm 客户端-调试` / `pnpm 构建桌面端` 含中文。Windows PowerShell 5.1 默认按 GBK 解码交互输入，所以这两个任务会先单独写入 `chcp 65001 | Out-Null`，确认后再写真正命令。
- **停止**：菜单里的「停止 Limob 终端」等价于点终端页签的 ×，会终止本会话中由本插件创建的终端进程。
- **回退/卸载**：DSH 插件页把本插件卸载（或从 profile 的 `dependencies`、`dsh.profile.bundles` 里移除后 `pnpm install`），重启 DSH。插件只在浏览器 `localStorage` 里留两个键（`dsh.limob-runner.v1`、`dsh.limob-runner.update.v1`），删除无副作用。

---

## 它调用了什么（调研结论）

DSH 客户端插件**可以**操作自带终端。依据（DSH 安装包 `app.asar` 内的实际代码）：

| 证据 | 作用 |
|---|---|
| `@deepseek-ai/dsh-api-terminal-controller/lib/types/index.js` | Host 端 `terminalController`，注册 Remote 命名空间 `terminal`；`create` 接受调用方生成的 id（`/^[\w-]{1,128}$/`），内部通过 `ctx.subprocess.spawnTerminal()` 创建 PTY |
| 同上 `lib/types/client/index.js` | 浏览器端 `ClientTerminals extends Service`，Cordis 服务名 **`webTerminals`**，`inject = ['remote','remote.terminal','connection']` |
| `@deepseek-ai/dsh-api-gateway/lib/types/client/index.js` | 每个 Remote 命名空间挂成 Cordis 服务 `remote.<namespace>`；流方法返回可 `send()` 的 `ClientStreamHandle` |
| `@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.js` | 右侧栏内置终端页签是普通客户端插件：`inject` 含 `webTerminals/sidebarRight`，正文用导航参数里的 `terminalId` 调 `ctx.webTerminals.view(...)` |
| `@deepseek-ai/dsh-client-modules/README.md` | 安装的客户端插件由同一个浏览器模块系统/同一个 Cordis 根上下文加载，因此可以使用这些服务 |

调用链：`dock 按钮 → remote.terminal.create → terminal/attach 写入 → webTerminals.recover → sidebarRight.openTab("terminal", {params:{terminalId}})`。

**没有公开的 `createTerminal()` API**；`useTerminal(tabId, selector)` 是侧栏终端页签插槽注入给组件的 hook，不是给第三方插件调用的函数。

---

## 开发与测试

```powershell
node --check index.js
node --check client.js
node scripts/smoke.mjs
```

`scripts/smoke.mjs` 在 Node 里用假的 `window.__ModuleLoader__` / react / ctx 执行 `client.js`，并 mock `fetch`、`localStorage` 覆盖 GitHub 更新检查逻辑（新版本、老版本、无 release、断网、缓存、版本一致性）。可以在本地运行，也可以接入任意 CI。

目录：

| 文件 | 作用 |
|---|---|
| `client.js` | 浏览器半体：dock 菜单、终端创建/写入/复用/停止、更新检查、插件页更新说明 |
| `index.js` | Host 半体：故意的空插件（不注册工具/不抢服务） |
| `cordis.patch.yml` | 作为 bundle 被选中时插入 loader 行 `id: limob-runner` |
| `scripts/smoke.mjs` | 离线逻辑测试 |
| `contrib/github-workflows/` | 可选的 GitHub Actions 模板（启用方法见「发布新版本」） |

---

## 版本风险

本插件依赖 DSH **内部客户端接口**，不是官方承诺稳定的第三方插件 API：

| 依赖 | 稳定性 | 失效表现 |
|---|---|---|
| `remote.terminal` 的 `create/list/rename/close/attach` | 相对稳定（Typert Remote 生成） | 按钮仍在，点击提示「当前 DSH 没有暴露终端服务」或启动失败 |
| `webTerminals.recover` / `bindings` / `views` | 内部实现，可能改名 | 终端能创建，但可能无法自动复用/聚焦旧页签 |
| `sidebarRight.openTab("terminal", {params:{terminalId}})` | 内部实现 | 终端能创建，但右侧栏页签打不开 |
| `terminal/attach` 的写帧 `{type:"write",sequence,data}` | 协议层 | 命令写不进去，终端里没有输出 |
| `plugins.detail.badge/section` 槽位 | 插件管理页的扩展点，可能调整 | 只是更新说明区不显示，dock 功能不受影响 |

所有调用都做了能力检测与 try/catch：失败只影响对应的一个提示，不影响 DSH 正常聊天。DSH 升级后若功能异常，对照新版本 `app.asar` 里上述包修正即可。

## License

[MIT](LICENSE)
