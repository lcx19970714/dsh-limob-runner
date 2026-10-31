# dsh-runner

给 **DeepSeek Harness（DSH）** 加一个**项目级「运行」面板**：在 DSH 里直接启动/停止/重启后端、前端、客户端等多个开发服务，看状态、端口和日志，不用再为了跑 dev server 开一个 VS Code。

> 目标形态是 VS Code「运行与调试」里的**任务运行器**那一半：服务启停、状态、输出、端口、依赖编排。
> 不含断点/单步调试（那需要 DAP，属于另一个量级）。

适用于 DSH **0.2.1 线**（`0.2.1-rc.2` 实测）。

---

## 安装

### 方式 A：DSH 界面（推荐）

侧栏 **插件 → 添加插件 → Install a third-party plugin**，粘贴：

```
github:lcx19970714/dsh-runner
```

装好后进入任意项目会话，左侧导航出现 **「运行」** 图标。

### 方式 B：命令行（桌面版需先完全退出 DSH）

```powershell
dsh plugin --profile desktop add github:lcx19970714/dsh-runner
```

### 方式 C：本地开发

```powershell
git clone https://github.com/lcx19970714/dsh-runner
dsh plugin --profile desktop add file:<仓库绝对路径>
```

---

## 「运行」面板能做什么

左侧导航 **运行** 打开主面板（与 VS Code 的 Run 面板对应）：

- **每个服务一行**：状态点（启动中/运行中/停止中/已停止/已退出/失败）、名称、命令、端口徽标、运行时长、退出码；
- **行内操作**：启动 / 停止 / 重启；
- **顶部操作**：启动全部（按 `dependsOn` 拓扑序）、停止全部、刷新状态、管理命令；
- **日志**：点任意命令行，下方显示该命令日志（每秒轮询，自动贴底；上滚后不强制；支持清空、复制）；
- **端口诊断**：启动前自动检查该命令声明的 `ports`；被占用时直接报 `port-conflict`，显示占用 PID/进程名/命令行。面板里对**非托管**占用提供「结束占用进程」（托管进程不允许从端口入口杀掉，避免误杀自己启动的服务）；
- **未托管进程可见**：用 DSH 终端/聊天启动的旧服务不在插件管理内，但会以「端口被占」的形式暴露出来，方便你清理。

输入框下方还保留一个紧凑的 **「▶ 运行」** 快捷菜单（只做启停重启和日志入口），完整操作都在左侧面板。

---

## 配置模型（commands.json，version 2）

Host 是唯一配置源，文件：`C:\Users\main\.dsh\dsh-runner\commands.json`

