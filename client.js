/* dsh-limob-runner —— 客户端半体（浏览器侧）
 *
 * 目标：在 DSH 对话输入框上方的 dock 槽位里加一个「运行 Limob」菜单，
 * 点击后不打开系统终端，而是使用 DSH 自带的 Web 终端：
 *   1) 通过客户端已挂载的 `remote.terminal` 命名空间在 Host 侧创建 PTY；
 *   2) 通过 `terminal/attach` 双向流把固定命令写进 shell（只写一次，来自白名单）；
 *   3) 通过右侧栏内置的 `terminal` 页签展示终端画面（实时滚动输出）；
 *   4) 再点同一任务时复用已有终端，避免重复启动 dev 进程。
 *
 * 调用链（都是同一个浏览器页面里的 Cordis 客户端服务）：
 *   remote.terminal.create/list/rename/close/attach
 *     <- @deepseek-ai/dsh-api-terminal-controller（客户端） + Host 的 terminalController
 *   webTerminals.recover / sidebarRight.openTab("terminal", { params: { terminalId } })
 *     <- @deepseek-ai/dsh-client-ui-sidebar-terminal 注册的内置终端页签
 *
 * 注意：这些是 DSH 内部的客户端服务接口（不是官方文档承诺的稳定插件 API），
 * 所有调用都做了能力检测；DSH 升级后若接口改名，按钮仍在，只会显示一条错误提示，
 * 不会影响 DSH 正常聊天。
 */
