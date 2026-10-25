# dsh-limob-runner

[![release](https://img.shields.io/github/v/release/lcx19970714/dsh-limob-runner)](https://github.com/lcx19970714/dsh-limob-runner/releases)

给 **DeepSeek Harness（DSH）** 的 Web 界面加一个 **可拖动的「运行 Limob」浮动按钮**：点击选择命令，在 **DSH 自带的右侧栏终端**里执行，输出实时滚动；按钮位置会记住。命令可以在 **设置弹窗的「Limob 运行器」页**里增删改查、排序、启停，并选择「全局」或「仅某个项目」显示。

> 适用于 DSH **0.2.1 线**（`0.2.1-rc.2` 实测）。插件依赖 DSH 的内部客户端服务，升级 DSH 后可能需要适配，见文末「版本风险」。

---

## 一键安装

### 方式 A：DSH 界面（推荐）

1. 侧栏 **插件** → **添加插件**（Add plugin）
2. 选择 **Install a third-party plugin**
3. 粘贴：

   ```
   github:lcx19970714/dsh-limob-runner
   ```

4. 安装后浮动按钮出现在右下角（可拖动）。

### 方式 B：命令行（桌面版需先完全退出 DSH）

```powershell
dsh plugin --profile desktop add github:lcx19970714/dsh-limob-runner
```

其它 profile 把 `desktop` 换成对应名字。

### 方式 C：本地开发

```powershell
git clone https://github.com/lcx19970714/dsh-limob-runner
dsh plugin --profile desktop add file:<仓库绝对路径>
```

---

## 配置页面在哪？

DSH 左下角 **设置**（Settings）弹窗 → 左侧导航新增一页 **「Limob 运行器」**。
（技术实现：注册到 DSH 设置页的 `settings.section` 槽位，每个条目就是一页，不需要改 DSH 源码。）

也可以从浮动按钮菜单的 **「管理命令…」** 直接打开同一套配置（弹窗形式）。

配置页能做：

| 操作 | 说明 |
|---|---|
| 新增命令 | 名称、工作目录、命令（PowerShell 固定文本）、终端标题（可选） |
| 编辑 / 删除 | 删除前需二次确认 |
| 排序 | ↑ / ↓ 调整浮动菜单里的顺序 |
| 启用 / 停用 | 停用的命令不在菜单里出现，但保留配置 |
| 作用域 | **全局**：所有项目都显示；**仅项目**：只在「项目根目录」匹配的会话里显示 |
| 中文命令 | 勾选「先执行 chcp 65001」避免 Windows PowerShell 5.1 中文乱码（输入含中文时自动勾选） |
| 浮动按钮 | 显示/隐藏、重置位置 |
| 备份 | 导出配置 JSON、导入配置 JSON、恢复内置的 4 条命令 |

### 全局 vs 项目作用域

- **全局**：任何会话都能看到这条命令。
- **仅项目**：只有当前会话所属的 **工作区路径** 等于「项目根目录」，或位于它下面（子目录）时，命令才出现在浮动菜单里。
- 项目根目录就是 DSH 侧栏里那个工作区目录（例如 `H:\Limob-windows`）；配置页里的「填入当前工作区」可以一键填入。
- 不在会话里时，浮动菜单只显示提示（运行命令需要会话），全局命令也不可点。

默认自带 4 条 **全局** 命令（与旧版一致）：

| 名称 | 工作目录 | 命令 |
|---|---|---|
| 开发调试 | `H:\Limob-windows` | `pnpm 客户端-调试` |
| Rust 检查（cargo check） | `H:\Limob-windows\src-tauri` | `cargo check` |
| 快速构建（tauri build --debug） | `H:\Limob-windows` | `pnpm exec tauri build --debug --no-bundle` |
| 正式构建（pnpm 构建桌面端） | `H:\Limob-windows` | `pnpm 构建桌面端` |

旧版升级上来的用户会自动得到这份默认配置；之前「正在运行的终端」记录（`dsh.limob-runner.v1`）仍然兼容。

---

## 浮动按钮

- 默认在右下角；**按住拖动**到任意位置，松手后位置写入 `localStorage`（`dsh.limob-runner.config.v1` 的 `ui.floating`），刷新页面/重启 DSH 后保持。
- 点击（不拖动）打开命令菜单：按当前项目过滤后的命令、运行中绿点、停止终端、管理命令、检查更新。
- 位置超出视口会自动夹回可视区域；设置页可「重置按钮位置」或隐藏按钮。
- 浮动按钮在 DSH 的插件页/设置页等界面也可见；打开模态框时不会挡住弹窗（层级在模态框之下）。

---

## 运行与终端

点击命令后：

1. 通过 `remote.terminal` 在 Host 侧创建 PTY（标题默认 `Limob-<命令 id>`，可在配置里改）；
2. 优先 `pwsh`（退回 Windows PowerShell），并把 `%USERPROFILE%\.cargo\bin` 拼到 PATH 最前面；
3. 命令前可自动执行 `chcp 65001`（中文命令）；
4. 自动展开右侧栏并打开 DSH 内置 `terminal` 页签，实时显示输出。

重复点击同一命令：

- 该命令终端还在运行 → 聚焦已有页签并提示「已在运行」，不重复启动；
- 终端已退出（构建完成/失败）→ 关闭旧终端释放配额，再新建重跑；
- 想重跑「shell 还在、但上一条命令已结束」的命令：先点「停止本会话 Limob 终端」，再点命令。

「停止本会话 Limob 终端」会关闭当前会话里由本插件创建的终端（等价于点终端页签的 ×）。

---

## 更新提示

插件内建 GitHub Releases 检查（6 小时缓存，可手动「检查更新」）：

- 有新版时：浮动按钮出现小橙点、菜单顶部「发现新版本」、DSH 插件页本插件详情出现「可更新」徽标与升级说明；
- 升级方式：DSH 插件页卸载后用 `github:` 规格重装，或退出 DSH 后执行：

  ```powershell
  dsh plugin --profile desktop add github:lcx19970714/dsh-limob-runner
  ```

- 为什么不做静默自动升级：安装要写 profile、跑 pnpm、重新组合，属于 DSH Host/插件管理器的权限；自动升级也会绕过用户确认。

维护者发版：同时改 `package.json` 与 `client.js` 的 `PLUGIN_VERSION`（`scripts/smoke.mjs` 会校验一致）→ commit → `git tag vX.Y.Z` → `git push --tags` → `gh release create vX.Y.Z --generate-notes`。仓库 `contrib/github-workflows/` 里有可选的 Actions 模板（启用方式见下）。

---

## 数据与回退

- 配置：`localStorage["dsh.limob-runner.config.v1"]`（命令、浮动按钮位置、显示开关）
- 终端复用记录：`localStorage["dsh.limob-runner.v1"]`
- 更新缓存：`localStorage["dsh.limob-runner.update.v1"]`

以上都是浏览器本地数据，删掉只会丢失自定义命令/位置记录，不会影响 DSH 其它功能。卸载插件后如需彻底清理，可在 DevTools 删除这三个键。

---

## 实现与版本风险

- 客户端插件与 DSH 内置 UI 插件在同一个 Cordis 根 Context 中运行，可访问 `remote.terminal`、`webTerminals`、`sidebarRight` 等客户端服务。
- 浮动按钮：`shell.overlay`（root 作用域、frame-wide 浮动层）。
- 配置页：`settings.section`（设置弹窗的页面列表，每个条目一页）。
- 更新提示：`plugins.detail.badge` / `plugins.detail.section`（插件页详情扩展点）。
- 终端：`remote.terminal.create/list/attach/rename/close` + `sidebarRight.openTab("terminal",{params:{terminalId}})`。
- 这些是 DSH 内部接口（非官方承诺稳定的插件 API）。所有调用都有能力检测与 try/catch，失败只影响对应提示，不影响聊天；DSH 升级后如功能异常，按上表对照新版本 `app.asar` 中的包修正。

## 开发与测试

```powershell
node --check index.js
node --check client.js
node scripts/smoke.mjs
```

`scripts/smoke.mjs` 在 Node 里用假的 `window.__ModuleLoader__` / react / ctx 执行 `client.js`，并测试：4 个 slot 注册、配置默认值与作用域匹配、GitHub 更新检查（mock fetch/localStorage）、最小 props 下的组件首次渲染。

## License

[MIT](LICENSE)
