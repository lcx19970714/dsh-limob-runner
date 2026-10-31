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
- 点击：向上展开命令菜单（按当前项目过滤、显示运行中绿点、停止本项目进程、管理命令、更新状态与 GitHub 入口）；
- 命令由 **Host 按项目路径** 启动，与会话无关；右侧栏的日志终端是**按需打开**的只读视图，
  切会话不会自动弹出/移动终端，也不会抢走你正在看的页签；
- 右侧终端是只读日志（`Get-Content -Wait`），不是交互式 shell；
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

### 全局 vs 项目作用域

- **全局**：任何项目/会话都能看到并运行这条命令，出现在输入框下方的「运行」菜单里。
- **指定项目**：只有当前会话所属的**工作区路径**等于所选项目，或位于它下面（子目录）时，命令才出现在「运行」菜单里。
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
- 只有你明确说「全局」时才会创建全局命令；全局命令会出现在输入框下方的「运行」菜单里。
- 全局命令没有显式 `cwd` 时，运行时会使用当前项目路径。

保存后**不需要重启 DSH**：打开输入框下方的「运行」菜单，或进入设置页「dsh-runner」，插件会自动从 Host 同步；设置页底部也有「同步宿主」按钮可手动刷新。

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

## 运行与终端（项目级）

点击命令后：

1. **Host 按「项目路径 + 命令」启动独立进程**，不绑定会话；
2. 进程优先用 `pwsh`（退回 Windows PowerShell），把 `%USERPROFILE%\.cargo\bin` 拼到 PATH 最前；
3. 输出**直接写入** `C:\Users\main\.dsh\dsh-runner\logs\<项目hash>\<命令id>.log`（子进程继承文件句柄，Host 不中转）；
4. 当前会话右侧栏打开一个原生终端，执行 `Get-Content -Wait` 跟随该日志；
5. 运行时状态由 Host 维护：进程状态、日志路径、pid、启动时间写入 `runner-state.json`。

切换会话时：

- 进程和日志**不受影响**（它们属于项目，不属于会话）；
- 右侧终端是**会话级视图**，切会话时只做两件事：清理本会话里已失效的 tail，
  以及——如果右侧栏本来就展开——在后台补开运行中命令的 tail，打开后立刻还原你原来的页签，
  **不展开、不抢焦点**；
- 你手动关掉的日志终端会被记住，不会自己弹回来；再点一次运行中的命令即可重新打开。

重复点击同一命令：

- 该项目下该命令已在 Host 运行 → 复用进程并聚焦日志终端；
- 进程已退出 → 重新启动（日志追加本次运行内容）。

「停止本项目的运行进程」会结束当前项目由本插件启动的所有 Host 进程，等状态落定后关闭各会话里的日志终端；
菜单里会显示当前项目正在运行的进程数，没有时禁用。

### 生命周期（Host 重启 / 插件重载）

- 后台进程的生命周期 = Host 生命周期：**DSH 退出/重启后进程继续运行**；
  下次 Host 启动时用「pid + 命令行标记」双重校验接管它们，菜单里照常显示运行中，可以停止；
- 插件重载/升级**不会杀死**正在运行的进程，重载后自动接管；
- 校验不通过的记录（进程已退出 / pid 被系统复用）会被丢弃，**不会误杀别的进程**；
- 如果你确实想清理孤儿进程：停止按钮即可；卸载插件前建议先停止。
- 日志文件只追加不轮转，长期使用可手动删除 `~\.dsh\dsh-runner\logs` 下的旧日志。

> 该终端是**只读日志视图**，不能在终端里输入命令；真正进程在 Host。适合 `pnpm dev`、构建、`cargo check` 这类看输出的任务。

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
- 项目运行日志：`C:\Users\main\.dsh\dsh-runner\logs\<项目hash>\<命令id>.log`（右侧日志终端读取它）
- 运行状态（用于 Host 重启接管）：`C:\Users\main\.dsh\dsh-runner\runner-state.json`
- 项目日志终端映射：`localStorage["dsh.runner.projectTabs.v1"]`
- 更新缓存：`localStorage["dsh.limob-runner.update.v1"]`

以上都是本机本地数据，删掉只会丢失自定义命令/按钮开关/终端映射，不会影响 DSH 其它功能。
卸载插件后如需彻底清理：先停止运行中的命令，再删除 `commands.json`、`runner-state.json` 和上述 localStorage 键。

---

## 实现与版本风险

- 客户端插件与 DSH 内置 UI 插件在同一个 Cordis 根 Context 中运行，可访问 `remote.terminal`、`webTerminals`、`sidebarRight` 等客户端服务。
- 运行按钮：`conversation.composer.dock`（输入框卡片下方的环境条目槽位）。
- 项目进程：Host 侧 `host-runner.js`（child_process + 直接落盘日志 + state 文件 + 启动对账）；浏览器通过 `project/start|stop|stopAll|status` RPC 控制。
- 右侧日志终端：DSH 原生 terminal + `Get-Content -Wait`；`shell.overlay` 里的 `ProjectTailKeeper` 只做「清理 + 后台补开（还原用户页签）」，不抢焦点。
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

`scripts/smoke.mjs` 在 Node 里用假的 `window.__ModuleLoader__` / react / ctx 执行 `client.js`，并测试：5 个 slot 注册、配置默认值与作用域匹配、GitHub 更新检查（mock fetch/localStorage）、最小 props 下的组件首次渲染。
`scripts/host-smoke.mjs` 用临时目录测试 Host 侧 `commands.json` 的读写和 AI Tool 的 create/update/delete 核心逻辑。
`scripts/runner-smoke.mjs` 验证 Host 项目运行器：启动/写日志/按项目过滤、停止时序、路径写法归一化、Host 重启接管、缺失工作目录报错。

## License

[MIT](LICENSE)