window.__ModuleLoader__.load({
  id: "dsh-limob-runner",
  factory: (require) => {
    "use strict";

    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 只用基线共享模块 react，避免额外 bundle 依赖。
    var react = require("react");
    var h = react.createElement;

    // =====================================================================
    // 一、固定任务白名单（这是唯一的“命令来源”，不接受任何用户输入拼接）
    // =====================================================================
    // 每个任务：
    //   id            稳定标识，用来复用终端 / 记录状态
    //   title         菜单里显示的中文名称
    //   terminalTitle 终端页签标题（会写进 Host 终端元数据）
    //   cwd           命令执行前先切换到的目录（Windows 绝对路径）
    //   command       固定命令，不做字符串拼装
    //   utf8CodePage  是否先 chcp 65001（命令里含中文脚本名时，保证 PowerShell 交互输入按 UTF-8 解码）
    var TASKS = [
      {
        id: "dev",
        title: "开发调试",
        terminalTitle: "Limob-dev",
        cwd: "H:\\Limob-windows",
        command: "pnpm 客户端-调试",
        utf8CodePage: true,
        longRunning: true
      },
      {
        id: "cargo-check",
        title: "Rust 检查（cargo check）",
        terminalTitle: "Limob-cargo-check",
        cwd: "H:\\Limob-windows\\src-tauri",
        command: "cargo check",
        utf8CodePage: false,
        longRunning: false
      },
      {
        id: "build-debug",
        title: "快速构建（tauri build --debug）",
        terminalTitle: "Limob-build-debug",
        cwd: "H:\\Limob-windows",
        command: "pnpm exec tauri build --debug --no-bundle",
        utf8CodePage: false,
        longRunning: false
      },
      {
        id: "build-release",
        title: "正式构建（pnpm 构建桌面端）",
        terminalTitle: "Limob-build-release",
        cwd: "H:\\Limob-windows",
        command: "pnpm 构建桌面端",
        utf8CodePage: true,
        longRunning: false
      }
    ];

    // 任务 id -> 任务定义，供状态恢复时取标题。
    var TASK_BY_ID = {};
    for (var taskIndex = 0; taskIndex < TASKS.length; taskIndex += 1) {
      TASK_BY_ID[TASKS[taskIndex].id] = TASKS[taskIndex];
    }

    // =====================================================================
    // 二、模块级运行时上下文
    // =====================================================================
    // `apply(ctx)` 时保存客户端根 Context。组件里通过它按需取服务：
    //   ctx.get("remote.terminal") / ctx.get("webTerminals") / ctx.get("sidebarRight")
    // 用 ctx.get 而不是在 exports.inject 里写死，是因为：
    //   - 只有 slots 是按钮渲染的硬依赖；终端服务缺失时按钮仍应出现并给出可读错误；
    //   - Cordis 的 ctx.get 对未注册服务返回 undefined，正好用来做能力检测。
    var runtimeCtx = null;

    // 本地持久化：记住「某个会话的某个任务上一次用的终端 id」，用于刷新页面后复用。
    var STORAGE_KEY = "dsh.limob-runner.v1";

    // ---- 版本与更新检查（GitHub Releases）----
    // 发布仓库：更新提示读取这个仓库的 latest release；安装/升级都用 pnpm 的 github: 规格。
    // 发布新版本时：把 package.json 与下面的 PLUGIN_VERSION 一起改掉，再打 tag 发 release。
    var PLUGIN_NAME = "dsh-limob-runner";
    var PLUGIN_VERSION = "0.2.0";
    var REPO_SLUG = "lcx19970714/dsh-limob-runner";
    var INSTALL_SPEC = "github:" + REPO_SLUG;
    var UPGRADE_COMMAND = "dsh plugin --profile desktop add " + INSTALL_SPEC;
    var GITHUB_REPO_PAGE = "https://github.com/" + REPO_SLUG;
    var GITHUB_RELEASES_PAGE = GITHUB_REPO_PAGE + "/releases";
    var GITHUB_API_LATEST = "https://api.github.com/repos/" + REPO_SLUG + "/releases/latest";
    var GITHUB_RAW_PACKAGE = "https://raw.githubusercontent.com/" + REPO_SLUG + "/main/package.json";
    var UPDATE_CACHE_KEY = "dsh.limob-runner.update.v1";
    var UPDATE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时内不重复请求 GitHub

    // =====================================================================
    // 三、样式（只注入一次，插件卸载时移除；不污染全局样式）
    // =====================================================================
    var STYLE_ID = "dsh-limob-runner-css";
    var CSS = [
      ".dshLimob-root{position:relative;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:2px 2px 6px;font-family:inherit;font-size:12px;line-height:18px;color:inherit}",
      ".dshLimob-trigger{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));color:inherit;font:inherit;cursor:pointer;user-select:none;white-space:nowrap}",
      ".dshLimob-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}",
      ".dshLimob-trigger[data-busy=true]{cursor:progress;opacity:.75}",
      ".dshLimob-caret{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;opacity:.65;margin-left:1px}",
      ".dshLimob-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:60;min-width:300px;max-width:min(460px,90vw);padding:6px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,#26282c);box-shadow:0 10px 28px rgba(0,0,0,.32)}",
      ".dshLimob-menuTitle{padding:5px 9px 4px;font-size:11px;opacity:.6;user-select:none}",
      ".dshLimob-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dshLimob-item:hover{background:rgba(103,158,254,.14)}",
      ".dshLimob-item:disabled{opacity:.55;cursor:default}",
      ".dshLimob-title{font-size:13px;line-height:18px}",
      ".dshLimob-cmd{font-size:11px;line-height:16px;opacity:.62;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimob-sep{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l3,rgba(128,128,128,.3))}",
      ".dshLimob-stop{color:#f87171}",
      ".dshLimob-status{display:inline-flex;align-items:center;gap:5px;min-width:0;font-size:11px;line-height:16px;opacity:.85}",
      ".dshLimob-statusText{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimob-dot{width:6px;height:6px;border-radius:50%;background:#22c55e;flex:none}",
      ".dshLimob-dot[data-phase=starting]{background:#f59e0b;animation:dshLimobPulse 1s ease-in-out infinite}",
      ".dshLimob-dot[data-phase=error]{background:#ef4444}",
      ".dshLimob-dot[data-phase=idle]{background:#94a3b8}",
      ".dshLimob-updateChip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;border:.5px solid rgba(245,158,11,.5);background:rgba(245,158,11,.12);color:#f59e0b;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}",
      ".dshLimob-updateChip:hover{background:rgba(245,158,11,.2)}",
      ".dshLimob-updateBadge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:.5px solid rgba(245,158,11,.5);background:rgba(245,158,11,.12);color:#f59e0b;font-size:11px;line-height:18px;white-space:nowrap}",
      ".dshLimob-detailSection{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));font-size:12px;line-height:18px}",
      ".dshLimob-detailTitle{font-size:13px;font-weight:600}",
      ".dshLimob-detailMuted{opacity:.65}",
      ".dshLimob-detailCode{display:block;padding:8px 10px;border-radius:7px;background:rgba(0,0,0,.22);font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;line-height:16px;word-break:break-all;user-select:text}",
      ".dshLimob-detailActions{display:flex;flex-wrap:wrap;gap:8px}",
      ".dshLimob-detailBtn{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;font-size:12px;text-decoration:none;cursor:pointer}",
      ".dshLimob-detailBtn:hover{background:rgba(103,158,254,.14)}",
      ".dshLimob-detailBtn[disabled]{opacity:.55;cursor:default}",
      "@keyframes dshLimobPulse{0%,100%{opacity:1}50%{opacity:.3}}"
    ].join("");

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // 在 factory 执行阶段注入一次样式：dsh-client-modules 会把 factory 期间新增的 <style>
    // 认领给本插件，插件卸载时统一清理。这样即使只打开「插件」页、没有渲染 dock，
    // 插件详情页里的更新说明区也有样式。
    ensureStyles();

    // =====================================================================
    // 四、通用小工具
    // =====================================================================

    /** 从 Cordis Context 安全取服务；未注册 / 已卸载时返回 undefined。 */
    function getService(ctx, name) {
      if (!ctx) return undefined;
      try {
        return ctx.get(name);
      } catch (_error) {
        return undefined;
      }
    }

    /**
     * 取终端 Remote 命名空间。
     * DSH 把它注册成 `remote.terminal`（ClientRemoteService 的命名空间服务），
     * 老一点的写法也可能只能从 `remote` 上取到 `.terminal`，两种都兼容。
     */
    function getTerminalRemote(ctx) {
      var direct = getService(ctx, "remote.terminal");
      if (direct !== undefined && direct !== null) return direct;
      var remote = getService(ctx, "remote");
      if (remote !== undefined && remote !== null) return remote.terminal;
      return undefined;
    }

    /**
     * DSH 的 Remote 调用统一返回 Result：{ ok: true, value } 或 { ok: false, error }。
     * 这里把失败分支转成异常，方便上层统一 try/catch；非 Result 的返回值原样返回。
     */
    function unwrapResult(result) {
      if (result !== null && typeof result === "object" && "ok" in result) {
        if (!result.ok) {
          throw result.error !== undefined && result.error !== null ? result.error : new Error("DSH Remote 调用失败");
        }
        return result.value;
      }
      return result;
    }

    /** 把任意异常转成可展示的中文文本。 */
    function messageOf(error) {
      if (error === undefined || error === null) return "未知错误";
      if (typeof error === "string") return error;
      if (error.message) return String(error.message);
      return String(error);
    }

    /** 给 Promise 加超时，避免某一步卡住整个按钮。 */
    function withTimeout(promise, timeoutMs, message) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          reject(new Error(message));
        }, timeoutMs);
        promise.then(
          function (value) {
            clearTimeout(timer);
            resolve(value);
          },
          function (error) {
            clearTimeout(timer);
            reject(error);
          }
        );
      });
    }

    // =====================================================================
    // 四之二、版本比较与 GitHub 更新检查
    // =====================================================================
    // 设计目标：本插件不自动安装任何东西（安装/升级都要经过 DSH 插件管理器），
    // 只在 GitHub 上有更新的 release 时给出提示和升级命令；所有网络失败都静默降级，
    // 不会影响终端功能。

    /** 解析 v1.2.3 / 1.2.3-beta.1 这类版本号；解析失败返回 null。 */
    function parseVersion(text) {
      var match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text === undefined || text === null ? "" : text).trim());
      if (match === null) return null;
      return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] === undefined ? [] : match[4].split(".")
      };
    }

    /** 按 semver 规则比较两个版本：a>b 返回 1，相等 0，a<b 返回 -1；解析失败按相等处理。 */
    function compareVersions(left, right) {
      var a = parseVersion(left);
      var b = parseVersion(right);
      if (a === null || b === null) return 0;
      var coreA = [a.major, a.minor, a.patch];
      var coreB = [b.major, b.minor, b.patch];
      for (var i = 0; i < 3; i += 1) {
        if (coreA[i] !== coreB[i]) return coreA[i] > coreB[i] ? 1 : -1;
      }
      // 带 prerelease 的版本小于同核心的正式版（1.0.0-beta < 1.0.0）。
      if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
      if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
      var length = Math.max(a.prerelease.length, b.prerelease.length);
      for (var j = 0; j < length; j += 1) {
        var partA = a.prerelease[j];
        var partB = b.prerelease[j];
        if (partA === undefined) return -1;
        if (partB === undefined) return 1;
        var numericA = /^\d+$/.test(partA);
        var numericB = /^\d+$/.test(partB);
        if (numericA && numericB) {
          if (Number(partA) !== Number(partB)) return Number(partA) > Number(partB) ? 1 : -1;
        } else if (numericA !== numericB) {
          return numericA ? -1 : 1; // 数字标识符优先级低于字母标识符
        } else if (partA !== partB) {
          return partA > partB ? 1 : -1;
        }
      }
      return 0;
    }

    function stripVersionPrefix(text) {
      return String(text === undefined || text === null ? "" : text).trim().replace(/^v/i, "");
    }

    function readUpdateCache() {
      try {
        if (typeof localStorage === "undefined") return null;
        var raw = localStorage.getItem(UPDATE_CACHE_KEY);
        if (raw === null) return null;
        var value = JSON.parse(raw);
        if (value === null || typeof value !== "object") return null;
        if (typeof value.checkedAt !== "number" || typeof value.latestVersion !== "string") return null;
        return value;
      } catch (_error) {
        return null;
      }
    }

    function writeUpdateCache(value) {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(value));
      } catch (_error) {
        /* 缓存失败不影响本次结果 */
      }
    }

    /** 查询 GitHub 最新 release（tag 即版本）；仓库还没有 release 时回退到 main 分支 package.json。 */
    async function fetchLatestVersion() {
      if (typeof fetch !== "function") throw new Error("当前环境没有 fetch，无法检查更新");
      var controller = new AbortController();
      var timer = setTimeout(function () {
        controller.abort();
      }, 8000);
      try {
        var response = await fetch(GITHUB_API_LATEST + "?t=" + Date.now(), {
          headers: { Accept: "application/vnd.github+json" },
          signal: controller.signal,
          cache: "no-store"
        });
        if (response.ok) {
          var release = await response.json();
          var tag = release.tag_name || release.name;
          if (typeof tag === "string" && parseVersion(tag) !== null) {
            return { version: stripVersionPrefix(tag), url: release.html_url || GITHUB_RELEASES_PAGE };
          }
        }
        // 404 通常表示仓库还没有任何 release；回退读 main 分支的 package.json 版本号。
        var packageResponse = await fetch(GITHUB_RAW_PACKAGE + "?t=" + Date.now(), {
          signal: controller.signal,
          cache: "no-store"
        });
        if (!packageResponse.ok) throw new Error("GitHub 返回 HTTP " + String(packageResponse.status));
        var manifest = await packageResponse.json();
        if (typeof manifest.version !== "string" || parseVersion(manifest.version) === null) {
          throw new Error("GitHub 上的 package.json 没有有效 version");
        }
        return { version: stripVersionPrefix(manifest.version), url: GITHUB_RELEASES_PAGE };
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * 检查更新（带 6 小时缓存）。
     * force=true 时忽略缓存（菜单里的「检查更新」）。
     * 失败返回 { phase:"error", message }，不抛出，避免打扰终端功能。
     */
    async function checkForUpdate(force) {
      var cached = readUpdateCache();
      var now = Date.now();
      if (!force && cached !== null && cached.installedVersion === PLUGIN_VERSION
        && cached.phase === "ready" && now - cached.checkedAt < UPDATE_TTL_MS) {
        return cached;
      }
      try {
        var latest = await fetchLatestVersion();
        var result = {
          phase: "ready",
          installedVersion: PLUGIN_VERSION,
          latestVersion: latest.version,
          available: compareVersions(latest.version, PLUGIN_VERSION) > 0,
          releaseUrl: latest.url,
          checkedAt: now
        };
        writeUpdateCache(result);
        return result;
      } catch (error) {
        return {
          phase: "error",
          installedVersion: PLUGIN_VERSION,
          available: false,
          message: messageOf(error),
          releaseUrl: GITHUB_RELEASES_PAGE,
          checkedAt: now
        };
      }
    }

    // 同一页面里多个组件（dock / 插件详情页）同时挂载时，共享同一个进行中的请求。
    var pendingUpdateCheck = null;
    function checkForUpdateShared(force) {
      if (!force && pendingUpdateCheck !== null) return pendingUpdateCheck;
      var promise = checkForUpdate(force);
      pendingUpdateCheck = promise;
      promise.then(function () {
        if (pendingUpdateCheck === promise) pendingUpdateCheck = null;
      }, function () {
        if (pendingUpdateCheck === promise) pendingUpdateCheck = null;
      });
      return promise;
    }

    /** 复制文本到剪贴板；失败返回 false。 */
    function copyTextToClipboard(text) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard !== undefined
          && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_error) {
        /* 回退到 execCommand */
      }
      try {
        if (typeof document !== "undefined") {
          var area = document.createElement("textarea");
          area.value = text;
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          var copied = document.execCommand("copy");
          area.remove();
          return copied;
        }
      } catch (_error) {
        /* 复制失败由调用方提示 */
      }
      return false;
    }

    /**
     * 打开「本插件的更新/安装说明」：
     * 优先用 DSH 插件页的 pluginNavigation.openBundle() 直接跳到本插件详情；
     * 没这个服务时退化为复制 release 地址并提示用户手动打开。
     */
    function openPluginUpdatePage(ctx, releaseUrl, notify) {
      var navigation = getService(ctx, "pluginNavigation");
      if (navigation !== undefined && navigation !== null && typeof navigation.openBundle === "function") {
        try {
          navigation.openBundle(PLUGIN_NAME);
          return true;
        } catch (_error) {
          /* 回退到复制地址 */
        }
      }
      var url = releaseUrl || GITHUB_RELEASES_PAGE;
      var copied = copyTextToClipboard(url);
      if (typeof notify === "function") {
        notify(copied ? ("更新说明地址已复制：" + url) : ("请手动打开更新说明：" + url));
      }
      return false;
    }

    // =====================================================================
    // 五、终端操作封装（全部通过 DSH 客户端服务，不碰系统终端）
    // =====================================================================

    /** 读取会话保留的 Host 终端列表（不激活 Agent）。 */
    async function listTerminals(remote, sessionId) {
      var list = unwrapResult(await remote.list(sessionId));
      return Array.isArray(list) ? list : [];
    }

    /**
     * 选一个 PowerShell 作为终端 shell。
     * 为什么必须选 PowerShell：
     *   - DSH 终端默认 shell 可能是 cmd.exe；
     *   - 我们的命令用 PowerShell 语法（$env:PATH、Set-Location），且 pnpm 脚本名含中文；
     *   - pwsh（PowerShell 7）对 UTF-8 交互输入最稳，所以优先 pwsh，其次 Windows PowerShell。
     * 找不到时返回 undefined，交给 Host 默认 shell（命令可能失败，会原样显示在终端里）。
     */
    async function pickShellPath(remote, sessionId) {
      var shells = [];
      try {
        shells = unwrapResult(await remote.shells(sessionId));
      } catch (_error) {
        return undefined;
      }
      if (!Array.isArray(shells)) return undefined;
      var pwsh = shells.find(function (shell) {
        var path = String(shell.path || "");
        var name = String(shell.name || "");
        return /pwsh(\.exe)?$/i.test(path) || /^pwsh$/i.test(name);
      });
      if (pwsh !== undefined) return pwsh.path;
      var powershell = shells.find(function (shell) {
        var path = String(shell.path || "");
        var name = String(shell.name || "");
        return /powershell(\.exe)?$/i.test(path) || /powershell/i.test(name);
      });
      if (powershell !== undefined) return powershell.path;
      return undefined;
    }

    /**
     * 组装要写进终端的 PowerShell 命令序列（每条对应一次回车）。
     *
     * 为什么可能返回两条：
     *   Windows PowerShell 5.1 在中文 Windows 上默认按 GBK 解码控制台输入，
     *   而 DSH 终端把我们的命令按 UTF-8 字节写进 PTY。如果同一条命令行里含中文
     *   （例如 `pnpm 客户端-调试`），这一行会在 chcp 生效之前就被解码，从而乱码。
     *   因此对 utf8CodePage 任务先单独发一条 `chcp 65001`，等 Host ack 后再发真正的
     *   命令；第二行被 shell 读取时，控制台输入代码页已经是 UTF-8。
     *
     * 输入：固定任务定义（cwd / command 都来自 TASKS 白名单）。
     * 输出：字符串数组，数组顺序就是写入顺序。
     */
    function buildCommandLines(task) {
      var lines = [];
      if (task.utf8CodePage) lines.push("chcp 65001 | Out-Null");
      // 按需求把 %USERPROFILE%\.cargo\bin 拼到 PATH 最前面，
      // 这样 cargo / rustc 与 pnpm 的子进程都能找到 Rust 工具链。
      var parts = [
        "$env:PATH = (Join-Path $env:USERPROFILE '.cargo\\bin') + ';' + $env:PATH",
        "Set-Location -LiteralPath '" + task.cwd + "'",
        task.command
      ];
      lines.push(parts.join("; "));
      // 说明：这里没有把任何用户输入拼进命令；cwd / command 都是源码里的常量。
      return lines;
    }

    /** 创建终端；如果该 id 在本会话里已经被关闭过，用时间戳后缀换一个新 id 重试。 */
    async function createTerminal(remote, sessionId, baseId, shellPath) {
      var request = { id: baseId, cols: 120, rows: 30 };
      if (shellPath !== undefined) request.shellPath = shellPath;
      try {
        var info = unwrapResult(await remote.create(sessionId, request));
        return { id: baseId, info: info };
      } catch (error) {
        // Host 会记住本会话内被关闭过的 terminal id（closedIds），
        // 同一个 id 再次 create 会得到 terminal/unavailable。
        var code = error && error.code;
        var text = messageOf(error);
        var retryable = code === "terminal/unavailable" || /closed|unavailable/i.test(text);
        if (!retryable) throw error;
        var freshId = baseId + "-" + Date.now().toString(36);
        var freshRequest = { id: freshId, cols: 120, rows: 30 };
        if (shellPath !== undefined) freshRequest.shellPath = shellPath;
        var freshInfo = unwrapResult(await remote.create(sessionId, freshRequest));
        return { id: freshId, info: freshInfo };
      }
    }

    /** 重命名 Host 终端（显示在页签标题上）；失败不影响主流程。 */
    async function safeRename(remote, sessionId, terminalId, title) {
      try {
        unwrapResult(await remote.rename(sessionId, terminalId, title));
      } catch (_error) {
        /* 标题只是展示信息，失败忽略 */
      }
    }

    /**
     * 通过 terminal/attach 双向流把一组命令行写进 PTY（每条后面补一个回车）。
     *
     * 为什么需要 attach：
     *   Host 的远程 API 没有直接的 terminal/write，输入只能走 attach 流的 uplink：
     *   handle.send({ type: "write", sequence, data: "命令行\r" })。
     *
     * 时序：
     *   1. 此时终端刚创建、侧栏里还没有它的 view，所以我们是唯一附件，输入权限在我们手里；
     *   2. 按顺序发送每一条写帧，并等待 Host 对应当前 sequence 的 ack（确认 shell 已收到），
     *      每条最多等 10 秒；chcp 与真正命令分两条发送时，这个顺序保证第二行被读取时
     *      控制台代码页已经切换完成；
     *   3. 立刻 dispose 这条附件。之后侧栏终端页签再 attach 时会成为输入控制者，
     *      用户可以在终端里继续输入（例如 Ctrl+C 停 dev）。
     */
    async function sendCommands(remote, sessionId, terminalId, commandLines) {
      var controller = new AbortController();
      var handle = remote.attach(sessionId, terminalId, controller.signal);
      var iterator = null;
      try {
        if (typeof handle[Symbol.asyncIterator] !== "function") {
          // 极少数实现可能不是可迭代句柄：把全部写帧发出后返回，让侧栏页签显示结果。
          for (var directIndex = 0; directIndex < commandLines.length; directIndex += 1) {
            handle.send({ type: "write", sequence: directIndex + 1, data: commandLines[directIndex] + "\r" });
          }
          return;
        }
        iterator = handle[Symbol.asyncIterator]();

        for (var index = 0; index < commandLines.length; index += 1) {
          var sequence = index + 1;
          // sequence 从 1 开始且必须连续，Host 会校验。
          handle.send({ type: "write", sequence: sequence, data: commandLines[index] + "\r" });

          var acknowledged = false;
          while (!acknowledged) {
            var next = await withTimeout(iterator.next(), 10000, "等待 DSH 终端确认输入超时（10 秒）");
            if (next.done === true) throw new Error("DSH 终端连接在确认命令前结束");
            var frame = next.value;
            if (frame !== null && typeof frame === "object" && frame.type === "ack" && frame.sequence >= sequence) {
              if (frame.refusal !== undefined) {
                throw new Error("DSH 终端拒绝输入：" + String(frame.refusal));
              }
              acknowledged = true;
            }
          }
        }
      } finally {
        // 中止并释放我们的附件：进程保留，只是不再占用输入控制。
        try {
          controller.abort();
        } catch (_error) {
          /* AbortController.abort 不会失败 */
        }
        if (handle !== null && typeof handle.dispose === "function") {
          try {
            handle.dispose();
          } catch (_error) {
            /* 已释放 */
          }
        }
        if (iterator !== null && typeof iterator.return === "function") {
          try {
            await iterator.return();
          } catch (_error) {
            /* 流已关闭 */
          }
        }
      }
    }

    /** 刷新侧栏终端模型共用的「Host 终端列表」，否则新终端不会出现在页签恢复逻辑里。 */
    async function refreshTerminalInventory(ctx, sessionId) {
      var webTerminals = getService(ctx, "webTerminals");
      if (webTerminals === undefined || webTerminals === null) return;
      if (typeof webTerminals.recover !== "function") return;
      try {
        await webTerminals.recover(sessionId, true);
      } catch (_error) {
        // 列表刷新失败时 openTab 仍可能通过首次装载拿到列表；不阻断启动。
      }
    }

    /**
     * 在侧栏已打开的 terminal 页签里找「已经绑定到这个 Host 终端 id」的那一个。
     * 依次用三种来源判断（从最准确到最兜底）：
     *   1. webTerminals.views：当前已挂载终端视图的 id（最准）；
     *   2. webTerminals.bindings：localStorage 里 contentId -> terminalId 的持久绑定（刷新后也有）；
     *   3. 页签导航参数 params.terminalId（刚 openTab 时写入的参数）。
     */
    function findTerminalTab(ctx, sessionId, terminalId) {
      var sidebarRight = getService(ctx, "sidebarRight");
      var webTerminals = getService(ctx, "webTerminals");
      if (sidebarRight === undefined || sidebarRight === null) return undefined;
      if (sidebarRight.openTabs === undefined || typeof sidebarRight.openTabs.getSnapshot !== "function") return undefined;
      var tabs = sidebarRight.openTabs.getSnapshot() || [];
      for (var i = 0; i < tabs.length; i += 1) {
        var tab = tabs[i];
        if (tab.sessionId !== sessionId || tab.kind !== "terminal") continue;

        if (webTerminals !== undefined && webTerminals !== null && webTerminals.views !== undefined) {
          var views = webTerminals.views.get(sessionId);
          var view = views !== undefined ? views.get(tab.tabId) : undefined;
          if (view !== undefined && view.id === terminalId) return tab.tabId;
        }

        if (webTerminals !== undefined && webTerminals !== null && webTerminals.bindings !== undefined
          && typeof webTerminals.bindings.get === "function") {
          try {
            if (webTerminals.bindings.get(sessionId, tab.contentId) === terminalId) return tab.tabId;
          } catch (_error) {
            /* bindings 是内部结构，读失败就换下一种方式 */
          }
        }

        try {
          if (sidebarRight.tabDomain !== undefined && typeof sidebarRight.tabDomain.occurrence === "function") {
            var occurrence = sidebarRight.tabDomain.occurrence(sessionId, { id: tab.tabId });
            var params = occurrence.navigation.getSnapshot().params;
            if (params !== undefined && params !== null && params.terminalId === terminalId) return tab.tabId;
          }
        } catch (_error) {
          /* 页签尚未完成 reconcile，跳过 */
        }
      }
      return undefined;
    }

    /**
     * 打开 / 聚焦侧栏里的内置 terminal 页签，让用户立刻看到实时输出。
     * - 已经存在同一终端的页签：聚焦它（必要时先展开右侧栏），不重复开页签；
     * - 不存在：先刷新终端列表，再 openTab("terminal", { params: { terminalId } })，
     *   内置终端组件会按 params.terminalId attach 到我们刚创建的 Host 终端，而不是新建进程。
     */
    async function openOrFocusTab(ctx, sessionId, terminalId) {
      var sidebarRight = getService(ctx, "sidebarRight");
      if (sidebarRight === undefined || sidebarRight === null) {
        throw new Error("DSH 右侧栏服务（sidebarRight）不可用，无法打开内置终端面板");
      }

      var existingTabId = findTerminalTab(ctx, sessionId, terminalId);
      if (existingTabId !== undefined) {
        try {
          if (typeof sidebarRight.isExpanded === "function" && !sidebarRight.isExpanded()
            && typeof sidebarRight.toggleExpanded === "function") {
            sidebarRight.toggleExpanded();
          }
        } catch (_error) {
          /* 展开失败也继续尝试聚焦 */
        }
        try {
          if (typeof sidebarRight.focus === "function") sidebarRight.focus(existingTabId);
        } catch (_error) {
          /* 聚焦失败不影响终端进程 */
        }
        return;
      }

      await refreshTerminalInventory(ctx, sessionId);

      if (typeof sidebarRight.openTab !== "function") {
        throw new Error("DSH 右侧栏不支持 openTab，无法打开内置终端面板");
      }
      // params 是页签导航参数：内置 terminal 类型会把它交给 webTerminals.view()，
      // view() 看到 terminalId 就恢复已有终端（createWhenMissing=false），不会额外 spawn 进程。
      sidebarRight.openTab("terminal", { params: { terminalId: terminalId } });
    }

    /** 关闭一个 Host 终端：优先走侧栏内置的关闭流程（会终止进程并移除页签）。 */
    async function closeTerminal(ctx, sessionId, terminalId) {
      var sidebarRight = getService(ctx, "sidebarRight");
      var tabId = findTerminalTab(ctx, sessionId, terminalId);
      if (tabId !== undefined && sidebarRight !== undefined && sidebarRight !== null
        && typeof sidebarRight.closeIn === "function") {
        try {
          sidebarRight.closeIn(sessionId, tabId);
          return;
        } catch (_error) {
          /* 找不到已收编的布局时退回 Remote close */
        }
      }
      var remote = getTerminalRemote(ctx);
      if (remote === undefined || remote === null) return;
      try {
        unwrapResult(await remote.close(sessionId, terminalId));
      } catch (_error) {
        /* 已关闭 / 已不存在都算成功 */
      }
    }

    /** 停止当前会话下所有由本插件创建的 Limob 终端。 */
    async function stopAllTerminals(ctx, sessionId) {
      var remote = getTerminalRemote(ctx);
      var registry = loadRegistry();
      var savedForSession = registry.sessions[sessionId] || {};
      var targets = {};
      Object.keys(savedForSession).forEach(function (taskId) {
        var entry = savedForSession[taskId];
        if (entry !== undefined && entry !== null && typeof entry.terminalId === "string") {
          targets[entry.terminalId] = true;
        }
      });

      // 兜底：Host 里还有以 limob- 开头、但本地记录丢了的终端，也一并收掉。
      if (remote !== undefined && remote !== null) {
        try {
          var list = await listTerminals(remote, sessionId);
          for (var i = 0; i < list.length; i += 1) {
            var info = list[i];
            if (info !== null && typeof info === "object" && typeof info.id === "string"
              && info.id.indexOf("limob-") === 0) {
              targets[info.id] = true;
            }
          }
        } catch (_error) {
          /* 列表读不到就只按本地记录关 */
        }
      }

      var closedCount = 0;
      var ids = Object.keys(targets);
      for (var j = 0; j < ids.length; j += 1) {
        await closeTerminal(ctx, sessionId, ids[j]);
        closedCount += 1;
      }

      registry.sessions[sessionId] = {};
      saveRegistry(registry);
      return closedCount;
    }

    // =====================================================================
    // 六、本地记录（sessionId + taskId -> terminalId）
    // =====================================================================
    function loadRegistry() {
      try {
        if (typeof localStorage === "undefined") return { sessions: {} };
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return { sessions: {} };
        var parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && parsed.sessions !== null && typeof parsed.sessions === "object") {
          return parsed;
        }
      } catch (_error) {
        /* 隐私模式 / 配额满时退回内存态 */
      }
      return { sessions: {} };
    }

    function saveRegistry(registry) {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
      } catch (_error) {
        /* 存不下也不影响本次会话内复用 */
      }
    }

    function getSavedTerminalId(registry, sessionId, taskId) {
      var session = registry.sessions[sessionId];
      if (session === undefined || session === null) return undefined;
      var entry = session[taskId];
      if (entry === undefined || entry === null) return undefined;
      return typeof entry.terminalId === "string" ? entry.terminalId : undefined;
    }

    function setSavedTerminalId(registry, sessionId, taskId, terminalId, title) {
      if (registry.sessions[sessionId] === undefined || registry.sessions[sessionId] === null) {
        registry.sessions[sessionId] = {};
      }
      registry.sessions[sessionId][taskId] = {
        terminalId: terminalId,
        title: title,
        savedAt: Date.now()
      };
    }

    // =====================================================================
    // 七、React 组件：dock 里的「运行 Limob」按钮 + 下拉菜单
    // =====================================================================

    /**
     * 单个任务的启动流程：
     *   - 已有同任务终端且仍在运行：聚焦终端页签，提示「已在运行」，绝不重复 spawn；
     *   - 已有终端但进程已退出：先关掉旧终端释放配额，再创建新的；
     *   - 没有终端：创建 -> 改名 -> 写命令 -> 打开内置终端页签。
     */
    async function runTask(ctx, sessionId, task) {
      var remote = getTerminalRemote(ctx);
      if (remote === undefined || remote === null) {
        throw new Error("当前 DSH 没有暴露终端服务（remote.terminal），无法创建内置终端。请确认 DSH 版本支持 Web 终端。");
      }

      var registry = loadRegistry();
      var savedId = getSavedTerminalId(registry, sessionId, task.id);
      var list = await listTerminals(remote, sessionId);

      // 寻找「同一个任务」的终端：先按本地记录 id，再按固定 id（limob-<taskId>）
      // 或终端标题兜底。兜底很重要：localStorage 被清掉、或换了浏览器窗口时，
      // 仍能认出上次开的 dev 终端，避免重复点击时多开一个 dev 进程。
      var preferredIds = ["limob-" + task.id];
      if (savedId !== undefined) preferredIds.unshift(savedId);
      var matches = list.filter(function (info) {
        if (info === null || info === undefined) return false;
        if (preferredIds.indexOf(info.id) !== -1) return true;
        return info.title === task.terminalTitle;
      });
      var existing = matches.find(function (info) {
        return info.state === "running";
      });
      if (existing === undefined) existing = matches[0];
      if (existing !== undefined && savedId !== existing.id) {
        // 兜底命中时同步本地记录，后续复用 / 停止都走同一条路径。
        setSavedTerminalId(registry, sessionId, task.id, existing.id, task.title);
        saveRegistry(registry);
        savedId = existing.id;
      }

      if (existing !== undefined && existing.state === "running") {
        await openOrFocusTab(ctx, sessionId, existing.id);
        return { status: "reused", title: existing.title || task.terminalTitle };
      }

      if (existing !== undefined && existing.state !== "running") {
        // 上一轮命令已结束（例如构建完成）或启动失败：关闭以释放 maxTerminals 配额。
        await closeTerminal(ctx, sessionId, existing.id);
        if (registry.sessions[sessionId] !== undefined && registry.sessions[sessionId] !== null) {
          delete registry.sessions[sessionId][task.id];
        }
        saveRegistry(registry);
        savedId = undefined;
      }

      var shellPath = await pickShellPath(remote, sessionId);
      var baseId = savedId !== undefined ? savedId : "limob-" + task.id;
      var created = await createTerminal(remote, sessionId, baseId, shellPath);
      await safeRename(remote, sessionId, created.id, task.terminalTitle);

      setSavedTerminalId(registry, sessionId, task.id, created.id, task.title);
      saveRegistry(registry);

      await refreshTerminalInventory(ctx, sessionId);
      try {
        await sendCommands(remote, sessionId, created.id, buildCommandLines(task));
      } catch (error) {
        // 命令没送进去时也把终端页签打开：用户至少能看到终端本身并手动输入。
        try {
          await openOrFocusTab(ctx, sessionId, created.id);
        } catch (_ignored) {
          /* 打不开页签时保留原始错误 */
        }
        throw error;
      }
      await openOrFocusTab(ctx, sessionId, created.id);
      return { status: "created", title: task.terminalTitle };
    }

    function RunLimobDock(props) {
      // sessionId 是 conversation.input.dock 的标准注入属性；
      // 另外 owner props 里还有 session，可作兜底。
      var sessionId = props && (props.sessionId || (props.session !== undefined && props.session !== null ? props.session.id : undefined));

      var menuState = react.useState(false);
      var menuOpen = menuState[0];
      var setMenuOpen = menuState[1];

      var busyState = react.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var statusState = react.useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];

      // 更新检查状态：{ phase: "idle"|"checking"|"ready"|"error", available, latestVersion, message, releaseUrl }
      var updatePair = react.useState({ phase: "idle" });
      var updateStatus = updatePair[0];
      var setUpdateStatus = updatePair[1];

      var rootRef = react.useRef(null);

      // 样式已在 factory 执行阶段注入（见 ensureStyles 调用处），这里只做兜底。
      react.useEffect(function () {
        ensureStyles();
      }, []);

      // 延迟检查 GitHub 是否有新 release（不阻塞 UI；失败静默，不打扰终端功能）。
      react.useEffect(function () {
        var alive = true;
        var timer = setTimeout(function () {
          checkForUpdateShared(false).then(function (result) {
            if (alive) setUpdateStatus(result);
          });
        }, 1500);
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, []);

      // 挂载 / 切换会话时，从 Host 终端列表恢复「运行中」状态（刷新页面后也能显示）。
      react.useEffect(function () {
        var alive = true;
        if (sessionId === undefined) return undefined;

        var ctx = runtimeCtx;
        var remote = getTerminalRemote(ctx);
        if (remote === undefined || remote === null) {
          setStatus({ phase: "error", text: "当前 DSH 未提供内置终端服务（remote.terminal）" });
          return undefined;
        }

        (async function () {
          try {
            var list = await listTerminals(remote, sessionId);
            var registry = loadRegistry();
            var saved = registry.sessions[sessionId] || {};
            var taskIds = Object.keys(saved);
            for (var i = 0; i < taskIds.length; i += 1) {
              var taskId = taskIds[i];
              var entry = saved[taskId];
              if (entry === undefined || entry === null) continue;
              var live = list.find(function (info) {
                return info !== null && info !== undefined && info.id === entry.terminalId;
              });
              if (live !== undefined && live.state === "running") {
                var task = TASK_BY_ID[taskId];
                if (alive) {
                  setStatus({
                    phase: "running",
                    text: "运行中 · " + (task !== undefined ? task.title : live.title || "Limob 终端")
                  });
                }
                break;
              }
            }
          } catch (_error) {
            /* 状态恢复失败不打扰用户 */
          }
        })();

        return function () {
          alive = false;
        };
      }, [sessionId]);

      // 点菜单外部 / 按 Esc 关闭菜单。
      react.useEffect(function () {
        if (!menuOpen) return undefined;
        function onPointerDown(event) {
          var root = rootRef.current;
          if (root !== null && !root.contains(event.target)) setMenuOpen(false);
        }
        function onKeyDown(event) {
          if (event.key === "Escape") setMenuOpen(false);
        }
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return function () {
          document.removeEventListener("mousedown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [menuOpen]);

      function handleTaskClick(task) {
        if (busy !== null) return;
        var ctx = runtimeCtx;
        if (ctx === null) return;
        if (sessionId === undefined) {
          setStatus({ phase: "error", text: "请先进入一个会话，再运行 Limob 命令" });
          return;
        }
        setMenuOpen(false);
        setBusy(task.id);
        setStatus({ phase: "starting", text: "正在创建 DSH 终端 · " + task.title });

        runTask(ctx, sessionId, task).then(
          function (result) {
            if (result.status === "reused") {
              setStatus({ phase: "running", text: "已在运行 · 已切换到 " + result.title });
            } else {
              setStatus({ phase: "running", text: "运行中 · " + result.title + "（右侧栏终端）" });
            }
          },
          function (error) {
            setStatus({ phase: "error", text: "启动失败：" + messageOf(error) });
          }
        ).then(function () {
          setBusy(null);
        });
      }

      function handleStopClick() {
        if (busy !== null) return;
        var ctx = runtimeCtx;
        if (ctx === null) return;
        if (sessionId === undefined) return;
        setMenuOpen(false);
        setBusy("__stop__");
        setStatus({ phase: "starting", text: "正在停止 Limob 终端…" });

        stopAllTerminals(ctx, sessionId).then(
          function (count) {
            setStatus({
              phase: count > 0 ? "idle" : "idle",
              text: count > 0 ? "已停止 Limob 终端（" + count + " 个）" : "当前没有正在运行的 Limob 终端"
            });
          },
          function (error) {
            setStatus({ phase: "error", text: "停止失败：" + messageOf(error) });
          }
        ).then(function () {
          setBusy(null);
        });
      }

      // 「检查更新」：忽略 6 小时缓存，手动查一次。
      function handleManualUpdateCheck() {
        setUpdateStatus({ phase: "checking" });
        checkForUpdateShared(true).then(function (result) {
          setUpdateStatus(result);
        });
      }

      // 点击更新提示：跳到 DSH 插件页的本插件详情（那里有完整升级说明）。
      function handleOpenUpdate() {
        setMenuOpen(false);
        openPluginUpdatePage(runtimeCtx, updateStatus && updateStatus.releaseUrl, function (text) {
          setStatus({ phase: "idle", text: text });
        });
      }

      var trigger = h(
        "button",
        {
          type: "button",
          className: "dshLimob-trigger",
          "data-busy": busy !== null ? "true" : "false",
          title: "在 DSH 自带终端里运行 Limob 项目命令（不打开系统终端）",
          onClick: function () {
            if (busy !== null) return;
            setMenuOpen(!menuOpen);
          }
        },
        h("span", { "aria-hidden": "true" }, "▶"),
        h("span", null, "运行 Limob"),
        h("span", { className: "dshLimob-caret", "aria-hidden": "true" })
      );

      var menuChildren = [];

      // 有更新时，菜单最上方先放一条醒目的更新提示。
      if (updateStatus !== null && updateStatus.available) {
        menuChildren.push(
          h(
            "button",
            {
              key: "menu-update",
              type: "button",
              className: "dshLimob-item",
              onClick: handleOpenUpdate
            },
            h("span", { className: "dshLimob-title" }, "发现新版本 v" + updateStatus.latestVersion),
            h("span", { className: "dshLimob-cmd" }, "点击查看升级方式（当前 v" + PLUGIN_VERSION + "）")
          )
        );
      }

      menuChildren.push(
        h("div", { key: "menu-title", className: "dshLimob-menuTitle" }, "在 DSH 内置终端中运行")
      );

      TASKS.forEach(function (task) {
        menuChildren.push(
          h(
            "button",
            {
              key: task.id,
              type: "button",
              className: "dshLimob-item",
              disabled: busy !== null,
              onClick: function () {
                handleTaskClick(task);
              }
            },
            h("span", { className: "dshLimob-title" }, task.title),
            h("span", { className: "dshLimob-cmd" }, task.command)
          )
        );
      });

      menuChildren.push(
        h("div", { key: "menu-sep", className: "dshLimob-sep" }),
        h(
          "button",
          {
            key: "menu-stop",
            type: "button",
            className: "dshLimob-item dshLimob-stop",
            disabled: busy !== null,
            onClick: handleStopClick
          },
          h("span", { className: "dshLimob-title" }, "停止 Limob 终端"),
          h("span", { className: "dshLimob-cmd" }, "关闭本会话里由本插件创建的终端进程")
        )
      );

      // 菜单底部固定一个「检查更新」入口。
      menuChildren.push(
        h("div", { key: "menu-sep-update", className: "dshLimob-sep" }),
        h(
          "button",
          {
            key: "menu-check-update",
            type: "button",
            className: "dshLimob-item",
            disabled: updateStatus !== null && updateStatus.phase === "checking",
            onClick: handleManualUpdateCheck
          },
          h(
            "span",
            { className: "dshLimob-title" },
            updateStatus !== null && updateStatus.phase === "checking" ? "正在检查更新…" : "检查更新"
          ),
          h(
            "span",
            { className: "dshLimob-cmd" },
            updateStatus !== null && updateStatus.latestVersion
              ? "GitHub 最新 release：v" + updateStatus.latestVersion
              : "从 GitHub Releases 检查新版本（当前 v" + PLUGIN_VERSION + "）"
          )
        )
      );

      var menu = menuOpen
        ? h("div", { className: "dshLimob-menu", role: "menu" }, menuChildren)
        : null;

      var statusNode = null;
      if (status !== null) {
        var phase = status.phase || "idle";
        statusNode = h(
          "span",
          { className: "dshLimob-status", title: status.text },
          h("span", { className: "dshLimob-dot", "data-phase": phase, "aria-hidden": "true" }),
          h("span", { className: "dshLimob-statusText" }, status.text)
        );
      }

      // 发现新版本时，在按钮/状态旁给一个可点击的小提示（不打断操作）。
      var updateChip = null;
      if (updateStatus !== null && updateStatus.available) {
        updateChip = h(
          "button",
          {
            type: "button",
            className: "dshLimob-updateChip",
            title: "发现新版本 v" + updateStatus.latestVersion + "，点击查看升级方式",
            onClick: handleOpenUpdate
          },
          "可更新 v" + updateStatus.latestVersion
        );
      }

      return h(
        "div",
        { className: "dshLimob-root", ref: rootRef },
        trigger,
        statusNode,
        updateChip,
        menu
      );
    }

    // =====================================================================
    // 七之二、插件详情页里的更新提示（DSH 插件管理页面 slots）
    // =====================================================================
    // 这两个组件注册到 DSH「插件」页面声明的插件详情 slots：
    //   plugins.detail.badge   标题旁的小标签
    //   plugins.detail.section 详情页底部的一段说明
    // 它们都会收到 subject；只用 subject.kind === "bundle" 且包名是本插件时才渲染。

    function isOwnBundleSubject(subject) {
      return subject !== undefined && subject !== null
        && subject.kind === "bundle"
        && subject.pkg !== undefined && subject.pkg !== null
        && subject.pkg.name === PLUGIN_NAME;
    }

    /** 多个组件共用的「检查更新」hook：挂载后延迟检查，返回 [state, setState]。 */
    function useUpdateStatus() {
      var pair = react.useState({ phase: "idle" });
      var state = pair[0];
      var setState = pair[1];
      react.useEffect(function () {
        var alive = true;
        var timer = setTimeout(function () {
          checkForUpdateShared(false).then(function (result) {
            if (alive) setState(result);
          });
        }, 800);
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, []);
      return [state, setState];
    }

    /** 插件详情页标题旁：只有发现新版本时才显示。 */
    function LimobUpdateBadge(props) {
      if (!isOwnBundleSubject(props && props.subject)) return null;
      var pair = useUpdateStatus();
      var update = pair[0];
      if (update === undefined || update === null || !update.available) return null;
      return h(
        "span",
        {
          className: "dshLimob-updateBadge",
          title: "发现新版本 v" + update.latestVersion + "，打开本插件详情查看升级方式"
        },
        "可更新 v" + update.latestVersion
      );
    }

    /** 插件详情页底部：显示当前/最新版本、检查按钮、升级命令与发布页。 */
    function LimobUpdateSection(props) {
      var subject = props && props.subject;
      if (!isOwnBundleSubject(subject)) return null;

      var updatePair = useUpdateStatus();
      var update = updatePair[0];
      var setUpdate = updatePair[1];

      var copiedPair = react.useState(false);
      var copied = copiedPair[0];
      var setCopied = copiedPair[1];

      var installed = subject.pkg !== undefined && subject.pkg !== null && typeof subject.pkg.version === "string"
        ? subject.pkg.version
        : PLUGIN_VERSION;
      var checking = update !== undefined && update !== null && update.phase === "checking";
      var latest = update !== undefined && update !== null && typeof update.latestVersion === "string"
        ? ("v" + update.latestVersion)
        : (checking ? "检查中…" : "未知");

      var hint;
      if (update !== undefined && update !== null && update.phase === "error") {
        hint = "检查失败：" + update.message + "（不影响终端功能）";
      } else if (update !== undefined && update !== null && update.available) {
        hint = "发现新版本 v" + update.latestVersion + "，建议升级。";
      } else {
        hint = "已是最新版本。";
      }

      function handleCheckNow() {
        setUpdate({ phase: "checking" });
        checkForUpdateShared(true).then(function (result) {
          setUpdate(result);
        });
      }

      function handleCopyCommand() {
        setCopied(copyTextToClipboard(UPGRADE_COMMAND));
      }

      return h(
        "section",
        { className: "dshLimob-detailSection" },
        h("div", { className: "dshLimob-detailTitle" }, "Limob 运行器更新"),
        h("div", { className: "dshLimob-detailMuted" }, "当前版本 v" + installed + " · GitHub 最新 " + latest),
        h("div", null, hint),
        h(
          "div",
          { className: "dshLimob-detailMuted" },
          "升级方式：退出 DeepSeek Harness 后在 profile 目录执行下面的命令；或在「插件 → 添加插件」里粘贴 "
            + INSTALL_SPEC + " 重新安装（先卸载旧版）。"
        ),
        h("code", { className: "dshLimob-detailCode" }, UPGRADE_COMMAND),
        h(
          "div",
          { className: "dshLimob-detailActions" },
          h(
            "button",
            { type: "button", className: "dshLimob-detailBtn", disabled: checking, onClick: handleCheckNow },
            checking ? "检查中…" : "检查更新"
          ),
          h(
            "button",
            { type: "button", className: "dshLimob-detailBtn", onClick: handleCopyCommand },
            copied ? "已复制" : "复制升级命令"
          ),
          h(
            "a",
            { className: "dshLimob-detailBtn", href: GITHUB_RELEASES_PAGE, target: "_blank", rel: "noreferrer" },
            "打开发布页"
          )
        )
      );
    }

    // =====================================================================
    // 八、Cordis 插件入口
    // =====================================================================
    /**
     * 注册到对话输入框 dock 槽位。
     * `conversation.input.dock` 是 list 类型、session 作用域的槽位：
     * 只有进入会话后才会渲染；组件会收到 sessionId 等标准属性。
     */
    /** 插件内部错误只写日志：任何 UI 注册失败都不能影响 DSH 正常聊天。 */
    function logPluginError(ctx, message, error) {
      if (ctx !== null && ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.error === "function") {
        ctx.logger.error("dsh-limob-runner: " + message, error);
      } else if (typeof console !== "undefined") {
        console.error("dsh-limob-runner: " + message, error);
      }
    }

    /**
     * 注册一个 slot 条目；slot 还没声明时会等待（ctx.slots.inject 的语义）。
     * 所有注册都包在 try/catch 里，保证插件部分失败不影响 DSH。
     */
    function registerSlot(ctx, slotName, entryId, component, order) {
      try {
        ctx.slots.inject(slotName, function () {
          return ctx.slots.register(
            {
              name: slotName,
              id: entryId,
              order: order
            },
            component
          );
        });
      } catch (error) {
        logPluginError(ctx, "注册槽位失败（" + slotName + "）", error);
      }
    }

    function apply(ctx) {
      runtimeCtx = ctx;

      // 1) 对话输入框上方的运行菜单（核心功能）。
      registerSlot(ctx, "conversation.input.dock", "limob-runner", RunLimobDock, 40);

      // 2) DSH 插件页的详情扩展：有更新时显示徽标 + 升级说明。
      //    这些 slot 由 ui-plugin-manager 声明；未打开插件页时注册会等待，不影响 dock。
      registerSlot(ctx, "plugins.detail.badge", "limob-runner-update", LimobUpdateBadge, 100);
      registerSlot(ctx, "plugins.detail.section", "limob-runner-update", LimobUpdateSection, 100);
    }

    exports.name = "dsh-limob-runner";
    exports.inject = ["slots"];
    exports.apply = apply;

    // 只给离线测试/CI 用的内部入口；DSH loader 只读 name/inject/apply，不会碰它。
    exports.__limob = {
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
      repoSlug: REPO_SLUG,
      installSpec: INSTALL_SPEC,
      upgradeCommand: UPGRADE_COMMAND,
      parseVersion: parseVersion,
      compareVersions: compareVersions,
      checkForUpdate: checkForUpdate
    };

    return module.exports;
  }
});
