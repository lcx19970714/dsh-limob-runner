# dsh-runner

[![release](https://img.shields.io/github/v/release/lcx19970714/dsh-runner)](https://github.com/lcx19970714/dsh-runner/releases)

给 **DeepSeek Harness（DSH）** 的对话输入框**正下方**加一个低调的「▶ 运行」小按钮：点击选择命令，在 **DSH 自带的右侧栏终端**里执行，输出实时滚动。命令可以在 **设置弹窗的「dsh-runner」页**里增删改查、排序、启停，并选择「全局」或「仅某个项目」显示。

> 适用于 DSH **0.2.1 线**（`0.2.1-rc.2` 实测）。插件依赖 DSH 的内部客户端服务，升级 DSH 后可能需要适配，见文末「版本风险」。

---

## 一键安装

### 方式 A：DSH 界面（推荐）

1. 侧栏 **插件** → **添加插件**（Add plugin）
2. 选择 **Install a third-party plugin**
3. 粘贴：

   ```
   github:lcx19970714/dsh-runner
   ```

4. 安装后，进入任意会话，输入框卡片正下方出现「▶ 运行」。

### 方式 B：命令行（桌面版需先完全退出 DSH）

```powershell
dsh plugin --profile desktop add github:lcx19970714/dsh-runner
```

其它 profile 把 `desktop` 换成对应名字。

### 方式 C：本地开发

```powershell
git clone https://github.com/lcx19970714/dsh-runner
dsh plugin --profile desktop add file:<仓库绝对路径>
```

---

## 按钮在哪 / 长什么样

- 位置：对话输入框卡片**正下方**（DSH 的 `conversation.composer.dock` 槽位，和输入框下方的状态胶囊同一行）；
- 样式：按钮只有「▶」图标 + 「运行」两个字，**无外边框、无胶囊底色**（默认透明，悬停才显示淡背景），不占额外高度、不遮挡对话和输入框；
- 点击：向上展开**项目级命令**菜单（按当前项目过滤、显示运行中绿点、关闭本会话终端、管理命令、更新状态与 GitHub 入口）；
- 全局命令不再放在这个按钮里，而是放在左侧导航新增的 **「运行」** 页（见下）；
- 有新版本时按钮上会有一个小橙点；
- 运行结果（启动中/运行中/失败）以小字显示在按钮右侧，6 秒后自动消失。

不再有浮动按钮、拖动和位置记忆——按你的要求改成了「简单一点，放在输入框下面」。

---

## 配置页面在哪？

DSH 左下角 **设置**（Settings）弹窗 → 左侧导航新增一页 **「dsh-runner」**。
（技术实现：注册到 DSH 设置页的 `settings.section` 槽位，每个条目就是一页，不需要改 DSH 源码。）

也可以从「运行」菜单的 **「管理命令…」** 直接打开同一套配置（弹窗形式）。

配置页能做：

| 操作 | 说明 |
|---|---|
| 新增命令 | 名称、工作目录、命令（PowerShell 固定文本）、终端标题（可选） |
| 编辑 / 删除 | 点击命令行即可编辑；删除前需二次确认 |
| 排序 | 行内上移 / 下移，决定菜单里的顺序 |
| 启用 / 停用 | 停用的命令不在菜单里出现，但保留配置 |
| 作用域 | **全局**：所有项目都显示；**指定项目**：从下拉列表选择 DSH 工作区（或自定义路径） |
| 中文命令 | 勾选「先执行 chcp 65001」避免 Windows PowerShell 5.1 中文乱码（输入含中文时自动勾选） |
| 运行按钮 | 显示 / 隐藏输入框下方的按钮 |
| 备份 | 导出配置 JSON、导入配置 JSON、恢复内置的 4 条命令 |

界面是紧凑的列表 + 内联表单，不再是多张留白很大的卡片：顶部是命令统计和「运行按钮」开关，列表中一行一条命令，编辑时在列表上方展开表单。

### 全局命令：左侧导航「运行」页

- 左侧导航（插件/自动化任务下面）新增 **「运行」** 入口，点开是全局命令页；
- 全局命令由 Host 侧独立进程执行，**不绑定会话**；
- 每个项目/会话的右侧栏会打开一个「跟随日志」的原生终端，切换项目后会自动补开，所以切来切去都能看到同一份全局输出；
- 该终端是**只读日志**（`Get-Content -Wait`），真正的进程在 Host；需要输入交互的命令请用项目级命令的终端；
- 左侧「运行」页可以运行、停止、打开日志，并显示进程状态。

### 全局 vs 项目作用域

- **全局**：在左侧「运行」页显示，任何项目都能启动；输入框下方按钮不再展示全局命令。
- **指定项目**：只有当前会话所属的**工作区路径**等于所选项目，或位于它下面（子目录）时，命令才出现在输入框下方的「运行」菜单里，并使用 DSH 原生交互终端。
- 项目直接从下拉列表选择（来自 DSH 侧栏已经添加的工作区，例如 `Limob-windows · H:\Limob-windows`），不需要手输路径；如果项目尚未注册到 DSH，可选「自定义路径…」手动填写。

---

## 让 AI 直接帮你加启动命令（0.6.0+）

装好后，AI 侧多了一个工具 **`dsh_runner_config`**。在任何项目的会话里直接说：

- 「给当前项目加一个启动命令：`pnpm dev`，名字叫启动开发服务器」
- 「给这个项目加一个 `cargo check` 命令」
- 「把启动开发服务器改成 `pnpm dev:web`」
- 「删除启动开发服务器」
- 「加一个全局命令：打开记事本」  
  （也可以说「给所有项目加一个全局启动命令：`pnpm dev`」）

AI 调用工具时的默认行为：

- 作用域 = **当前项目**（project），项目路径 = 当前会话的工作区，不需要你手写 `H:\...`；
- 工作目录 = 项目路径（除非显式指定 `cwd`）；
- 命令里含中文时自动勾选 chcp 65001；
- 只有你明确说「全局」时才会创建全局命令；全局命令会自动出现在左侧导航「运行」页。
- 全局命令没有显式 `cwd` 时，运行时会使用当前项目路径。

保存后**不需要重启 DSH**：左侧导航「运行」页每 2.5 秒同步一次配置，AI 创建的全局命令会自动出现；输入框下方的「运行」菜单和设置页也会在打开时同步。设置页底部也有「同步宿主」按钮可手动刷新。

配置由 Host 统一保存到：

```
C:\Users\main\.dsh\dsh-runner\commands.json
```

（可用环境变量 `DSH_RUNNER_CONFIG` 指向别的路径；AI 也可以用普通文件工具直接读写这个 JSON。）
如果没有 Host（例如离线/旧版），浏览器会自动退回 localStorage。

> 工具只负责**保存配置**，不会直接执行命令；真正运行仍需你在菜单里点一下，避免 AI 直接跑危险命令。

---

默认自带 4 条 **全局** 命令：

| 名称 | 工作目录 | 命令 |
|---|---|---|
| 开发调试 | `H:\Limob-windows` | `pnpm 客户端-调试` |
| Rust 检查（cargo check） | `H:\Limob-windows\src-tauri` | `cargo check` |
| 快速构建（tauri build --debug） | `H:\Limob-windows` | `pnpm exec tauri build --debug --no-bundle` |
| 正式构建（pnpm 构建桌面端） | `H:\Limob-windows` | `pnpm 构建桌面端` |

旧版升级上来的用户会自动得到这份默认配置；之前的终端复用记录（`dsh.limob-runner.v1`）继续兼容。旧配置里的 `ui.floating` 字段会被自动忽略。

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
- 想重跑「shell 还在、但上一条命令已结束」的命令：先点「关闭本会话的运行终端」，再点命令。

「关闭本会话的运行终端」会关闭当前会话里由「运行」打开的终端（等价于逐个点终端页签的 ×），**正在运行的命令会一并结束**；菜单里会显示可关闭的终端数量，没有终端时该菜单项是禁用状态。

---

## 更新提示

插件内建 GitHub Releases 检查（10 分钟缓存，打开菜单时可点小圆点手动检查）：

- 菜单底部只有一个小圆点 + 版本号（不单独占一个菜单项）；有新版本时圆点变橙色并显示最新版本号，点击打开 GitHub Release；
- 菜单右下角的 **GitHub** 图标按钮可以直接打开仓库；
- 按钮本身也会在发现新版本时显示小橙点，DSH 插件页本插件详情会出现「可更新」徽标与升级说明；
- 升级方式：DSH 插件页卸载后用 `github:` 规格重装，或退出 DSH 后执行：

  ```powershell
  dsh plugin --profile desktop add github:lcx19970714/dsh-runner
  ```

- 为什么不做静默自动升级：安装要写 profile、跑 pnpm、重新组合，属于 DSH Host/插件管理器的权限；自动升级也会绕过用户确认。

维护者发版：同时改 `package.json` 与 `client.js` 的 `PLUGIN_VERSION`（`scripts/smoke.mjs` 会校验一致）→ commit → `git tag vX.Y.Z` → `git push --tags` → `gh release create vX.Y.Z --generate-notes`。仓库 `contrib/github-workflows/` 里有可选的 Actions 模板。

---

## 数据与回退

- 配置：Host 侧 `C:\Users\main\.dsh\dsh-runner\commands.json`（主数据）；浏览器 `localStorage["dsh.limob-runner.config.v1"]` 作为缓存/离线兜底
- 全局命令运行日志：`C:\Users\main\.dsh\dsh-runner\logs\<命令 id>.log`（右侧日志终端读取它）
- 终端复用记录：`localStorage["dsh.limob-runner.v1"]`
- 全局日志终端映射：`localStorage["dsh.runner.globalTabs.v1"]`
- 更新缓存：`localStorage["dsh.limob-runner.update.v1"]`

以上都是本机本地数据，删掉只会丢失自定义命令/按钮开关，不会影响 DSH 其它功能。卸载插件后如需彻底清理，删除 `commands.json` 和这三个 localStorage 键即可。

---

## 实现与版本风险

- 客户端插件与 DSH 内置 UI 插件在同一个 Cordis 根 Context 中运行，可访问 `remote.terminal`、`webTerminals`、`sidebarRight` 等客户端服务。
- 运行按钮：`conversation.composer.dock`（输入框卡片下方的环境条目槽位）。
- 左侧运行入口：`sidebar.panellist`（导航图标）+ `main`（全局命令页）。
- 全局进程：Host 侧 `host-runner.js`（child_process），浏览器通过 `global/start|stop|status` RPC 控制。
- 配置页：`settings.section`（设置弹窗的页面列表，每个条目一页）。
- 更新提示：`plugins.detail.badge` / `plugins.detail.section`（插件页详情扩展点）。
- 终端：`remote.terminal.create/list/attach/rename/close` + `sidebarRight.openTab("terminal",{params:{terminalId}})`。
- 这些是 DSH 内部接口（非官方承诺稳定的插件 API）。所有调用都有能力检测与 try/catch，失败只影响对应提示，不影响聊天；DSH 升级后如功能异常，按上表对照新版本 `app.asar` 中的包修正。

## 开发与测试

```powershell
node --check index.js
node --check client.js
node --check host-config.js
node --check host-runner.js
node scripts/host-smoke.mjs
node scripts/runner-smoke.mjs
node scripts/smoke.mjs
```

`scripts/smoke.mjs` 在 Node 里用假的 `window.__ModuleLoader__` / react / ctx 执行 `client.js`，并测试：7 个 slot 注册、配置默认值与作用域匹配、GitHub 更新检查（mock fetch/localStorage）、最小 props 下的组件首次渲染。
`scripts/host-smoke.mjs` 用临时目录测试 Host 侧 `commands.json` 的读写和 AI Tool 的 create/update/delete 核心逻辑。
`scripts/runner-smoke.mjs` 验证 Host 全局运行器能启动短命令、写入日志并停止长命令。

## License

[MIT](LICENSE)