```json
{
  "version": 2,
  "ui": { "visible": true },
  "commands": [
    {
      "id": "cmd-xxxx",
      "title": "调试后端",
      "command": "python -m uvicorn main:应用 --host 127.0.0.1 --port 8001 --reload",
      "cwd": "H:\\AI达人BD系统-海外版\\后端",
      "scope": "project",
      "projectRoot": "H:\\AI达人BD系统-海外版",
      "enabled": true,
      "env": { "APP_ENV": "dev", "APP_PORT": "8001", "PYTHONUNBUFFERED": "1" },
      "ports": [8001],
      "readyPort": 8001,
      "readyTimeoutMs": 120000,
      "dependsOn": []
    },
    {
      "id": "cmd-yyyy",
      "title": "调试网页端",
      "command": "npm run dev -- --host 127.0.0.1 --port 5174",
      "cwd": "H:\\AI达人BD系统-海外版\\网页端",
      "scope": "project",
      "projectRoot": "H:\\AI达人BD系统-海外版",
      "enabled": true,
      "env": { "VITE_PROXY_TARGET": "http://127.0.0.1:8001" },
      "ports": [5174],
      "readyPort": 5174,
      "readyTimeoutMs": 60000,
      "dependsOn": ["cmd-xxxx"]
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `title` / `command` | 显示名 / 交给 PowerShell 执行的命令文本 |
| `cwd` | 绝对工作目录；空 = `projectRoot`（global 命令用运行时项目路径） |
| `scope` | `project`：只在匹配项目出现；`global`：所有项目可用 |
| `projectRoot` | project 作用域的归属项目（含子目录匹配）；global 强制为空 |
| `env` | 结构化环境变量（key 必须合法标识符，value 必须是字符串） |
| `ports` | 该命令监听的 TCP 端口，用于启动前预检和端口诊断 |
| `readyPort` | 就绪判据：该端口可连接才算启动成功；必须是 `ports` 之一；`null` 表示不等待 |
| `readyTimeoutMs` | 就绪超时（1000–1800000，默认 120000）；超时会结束进程并报 `ready-timeout` |
| `dependsOn` | 必须先运行/就绪的命令 id；启动时会自动递归启动依赖，启动全部按拓扑序 |

旧版（0.10/0.11）的 commands.json 可以直接被读取：未知字段（`terminalTitle`/`utf8CodePage`/`longRunning`）会被忽略且不回写；`env`/`ports` 等按空默认。想获得端口预检与就绪等待，补上 `ports`/`readyPort` 即可。

---

## 让 AI 帮你启动/管理服务

两个 Host 侧 Tool：

- **`dsh_runner_config`**：维护配置（list/create/update/delete/reorder），支持 `env`/`ports`/`readyPort`/`readyTimeoutMs`/`dependsOn`；默认 `projectRoot` = 当前会话所属工作区。
- **`dsh_runner_run`**：`status / start / stop / restart / startAll / stopAll / diagnose / log`，默认 `projectPath` = 当前会话所属工作区。

对 AI 说：

- 「给这个项目加一个启动后端：`python -m uvicorn main:应用 --port 8001`，端口 8001，就绪端口 8001」
- 「把网页端改成依赖后端，端口 5174」
- 「启动所有项目服务」「重启后端」「看下网页端日志」「有哪些端口被不在插件里的进程占了」

Tool 描述里明确要求：**长驻服务用 `dsh_runner_run`，不要用终端工具**（终端启动的进程没有托管状态/日志/端口诊断，关会话还可能残留）。

---

## 生命周期与数据

- 进程属于项目，与会话无关；Host 是进程状态的唯一事实来源。
- 状态机：`starting → running → stopping → stopped | exited | failed`；停止会先温和终止（`taskkill /T`），2 秒后仍活着再强杀整棵进程树。
- **DSH 重启后进程继续运行**：Host 启动时用「pid + 命令行标记」双重校验接管仍在运行的进程；校验不过就丢弃，绝不误杀。
- **插件重载/升级不会杀进程**，重载后自动接管；要清理请用面板的停止/停止全部。
- 日志由子进程直接写文件（不经过 Host 转发），Host 退出/重载不会打断日志。
- 数据位置：
  - 配置：`C:\Users\main\.dsh\dsh-runner\commands.json`
  - 运行状态（重启接管用）：`C:\Users\main\.dsh\dsh-runner\runner-state.json`
  - 日志：`C:\Users\main\.dsh\dsh-runner\logs\<项目hash>\<命令id>.log`

> 日志只追加不轮转，长期使用可手动清理 `logs` 目录；面板里的「清空日志」只清当前命令的文件。

---

## 开发与测试

```powershell
node --check index.js && node --check client.js && node --check host-config.js && node --check host-runner.js
node scripts/host-smoke.mjs    # 配置 v2：校验/CRUD/reorder/旧字段忽略/环检测
node scripts/runner-smoke.mjs  # 运行器：状态机/stop/端口冲突/diagnose/killPort/readyPort/dependsOn/env/cwd/重启接管/日志
node scripts/smoke.mjs         # Client：模块加载/版本/6 个槽位/纯函数/最小渲染
```

或 `npm run harness:check` 一次跑完。

---

## 限制与版本风险

- 仅支持 **Windows + PowerShell**（Host 用 `taskkill`、`Get-CimInstance`、`pwsh`/`powershell`）。
- 日志是**文件轮询视图**，不是交互式终端：不能输入 stdin、没有 Ctrl+C、没有 ANSI 颜色/进度条。需要交互时仍用 DSH 自带终端（但长驻服务建议用本插件托管）。
- 没有断点/变量/单步调试（DAP）；需要时请继续用 VS Code/专用调试器。
- 依赖 DSH 0.2.1 的内部客户端槽位（`sidebar.panellist`/`main`/`settings.section`）与 Host RPC/服务；升级 DSH 后可能需要适配。

## License

[MIT](LICENSE)
