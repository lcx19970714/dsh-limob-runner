/* dsh-limob-runner —— 客户端半体（浏览器侧）v0.4
 *
 * 功能总览：
 *   1) 在对话输入框「正下方」放一个低调的「▶ 运行 Limob」小按钮
 *      （conversation.composer.dock 槽位）：点击向上展开命令菜单；
 *   2) 命令配置页（settings.section）：在 DSH 设置弹窗里新增「Limob 运行器」页，
 *      支持命令的增删改查、排序、启停、全局/项目作用域；
 *   3) 运行命令仍通过 DSH 自带终端（remote.terminal + 右侧栏 terminal 页签），
 *      输出实时滚动；重复点击复用已有终端，支持一键停止；
 *   4) GitHub Releases 更新检查（按钮/菜单/插件页提示），只提示不自动升级。
 *
 * 数据流：
 *   配置：localStorage(dsh.limob-runner.config.v1) <-> 设置页/按钮菜单共用同一个 store
 *   终端：remote.terminal.create/list/attach/rename/close
 *   页签：webTerminals.recover + sidebarRight.openTab("terminal",{params:{terminalId}})
 *
 * 依赖的 DSH 客户端服务是内部接口（非官方稳定 API），调用都有能力检测与 try/catch；
 * 任何失败只影响对应提示，不影响 DSH 正常聊天。
 */
window.__ModuleLoader__.load({
  id: "dsh-limob-runner",
  factory: (require) => {
    "use strict";

    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 只用基线共享模块 react。
    var react = require("react");
    var h = react.createElement;

    // =====================================================================
    // 一、常量与内置命令
    // =====================================================================
    var PLUGIN_NAME = "dsh-limob-runner";
    var PLUGIN_VERSION = "0.4.1";

    // 更新检查（GitHub Releases）
    var REPO_SLUG = "lcx19970714/dsh-limob-runner";
    var INSTALL_SPEC = "github:" + REPO_SLUG;
    var UPGRADE_COMMAND = "dsh plugin --profile desktop add " + INSTALL_SPEC;
    var GITHUB_REPO_PAGE = "https://github.com/" + REPO_SLUG;
    var GITHUB_RELEASES_PAGE = GITHUB_REPO_PAGE + "/releases";
    var GITHUB_API_LATEST = "https://api.github.com/repos/" + REPO_SLUG + "/releases/latest";
    var GITHUB_RAW_PACKAGE = "https://raw.githubusercontent.com/" + REPO_SLUG + "/main/package.json";
    var UPDATE_CACHE_KEY = "dsh.limob-runner.update.v1";
    var UPDATE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时

    // 配置与旧终端映射
    var CONFIG_KEY = "dsh.limob-runner.config.v1";
    var TERMINAL_KEY = "dsh.limob-runner.v1";
    var CONFIG_VERSION = 1;

    // apply(ctx) 时保存客户端根 Context，组件里按需取 DSH 服务。
    var runtimeCtx = null;

    // 内置默认命令：命令文本全部是常量，不接受用户输入拼接。
    // scope 默认 global，保持旧版行为；用户可在设置页改成「仅项目」。
    var BUILTIN_COMMANDS = [
      {
        id: "dev",
        title: "开发调试",
        terminalTitle: "Limob-dev",
        cwd: "H:\\Limob-windows",
        command: "pnpm 客户端-调试",
        scope: "global",
        projectRoot: "",
        enabled: true,
        utf8CodePage: true,
        longRunning: true
      },
      {
        id: "cargo-check",
        title: "Rust 检查（cargo check）",
        terminalTitle: "Limob-cargo-check",
        cwd: "H:\\Limob-windows\\src-tauri",
        command: "cargo check",
        scope: "global",
        projectRoot: "",
        enabled: true,
        utf8CodePage: false,
        longRunning: false
      },
      {
        id: "build-debug",
        title: "快速构建（tauri build --debug）",
        terminalTitle: "Limob-build-debug",
        cwd: "H:\\Limob-windows",
        command: "pnpm exec tauri build --debug --no-bundle",
        scope: "global",
        projectRoot: "",
        enabled: true,
        utf8CodePage: false,
        longRunning: false
      },
      {
        id: "build-release",
        title: "正式构建（pnpm 构建桌面端）",
        terminalTitle: "Limob-build-release",
        cwd: "H:\\Limob-windows",
        command: "pnpm 构建桌面端",
        scope: "global",
        projectRoot: "",
        enabled: true,
        utf8CodePage: true,
        longRunning: false
      }
    ];

    // =====================================================================
    // 二、样式（factory 阶段注入一次，模块系统会随插件卸载清理）
    // =====================================================================
    var STYLE_ID = "dsh-limob-runner-css";
    var CSS = [
      // ---- 输入框下方的运行按钮 ----
      ".dshLimobRunDock{position:relative;display:flex;align-items:center;gap:8px;min-width:0;max-width:100%}",
      ".dshLimobRunBtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap;user-select:none}",
      ".dshLimobRunBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:inherit}",
      ".dshLimobRunBtn[data-busy=true]{cursor:progress;opacity:.7}",
      ".dshLimobRunDot{width:6px;height:6px;border-radius:50%;background:#f59e0b;margin-left:1px}",
      ".dshLimobRunStatus{display:inline-flex;align-items:center;min-width:0;font-size:11px;line-height:16px;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobRunStatus[data-phase=error]{color:#f87171}",
      ".dshLimobRunMenu{position:fixed;z-index:60;box-sizing:border-box;min-width:260px;max-width:min(400px,92vw);max-height:min(60vh,520px);overflow:auto;padding:6px;border-radius:11px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,#26282c);box-shadow:0 12px 32px rgba(0,0,0,.38);font-family:inherit;font-size:12px;line-height:18px;color:inherit}",
      ".dshLimobRunMenuTitle{padding:5px 9px 3px;font-size:11px;opacity:.6;user-select:none;display:flex;justify-content:space-between;gap:8px}",
      ".dshLimobRunItem{display:flex;align-items:flex-start;gap:7px;width:100%;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dshLimobRunItem:hover{background:rgba(103,158,254,.14)}",
      ".dshLimobRunItem[disabled]{opacity:.55;cursor:default}",
      ".dshLimobRunItemMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}",
      ".dshLimobRunItemTitle{font-size:12px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobRunItemCmd{font-size:10px;line-height:14px;opacity:.6;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobRunTag{flex:none;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));font-size:10px;line-height:16px;opacity:.75}",
      ".dshLimobRunRunningDot{flex:none;width:6px;height:6px;margin-top:6px;border-radius:50%;background:#22c55e}",
      ".dshLimobRunSep{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l3,rgba(128,128,128,.3))}",
      // ---- 配置编辑器 ----
      ".dshLimobCfg{display:flex;flex-direction:column;gap:12px;font-size:12px;line-height:18px;color:inherit}",
      ".dshLimobCfgCard{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06))}",
      ".dshLimobCfgH{font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".dshLimobCfgMuted{opacity:.65}",
      ".dshLimobCfgRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
      ".dshLimobCfgField{display:flex;flex-direction:column;gap:3px;flex:1 1 220px;min-width:0}",
      ".dshLimobCfgField > span{font-size:11px;opacity:.7}",
      ".dshLimobCfgInput,.dshLimobCfgTextarea,.dshLimobCfgSelect{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:7px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;padding:5px 8px}",
      ".dshLimobCfgTextarea{min-height:52px;resize:vertical;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px}",
      ".dshLimobCfgBtn{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}",
      ".dshLimobCfgBtn:hover{background:rgba(103,158,254,.14)}",
      ".dshLimobCfgBtn[disabled]{opacity:.5;cursor:default}",
      ".dshLimobCfgBtnPrimary{border-color:rgba(103,158,254,.55);background:rgba(103,158,254,.16)}",
      ".dshLimobCfgBtnDanger{border-color:rgba(239,68,68,.5);color:#f87171}",
      ".dshLimobCfgList{display:flex;flex-direction:column;gap:6px}",
      ".dshLimobCfgItem{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:8px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04))}",
      ".dshLimobCfgItem[data-disabled=true]{opacity:.55}",
      ".dshLimobCfgItemMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 180px}",
      ".dshLimobCfgItemTitle{font-size:12px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobCfgItemCmd{font-size:10px;line-height:14px;opacity:.55;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobCfgTag{flex:none;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));font-size:10px;line-height:16px;opacity:.75;white-space:nowrap}",
      ".dshLimobCfgError{color:#f87171;font-size:11px}",
      ".dshLimobCfgNotice{color:#22c55e;font-size:11px}",
      ".dshLimobCfgCheck{display:inline-flex;align-items:center;gap:5px;font-size:11px;opacity:.85;user-select:none}",
      ".dshLimobCfgModalBackdrop{pointer-events:auto;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px}",
      ".dshLimobCfgModal{box-sizing:border-box;width:min(760px,92vw);max-height:min(84vh,760px);overflow:auto;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,#26282c);box-shadow:0 18px 48px rgba(0,0,0,.45);padding:16px}",
      ".dshLimobCfgPage{max-width:720px;padding:2px 2px 24px}",
      // ---- 插件详情页更新区 ----
      ".dshLimobUpdateBadge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:.5px solid rgba(245,158,11,.5);background:rgba(245,158,11,.12);color:#f59e0b;font-size:11px;line-height:18px;white-space:nowrap}",
      ".dshLimobDetailSection{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));font-size:12px;line-height:18px}",
      ".dshLimobDetailTitle{font-size:13px;font-weight:600}",
      ".dshLimobDetailMuted{opacity:.65}",
      ".dshLimobDetailCode{display:block;padding:8px 10px;border-radius:7px;background:rgba(0,0,0,.22);font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;line-height:16px;word-break:break-all;user-select:text}",
      ".dshLimobDetailActions{display:flex;flex-wrap:wrap;gap:8px}",
      ".dshLimobDetailBtn{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;font-size:12px;text-decoration:none;cursor:pointer}",
      ".dshLimobDetailBtn:hover{background:rgba(103,158,254,.14)}",
      ".dshLimobDetailBtn[disabled]{opacity:.55;cursor:default}"
    ].join("");

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // factory 阶段注入，模块系统认领并在插件卸载时清理。
    ensureStyles();

    // =====================================================================
    // 三、通用小工具
    // =====================================================================
    function getService(ctx, name) {
      if (!ctx) return undefined;
      try {
        return ctx.get(name);
      } catch (_error) {
        return undefined;
      }
    }

    function getTerminalRemote(ctx) {
      var direct = getService(ctx, "remote.terminal");
      if (direct !== undefined && direct !== null) return direct;
      var remote = getService(ctx, "remote");
      if (remote !== undefined && remote !== null) return remote.terminal;
      return undefined;
    }

    function unwrapResult(result) {
      if (result !== null && typeof result === "object" && "ok" in result) {
        if (!result.ok) {
          throw result.error !== undefined && result.error !== null ? result.error : new Error("DSH Remote 调用失败");
        }
        return result.value;
      }
      return result;
    }

    function messageOf(error) {
      if (error === undefined || error === null) return "未知错误";
      if (typeof error === "string") return error;
      if (error.message) return String(error.message);
      return String(error);
    }

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

    function logPluginError(ctx, message, error) {
      if (ctx !== null && ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.error === "function") {
        ctx.logger.error("dsh-limob-runner: " + message, error);
      } else if (typeof console !== "undefined") {
        console.error("dsh-limob-runner: " + message, error);
      }
    }

    function copyTextToClipboard(text) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard !== undefined
          && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_error) {
        /* 回退 */
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
        /* ignore */
      }
      return false;
    }

    // =====================================================================
    // 四、版本比较与更新检查
    // =====================================================================
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

    function compareVersions(left, right) {
      var a = parseVersion(left);
      var b = parseVersion(right);
      if (a === null || b === null) return 0;
      var coreA = [a.major, a.minor, a.patch];
      var coreB = [b.major, b.minor, b.patch];
      for (var i = 0; i < 3; i += 1) {
        if (coreA[i] !== coreB[i]) return coreA[i] > coreB[i] ? 1 : -1;
      }
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
          return numericA ? -1 : 1;
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
        /* ignore */
      }
    }

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

    function openPluginUpdatePage(ctx, releaseUrl, notify) {
      var navigation = getService(ctx, "pluginNavigation");
      if (navigation !== undefined && navigation !== null && typeof navigation.openBundle === "function") {
        try {
          navigation.openBundle(PLUGIN_NAME);
          return true;
        } catch (_error) {
          /* 回退 */
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
    // 五、配置 store（localStorage）+ 作用域匹配
    // =====================================================================
    function makeId() {
      return "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    }

    function normalizeCommand(raw) {
      if (raw === null || typeof raw !== "object") return null;
      var id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : makeId();
      var title = typeof raw.title === "string" ? raw.title.trim() : "";
      var command = typeof raw.command === "string" ? raw.command.trim() : "";
      var cwd = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
      if (title === "" || command === "") return null;
      var scope = raw.scope === "project" ? "project" : "global";
      var projectRoot = typeof raw.projectRoot === "string" ? raw.projectRoot.trim() : "";
      if (scope === "project" && projectRoot === "") {
        // 项目命令必须有项目根目录，否则无法判断何时显示。
        return null;
      }
      return {
        id: id,
        title: title,
        terminalTitle: typeof raw.terminalTitle === "string" ? raw.terminalTitle.trim() : "",
        cwd: cwd,
        command: command,
        scope: scope,
        projectRoot: projectRoot,
        enabled: raw.enabled !== false,
        utf8CodePage: raw.utf8CodePage === true,
        longRunning: raw.longRunning === true
      };
    }

    function defaultConfig() {
      return {
        version: CONFIG_VERSION,
        commands: BUILTIN_COMMANDS.map(function (item) {
          return {
            id: item.id,
            title: item.title,
            terminalTitle: item.terminalTitle,
            cwd: item.cwd,
            command: item.command,
            scope: item.scope,
            projectRoot: item.projectRoot,
            enabled: true,
            utf8CodePage: item.utf8CodePage,
            longRunning: item.longRunning
          };
        }),
        ui: { visible: true }
      };
    }

    function normalizeConfig(raw) {
      var fallback = defaultConfig();
      if (raw === null || typeof raw !== "object") return fallback;
      var commands = [];
      if (Array.isArray(raw.commands)) {
        for (var i = 0; i < raw.commands.length; i += 1) {
          var normalized = normalizeCommand(raw.commands[i]);
          if (normalized !== null) commands.push(normalized);
        }
      }
      var ui = raw.ui !== null && typeof raw.ui === "object" ? raw.ui : {};
      return {
        version: CONFIG_VERSION,
        commands: commands,
        ui: { visible: ui.visible !== false }
      };
    }

    var configCache = null;
    var configListeners = new Set();

    function readConfigFromStorage() {
      try {
        if (typeof localStorage === "undefined") return defaultConfig();
        var raw = localStorage.getItem(CONFIG_KEY);
        if (raw === null) return defaultConfig();
        return normalizeConfig(JSON.parse(raw));
      } catch (_error) {
        return defaultConfig();
      }
    }

    function getConfigSnapshot() {
      if (configCache === null) configCache = readConfigFromStorage();
      return configCache;
    }

    function saveConfig(next) {
      var normalized = normalizeConfig(next);
      configCache = normalized;
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
      } catch (_error) {
        /* 存不下时本次会话内仍有效 */
      }
      configListeners.forEach(function (listener) {
        try {
          listener();
        } catch (_error) {
          /* ignore */
        }
      });
      return normalized;
    }

    function subscribeConfig(listener) {
      configListeners.add(listener);
      return function () {
        configListeners.delete(listener);
      };
    }

    function useStoreFallback(subscribe, getSnapshot) {
      var pair = react.useState(getSnapshot());
      react.useEffect(function () {
        return subscribe(function () {
          pair[1](getSnapshot());
        });
      }, []);
      return pair[0];
    }

    function useConfig() {
      if (typeof react.useSyncExternalStore === "function") {
        return react.useSyncExternalStore(subscribeConfig, getConfigSnapshot, getConfigSnapshot);
      }
      return useStoreFallback(subscribeConfig, getConfigSnapshot);
    }

    function normalizePath(path) {
      return String(path === undefined || path === null ? "" : path)
        .trim()
        .replace(/\//g, "\\")
        .replace(/\\+$/g, "")
        .toLowerCase();
    }

    /** 命令是否属于当前项目：项目根目录相同，或当前项目位于该根目录之下。 */
    function commandMatchesProject(command, projectPath) {
      if (command === null || command === undefined || command.scope !== "project") return false;
      var root = normalizePath(command.projectRoot);
      var current = normalizePath(projectPath);
      if (root === "" || current === "") return false;
      return current === root || current.indexOf(root + "\\") === 0;
    }

    /** 当前会话应显示的命令：启用的全局命令 + 匹配当前项目的项目命令。 */
    function visibleCommands(config, projectPath, hasSession) {
      var list = [];
      var commands = config !== null && config !== undefined && Array.isArray(config.commands) ? config.commands : [];
      for (var i = 0; i < commands.length; i += 1) {
        var command = commands[i];
        if (command.enabled !== true) continue;
        if (command.scope === "global") {
          list.push(command);
        } else if (hasSession && commandMatchesProject(command, projectPath)) {
          list.push(command);
        }
      }
      return list;
    }

    /** 从壳层 slots 提供的 hooks 里解析「当前会话 + 当前工作区路径」。 */
    function useActiveSession(hooks) {
      var sessions = typeof hooks.useSessions === "function" ? hooks.useSessions(function (state) { return state; }) : undefined;
      var workspaces = typeof hooks.useWorkspaces === "function" ? hooks.useWorkspaces(function (state) { return state; }) : undefined;
      var active = null;
      if (sessions !== undefined && sessions !== null && sessions.byId !== undefined && sessions.byId !== null) {
        var ids = Object.keys(sessions.byId);
        for (var i = 0; i < ids.length; i += 1) {
          var record = sessions.byId[ids[i]];
          if (record !== null && record !== undefined && record.retainedBy !== undefined
            && record.retainedBy !== null && (record.retainedBy.mainView || 0) > 0) {
            active = record;
            break;
          }
        }
      }
      var sessionId = active !== null ? (active.id || active.sessionId) : undefined;
      var projectPath = undefined;
      if (sessionId !== undefined && workspaces !== undefined && workspaces !== null
        && Array.isArray(workspaces.items)) {
        for (var j = 0; j < workspaces.items.length; j += 1) {
          var workspace = workspaces.items[j];
          if (workspace !== null && workspace !== undefined && Array.isArray(workspace.sessionIds)
            && workspace.sessionIds.indexOf(sessionId) !== -1) {
            projectPath = workspace.path;
            break;
          }
        }
      }
      if (projectPath === undefined && active !== null && typeof active.cwd === "string") {
        projectPath = active.cwd;
      }
      return {
        sessionId: sessionId,
        projectPath: projectPath,
        sessionTitle: active !== null ? active.title : undefined
      };
    }

    // =====================================================================
    // 六、旧终端映射（sessionId + commandId -> terminalId）
    // =====================================================================
    function loadRegistry() {
      try {
        if (typeof localStorage === "undefined") return { sessions: {} };
        var raw = localStorage.getItem(TERMINAL_KEY);
        if (raw === null) return { sessions: {} };
        var parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && parsed.sessions !== null && typeof parsed.sessions === "object") {
          return parsed;
        }
      } catch (_error) {
        /* ignore */
      }
      return { sessions: {} };
    }

    function saveRegistry(registry) {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(TERMINAL_KEY, JSON.stringify(registry));
      } catch (_error) {
        /* ignore */
      }
    }

    function getSavedTerminalId(registry, sessionId, commandId) {
      var session = registry.sessions[sessionId];
      if (session === undefined || session === null) return undefined;
      var entry = session[commandId];
      if (entry === undefined || entry === null) return undefined;
      return typeof entry.terminalId === "string" ? entry.terminalId : undefined;
    }

    function setSavedTerminalId(registry, sessionId, commandId, terminalId, title) {
      if (registry.sessions[sessionId] === undefined || registry.sessions[sessionId] === null) {
        registry.sessions[sessionId] = {};
      }
      registry.sessions[sessionId][commandId] = {
        terminalId: terminalId,
        title: title,
        savedAt: Date.now()
      };
    }

    // =====================================================================
    // 七、终端操作（DSH 内置终端）
    // =====================================================================
    async function listTerminals(remote, sessionId) {
      var list = unwrapResult(await remote.list(sessionId));
      return Array.isArray(list) ? list : [];
    }

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
      return powershell !== undefined ? powershell.path : undefined;
    }

    /**
     * 组装 PowerShell 命令序列。
     * utf8CodePage：先单独发一条 chcp 65001，避免 Windows PowerShell 5.1 把中文命令按 GBK 解码。
     */
    function buildCommandLines(command) {
      var lines = [];
      if (command.utf8CodePage) lines.push("chcp 65001 | Out-Null");
      var parts = [
        "$env:PATH = (Join-Path $env:USERPROFILE '.cargo\\bin') + ';' + $env:PATH"
      ];
      if (typeof command.cwd === "string" && command.cwd.trim() !== "") {
        parts.push("Set-Location -LiteralPath '" + command.cwd.trim().replace(/'/g, "''") + "'");
      }
      parts.push(command.command);
      lines.push(parts.join("; "));
      return lines;
    }

    async function createTerminal(remote, sessionId, baseId, shellPath, title) {
      var request = { id: baseId, cols: 120, rows: 30 };
      if (shellPath !== undefined) request.shellPath = shellPath;
      try {
        var info = unwrapResult(await remote.create(sessionId, request));
        return { id: baseId, info: info };
      } catch (error) {
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

    async function safeRename(remote, sessionId, terminalId, title) {
      try {
        unwrapResult(await remote.rename(sessionId, terminalId, title));
      } catch (_error) {
        /* 标题只是展示信息 */
      }
    }

    async function sendCommands(remote, sessionId, terminalId, commandLines) {
      var controller = new AbortController();
      var handle = remote.attach(sessionId, terminalId, controller.signal);
      var iterator = null;
      try {
        if (typeof handle[Symbol.asyncIterator] !== "function") {
          for (var directIndex = 0; directIndex < commandLines.length; directIndex += 1) {
            handle.send({ type: "write", sequence: directIndex + 1, data: commandLines[directIndex] + "\r" });
          }
          return;
        }
        iterator = handle[Symbol.asyncIterator]();
        for (var index = 0; index < commandLines.length; index += 1) {
          var sequence = index + 1;
          handle.send({ type: "write", sequence: sequence, data: commandLines[index] + "\r" });
          var acknowledged = false;
          while (!acknowledged) {
            var next = await withTimeout(iterator.next(), 10000, "等待 DSH 终端确认输入超时（10 秒）");
            if (next.done === true) throw new Error("DSH 终端连接在确认命令前结束");
            var frame = next.value;
            if (frame !== null && typeof frame === "object" && frame.type === "ack" && frame.sequence >= sequence) {
              if (frame.refusal !== undefined) throw new Error("DSH 终端拒绝输入：" + String(frame.refusal));
              acknowledged = true;
            }
          }
        }
      } finally {
        try {
          controller.abort();
        } catch (_error) {
          /* ignore */
        }
        if (handle !== null && typeof handle.dispose === "function") {
          try {
            handle.dispose();
          } catch (_error) {
            /* ignore */
          }
        }
        if (iterator !== null && typeof iterator.return === "function") {
          try {
            await iterator.return();
          } catch (_error) {
            /* ignore */
          }
        }
      }
    }

    async function refreshTerminalInventory(ctx, sessionId) {
      var webTerminals = getService(ctx, "webTerminals");
      if (webTerminals === undefined || webTerminals === null) return;
      if (typeof webTerminals.recover !== "function") return;
      try {
        await webTerminals.recover(sessionId, true);
      } catch (_error) {
        /* ignore */
      }
    }

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
            /* ignore */
          }
        }
        try {
          if (sidebarRight.tabDomain !== undefined && typeof sidebarRight.tabDomain.occurrence === "function") {
            var occurrence = sidebarRight.tabDomain.occurrence(sessionId, { id: tab.tabId });
            var params = occurrence.navigation.getSnapshot().params;
            if (params !== undefined && params !== null && params.terminalId === terminalId) return tab.tabId;
          }
        } catch (_error) {
          /* ignore */
        }
      }
      return undefined;
    }

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
          /* ignore */
        }
        try {
          if (typeof sidebarRight.focus === "function") sidebarRight.focus(existingTabId);
        } catch (_error) {
          /* ignore */
        }
        return;
      }
      await refreshTerminalInventory(ctx, sessionId);
      if (typeof sidebarRight.openTab !== "function") {
        throw new Error("DSH 右侧栏不支持 openTab，无法打开内置终端面板");
      }
      sidebarRight.openTab("terminal", { params: { terminalId: terminalId } });
    }

    async function closeTerminal(ctx, sessionId, terminalId) {
      var sidebarRight = getService(ctx, "sidebarRight");
      var tabId = findTerminalTab(ctx, sessionId, terminalId);
      if (tabId !== undefined && sidebarRight !== undefined && sidebarRight !== null
        && typeof sidebarRight.closeIn === "function") {
        try {
          sidebarRight.closeIn(sessionId, tabId);
          return;
        } catch (_error) {
          /* 回退 */
        }
      }
      var remote = getTerminalRemote(ctx);
      if (remote === undefined || remote === null) return;
      try {
        unwrapResult(await remote.close(sessionId, terminalId));
      } catch (_error) {
        /* ignore */
      }
    }

    async function stopAllTerminals(ctx, sessionId) {
      var remote = getTerminalRemote(ctx);
      var registry = loadRegistry();
      var savedForSession = registry.sessions[sessionId] || {};
      var targets = {};
      Object.keys(savedForSession).forEach(function (commandId) {
        var entry = savedForSession[commandId];
        if (entry !== undefined && entry !== null && typeof entry.terminalId === "string") {
          targets[entry.terminalId] = true;
        }
      });
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
          /* ignore */
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

    /**
     * 运行一条配置命令：
     *   - 同一命令已有运行中的终端 -> 聚焦，不重复启动；
     *   - 已有终端但已退出 -> 关闭后重建；
     *   - 否则创建终端、写命令、打开内置终端页签。
     */
    async function runCommand(ctx, sessionId, command) {
      var remote = getTerminalRemote(ctx);
      if (remote === undefined || remote === null) {
        throw new Error("当前 DSH 没有暴露终端服务（remote.terminal），无法创建内置终端。");
      }
      var registry = loadRegistry();
      var savedId = getSavedTerminalId(registry, sessionId, command.id);
      var list = await listTerminals(remote, sessionId);
      var preferredIds = ["limob-" + command.id];
      if (savedId !== undefined) preferredIds.unshift(savedId);
      var terminalTitle = command.terminalTitle !== "" ? command.terminalTitle : ("Limob-" + command.id);
      var matches = list.filter(function (info) {
        if (info === null || info === undefined) return false;
        if (preferredIds.indexOf(info.id) !== -1) return true;
        return info.title === terminalTitle;
      });
      var existing = matches.find(function (info) {
        return info.state === "running";
      });
      if (existing === undefined) existing = matches[0];
      if (existing !== undefined && savedId !== existing.id) {
        setSavedTerminalId(registry, sessionId, command.id, existing.id, command.title);
        saveRegistry(registry);
        savedId = existing.id;
      }
      if (existing !== undefined && existing.state === "running") {
        await openOrFocusTab(ctx, sessionId, existing.id);
        return { status: "reused", title: existing.title || terminalTitle };
      }
      if (existing !== undefined && existing.state !== "running") {
        await closeTerminal(ctx, sessionId, existing.id);
        if (registry.sessions[sessionId] !== undefined && registry.sessions[sessionId] !== null) {
          delete registry.sessions[sessionId][command.id];
        }
        saveRegistry(registry);
        savedId = undefined;
      }
      var shellPath = await pickShellPath(remote, sessionId);
      var baseId = savedId !== undefined ? savedId : ("limob-" + command.id);
      var created = await createTerminal(remote, sessionId, baseId, shellPath, terminalTitle);
      await safeRename(remote, sessionId, created.id, terminalTitle);
      setSavedTerminalId(registry, sessionId, command.id, created.id, command.title);
      saveRegistry(registry);
      await refreshTerminalInventory(ctx, sessionId);
      try {
        await sendCommands(remote, sessionId, created.id, buildCommandLines(command));
      } catch (error) {
        try {
          await openOrFocusTab(ctx, sessionId, created.id);
        } catch (_ignored) {
          /* ignore */
        }
        throw error;
      }
      await openOrFocusTab(ctx, sessionId, created.id);
      return { status: "created", title: terminalTitle };
    }

    // =====================================================================
    // 八、更新状态 hook
    // =====================================================================
    function useUpdateStatus() {
      var pair = react.useState({ phase: "checking" });
      var state = pair[0];
      var setState = pair[1];
      react.useEffect(function () {
        var alive = true;
        var timer = setTimeout(function () {
          checkForUpdateShared(false).then(function (result) {
            if (alive) setState(result);
          });
        }, 900);
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, []);
      return [state, setState];
    }

    function isOwnBundleSubject(subject) {
      return subject !== undefined && subject !== null && subject.kind === "bundle"
        && subject.pkg !== undefined && subject.pkg !== null && subject.pkg.name === PLUGIN_NAME;
    }

    /** 插件详情页标题旁：只有发现新版本时才显示。 */
    function LimobUpdateBadge(props) {
      if (!isOwnBundleSubject(props && props.subject)) return null;
      var pair = useUpdateStatus();
      var update = pair[0];
      if (update === undefined || update === null || !update.available) return null;
      return h("span", {
        className: "dshLimobUpdateBadge",
        title: "发现新版本 v" + update.latestVersion + "，打开本插件详情查看升级方式"
      }, "可更新 v" + update.latestVersion);
    }

    /** 插件详情页底部：版本、检查按钮、升级命令与发布页。 */
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
      } else if (update !== undefined && update !== null && update.phase === "ready") {
        hint = "已是最新版本。";
      } else {
        hint = "正在检查 GitHub 更新…";
      }
      function handleCheckNow() {
        setUpdate({ phase: "checking" });
        checkForUpdateShared(true).then(function (result) {
          setUpdate(result);
        });
      }
      return h("section", { className: "dshLimobDetailSection" },
        h("div", { className: "dshLimobDetailTitle" }, "Limob 运行器更新"),
        h("div", { className: "dshLimobDetailMuted" }, "当前版本 v" + installed + " · GitHub 最新 " + latest),
        h("div", null, hint),
        h("div", { className: "dshLimobDetailMuted" },
          "升级方式：退出 DeepSeek Harness 后在 profile 目录执行下面的命令；或在「插件 → 添加插件」里粘贴 "
            + INSTALL_SPEC + " 重新安装（先卸载旧版）。"),
        h("code", { className: "dshLimobDetailCode" }, UPGRADE_COMMAND),
        h("div", { className: "dshLimobDetailActions" },
          h("button", { type: "button", className: "dshLimobDetailBtn", disabled: checking, onClick: handleCheckNow },
            checking ? "检查中…" : "检查更新"),
          h("button", {
            type: "button",
            className: "dshLimobDetailBtn",
            onClick: function () { setCopied(copyTextToClipboard(UPGRADE_COMMAND)); }
          }, copied ? "已复制" : "复制升级命令"),
          h("a", {
            className: "dshLimobDetailBtn",
            href: GITHUB_RELEASES_PAGE,
            target: "_blank",
            rel: "noreferrer"
          }, "打开发布页")));
    }

    // =====================================================================
    // 九、配置编辑器（设置页与运行按钮的「管理命令…」弹窗共用）
    // =====================================================================
    function LimobConfigEditor(props) {
      var config = useConfig();
      var currentProjectPath = props.currentProjectPath;
      var editingPair = react.useState(null);
      var editing = editingPair[0];
      var setEditing = editingPair[1];
      var errorPair = react.useState("");
      var error = errorPair[0];
      var setError = errorPair[1];
      var noticePair = react.useState("");
      var notice = noticePair[0];
      var setNotice = noticePair[1];
      var deletePair = react.useState(null);
      var pendingDelete = deletePair[0];
      var setPendingDelete = deletePair[1];
      var importPair = react.useState(false);
      var importOpen = importPair[0];
      var setImportOpen = importPair[1];
      var importTextPair = react.useState("");
      var importText = importTextPair[0];
      var setImportText = importTextPair[1];
      var resetPair = react.useState(false);
      var resetArmed = resetPair[0];
      var setResetArmed = resetPair[1];

      function flash(text) {
        setNotice(text);
        setError("");
      }

      function startCreate() {
        setEditing({
          id: "",
          title: "",
          terminalTitle: "",
          cwd: currentProjectPath !== undefined ? currentProjectPath : "",
          command: "",
          scope: "global",
          projectRoot: "",
          enabled: true,
          utf8CodePage: false,
          longRunning: false
        });
        setError("");
      }

      function startEdit(command) {
        setEditing(Object.assign({}, command, { terminalTitle: command.terminalTitle || "" }));
        setError("");
      }

      function updateDraft(field, value) {
        if (editing === null) return;
        var next = Object.assign({}, editing);
        next[field] = value;
        if (field === "command") {
          // 含中文时自动建议 UTF-8（用户可手动关闭）。
          if (/[^\x00-\x7f]/.test(String(value))) next.utf8CodePage = true;
        }
        setEditing(next);
      }

      function saveDraft() {
        if (editing === null) return;
        var normalized = normalizeCommand(editing);
        if (normalized === null) {
          setError("请填写名称、工作目录、命令；作用域为「仅项目」时还要填写项目根目录。");
          return;
        }
        if (normalized.id === "") normalized.id = makeId();
        var next = Object.assign({}, config, { commands: config.commands.slice() });
        var index = -1;
        for (var i = 0; i < next.commands.length; i += 1) {
          if (next.commands[i].id === normalized.id) {
            index = i;
            break;
          }
        }
        if (index === -1) next.commands.push(normalized);
        else next.commands[index] = normalized;
        saveConfig(next);
        setEditing(null);
        setError("");
        flash("已保存命令：" + normalized.title);
      }

      function removeCommand(id) {
        var next = Object.assign({}, config, {
          commands: config.commands.filter(function (command) {
            return command.id !== id;
          })
        });
        saveConfig(next);
        setPendingDelete(null);
        flash("已删除命令");
      }

      function moveCommand(index, delta) {
        var target = index + delta;
        if (target < 0 || target >= config.commands.length) return;
        var commands = config.commands.slice();
        var moved = commands[index];
        commands[index] = commands[target];
        commands[target] = moved;
        saveConfig(Object.assign({}, config, { commands: commands }));
      }

      function toggleEnabled(command) {
        var commands = config.commands.map(function (item) {
          if (item.id !== command.id) return item;
          return Object.assign({}, item, { enabled: !item.enabled });
        });
        saveConfig(Object.assign({}, config, { commands: commands }));
      }

      function resetDefaults() {
        if (!resetArmed) {
          setResetArmed(true);
          flash("再点一次「确认恢复内置命令」：会清空自定义命令（运行按钮显示设置保留）。");
          return;
        }
        var defaults = defaultConfig();
        defaults.ui = config.ui;
        saveConfig(defaults);
        setEditing(null);
        setResetArmed(false);
        flash("已恢复内置的 4 条命令");
      }

      function toggleVisible() {
        var next = Object.assign({}, config, {
          ui: Object.assign({}, config.ui, { visible: !config.ui.visible })
        });
        saveConfig(next);
        flash(config.ui.visible ? "已隐藏运行按钮（在设置里可重新显示）" : "已显示运行按钮");
      }

      function exportConfig() {
        var copied = copyTextToClipboard(JSON.stringify(config, null, 2));
        flash(copied ? "配置 JSON 已复制到剪贴板" : "复制失败，请重试");
      }

      function applyImport() {
        try {
          var parsed = JSON.parse(importText);
          var normalized = normalizeConfig(parsed);
          saveConfig(normalized);
          setImportOpen(false);
          setImportText("");
          setEditing(null);
          setResetArmed(false);
          flash("已导入配置（" + normalized.commands.length + " 条命令）");
        } catch (importError) {
          setError("导入失败：" + messageOf(importError));
        }
      }

      function scopeTag(command) {
        if (command.scope === "project") {
          return "项目 · " + (command.projectRoot || "未设置");
        }
        return "全局";
      }

      return h("div", { className: "dshLimobCfg" },
        h("div", { className: "dshLimobCfgMuted" },
          currentProjectPath !== undefined && currentProjectPath !== ""
            ? "当前工作区：" + currentProjectPath + "（项目命令只在这个项目里显示）"
            : "当前不在会话里；项目命令需要进入对应工作区的会话后才显示。"),

        // 运行按钮显示设置
        h("div", { className: "dshLimobCfgCard" },
          h("div", { className: "dshLimobCfgH" }, h("span", null, "运行按钮"), h("span", { className: "dshLimobCfgMuted" }, "v" + PLUGIN_VERSION)),
          h("div", { className: "dshLimobCfgRow" },
            h("label", { className: "dshLimobCfgCheck" },
              h("input", { type: "checkbox", checked: config.ui.visible, onChange: toggleVisible }),
              "在输入框下方显示「运行」按钮"),
            h("span", { className: "dshLimobCfgMuted" }, "按钮会出现在对话输入框卡片的正下方，点击向上展开命令菜单。"))),

        // 命令列表
        h("div", { className: "dshLimobCfgCard" },
          h("div", { className: "dshLimobCfgH" },
            h("span", null, "命令（" + config.commands.length + "）"),
            h("button", { type: "button", className: "dshLimobCfgBtn dshLimobCfgBtnPrimary", onClick: startCreate }, "新增命令")),
          config.commands.length === 0
            ? h("div", { className: "dshLimobCfgMuted" }, "还没有命令，点「新增命令」添加一条。")
            : h("div", { className: "dshLimobCfgList" },
              config.commands.map(function (command, index) {
                return h("div", {
                  key: command.id,
                  className: "dshLimobCfgItem",
                  "data-disabled": command.enabled ? "false" : "true"
                },
                  h("div", { className: "dshLimobCfgItemMain" },
                    h("div", { className: "dshLimobCfgItemTitle" }, command.title),
                    h("div", { className: "dshLimobCfgItemCmd" }, command.command)),
                  h("span", { className: "dshLimobCfgTag" }, scopeTag(command)),
                  h("label", { className: "dshLimobCfgCheck" },
                    h("input", {
                      type: "checkbox",
                      checked: command.enabled,
                      onChange: function () { toggleEnabled(command); }
                    }),
                    "启用"),
                  h("button", {
                    type: "button",
                    className: "dshLimobCfgBtn",
                    disabled: index === 0,
                    title: "上移",
                    onClick: function () { moveCommand(index, -1); }
                  }, "↑"),
                  h("button", {
                    type: "button",
                    className: "dshLimobCfgBtn",
                    disabled: index === config.commands.length - 1,
                    title: "下移",
                    onClick: function () { moveCommand(index, 1); }
                  }, "↓"),
                  h("button", {
                    type: "button",
                    className: "dshLimobCfgBtn",
                    onClick: function () { startEdit(command); }
                  }, "编辑"),
                  pendingDelete === command.id
                    ? h("span", { className: "dshLimobCfgRow" },
                        h("button", {
                          type: "button",
                          className: "dshLimobCfgBtn dshLimobCfgBtnDanger",
                          onClick: function () { removeCommand(command.id); }
                        }, "确认删除"),
                        h("button", {
                          type: "button",
                          className: "dshLimobCfgBtn",
                          onClick: function () { setPendingDelete(null); }
                        }, "取消"))
                    : h("button", {
                        type: "button",
                        className: "dshLimobCfgBtn dshLimobCfgBtnDanger",
                        onClick: function () { setPendingDelete(command.id); }
                      }, "删除"));
              }))),

        // 编辑表单
        editing !== null
          ? h("div", { className: "dshLimobCfgCard" },
            h("div", { className: "dshLimobCfgH" },
              h("span", null, editing.id === "" ? "新增命令" : "编辑命令"),
              h("button", {
                type: "button",
                className: "dshLimobCfgBtn",
                onClick: function () { setEditing(null); setError(""); }
              }, "取消")),
            h("div", { className: "dshLimobCfgRow" },
              h("label", { className: "dshLimobCfgField" },
                h("span", null, "名称 *"),
                h("input", {
                  className: "dshLimobCfgInput",
                  value: editing.title,
                  placeholder: "例如：开发调试",
                  onChange: function (event) { updateDraft("title", event.target.value); }
                })),
              h("label", { className: "dshLimobCfgField" },
                h("span", null, "终端标题（可选）"),
                h("input", {
                  className: "dshLimobCfgInput",
                  value: editing.terminalTitle,
                  placeholder: "默认 Limob-<id>",
                  onChange: function (event) { updateDraft("terminalTitle", event.target.value); }
                }))),
            h("label", { className: "dshLimobCfgField" },
              h("span", null, "工作目录 *"),
              h("input", {
                className: "dshLimobCfgInput",
                value: editing.cwd,
                placeholder: "H:\\Limob-windows",
                onChange: function (event) { updateDraft("cwd", event.target.value); }
              })),
            h("label", { className: "dshLimobCfgField" },
              h("span", null, "命令（PowerShell，固定文本）*"),
              h("textarea", {
                className: "dshLimobCfgTextarea",
                value: editing.command,
                placeholder: "pnpm 客户端-调试",
                onChange: function (event) { updateDraft("command", event.target.value); }
              })),
            h("div", { className: "dshLimobCfgRow" },
              h("label", { className: "dshLimobCfgField" },
                h("span", null, "作用域"),
                h("select", {
                  className: "dshLimobCfgSelect",
                  value: editing.scope,
                  onChange: function (event) { updateDraft("scope", event.target.value); }
                },
                  h("option", { value: "global" }, "全局（所有项目都显示）"),
                  h("option", { value: "project" }, "仅项目（只在指定项目显示）"))),
              editing.scope === "project"
                ? h("label", { className: "dshLimobCfgField" },
                    h("span", null, "项目根目录 *"),
                    h("input", {
                      className: "dshLimobCfgInput",
                      value: editing.projectRoot,
                      placeholder: "H:\\Limob-windows",
                      onChange: function (event) { updateDraft("projectRoot", event.target.value); }
                    }))
                : null),
            editing.scope === "project"
              ? h("div", { className: "dshLimobCfgRow" },
                  h("button", {
                    type: "button",
                    className: "dshLimobCfgBtn",
                    disabled: currentProjectPath === undefined || currentProjectPath === "",
                    onClick: function () { updateDraft("projectRoot", currentProjectPath || ""); }
                  }, "填入当前工作区"))
              : null,
            h("div", { className: "dshLimobCfgRow" },
              h("label", { className: "dshLimobCfgCheck" },
                h("input", {
                  type: "checkbox",
                  checked: editing.utf8CodePage,
                  onChange: function (event) { updateDraft("utf8CodePage", event.target.checked); }
                }),
                "命令含中文时先执行 chcp 65001（推荐）"),
              h("label", { className: "dshLimobCfgCheck" },
                h("input", {
                  type: "checkbox",
                  checked: editing.enabled,
                  onChange: function (event) { updateDraft("enabled", event.target.checked); }
                }),
                "启用")),
            h("div", { className: "dshLimobCfgRow" },
              h("button", { type: "button", className: "dshLimobCfgBtn dshLimobCfgBtnPrimary", onClick: saveDraft }, "保存"),
              h("button", {
                type: "button",
                className: "dshLimobCfgBtn",
                onClick: function () { setEditing(null); setError(""); }
              }, "取消")))
          : null,

        // 导入/导出/重置
        h("div", { className: "dshLimobCfgCard" },
          h("div", { className: "dshLimobCfgH" }, h("span", null, "备份与维护")),
          h("div", { className: "dshLimobCfgRow" },
            h("button", { type: "button", className: "dshLimobCfgBtn", onClick: exportConfig }, "导出配置 JSON"),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn",
              onClick: function () { setImportOpen(!importOpen); setError(""); }
            }, importOpen ? "收起导入" : "导入配置"),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn dshLimobCfgBtnDanger",
              onClick: resetDefaults
            }, resetArmed ? "确认恢复内置命令" : "恢复内置命令")),
          importOpen
            ? h("div", { className: "dshLimobCfgRow" },
                h("textarea", {
                  className: "dshLimobCfgTextarea",
                  style: { flex: "1 1 100%", minHeight: "90px" },
                  value: importText,
                  placeholder: "粘贴导出的配置 JSON"
                , onChange: function (event) { setImportText(event.target.value); } }),
                h("button", { type: "button", className: "dshLimobCfgBtn dshLimobCfgBtnPrimary", onClick: applyImport }, "导入"),
                h("button", {
                  type: "button",
                  className: "dshLimobCfgBtn",
                  onClick: function () { setImportOpen(false); setImportText(""); }
                }, "取消"))
            : null),

        error !== "" ? h("div", { className: "dshLimobCfgError" }, error) : null,
        notice !== "" ? h("div", { className: "dshLimobCfgNotice" }, notice) : null
      );
    }

    // =====================================================================
    // 十、设置页 section（Settings 弹窗左侧新增一个 Tab）
    // =====================================================================
    function LimobSettingsSection(props) {
      var active = useActiveSession(props);
      return h("div", { className: "dshLimobCfgPage" },
        h("div", { className: "dshLimobCfgCard" },
          h("div", { className: "dshLimobCfgH" },
            h("span", null, "Limob 运行器"),
            h("span", { className: "dshLimobCfgMuted" }, "v" + PLUGIN_VERSION)),
          h("div", { className: "dshLimobCfgMuted" },
            "配置输入框下方「运行 Limob」按钮里出现的命令：新增/编辑/删除/排序/启停，以及全局或仅当前项目显示。")),
        h(LimobConfigEditor, { currentProjectPath: active.projectPath }));
    }

    // =====================================================================
    // 十一、输入框下方的「运行 Limob」按钮（conversation.composer.dock）
    // =====================================================================
    // conversation.composer.dock 是 DSH 对话输入框卡片「正下方」的环境条目槽位，
    // 官方用它放 ActivityPill / UsagePill。这里只放一个低调的小按钮 + 向上展开的菜单，
    // 不再有浮动层、拖动和位置记忆。

    /** 由工作区快照反查某个会话所属工作区路径（用于项目作用域过滤）。 */
    function useProjectPath(useWorkspaces, sessionId) {
      var workspaces = typeof useWorkspaces === "function" ? useWorkspaces(function (state) { return state; }) : undefined;
      if (sessionId === undefined || workspaces === undefined || workspaces === null || !Array.isArray(workspaces.items)) {
        return undefined;
      }
      for (var i = 0; i < workspaces.items.length; i += 1) {
        var workspace = workspaces.items[i];
        if (workspace !== null && workspace !== undefined && Array.isArray(workspace.sessionIds)
          && workspace.sessionIds.indexOf(sessionId) !== -1) {
          return workspace.path;
        }
      }
      return undefined;
    }

    function LimobComposerButton(props) {
      var config = useConfig();
      var sessionId = props !== undefined && props.sessionId !== undefined
        ? props.sessionId
        : (props !== undefined && props.session !== undefined && props.session !== null ? props.session.sessionId : undefined);
      var projectPath = useProjectPath(props !== undefined ? props.useWorkspaces : undefined, sessionId);
      var updatePair = useUpdateStatus();
      var updateStatus = updatePair[0];

      var menuPair = react.useState(false);
      var menuOpen = menuPair[0];
      var setMenuOpen = menuPair[1];
      var menuPosPair = react.useState(null);
      var menuPos = menuPosPair[0];
      var setMenuPos = menuPosPair[1];
      var rootRef = react.useRef(null);
      var buttonRef = react.useRef(null);
      var busyPair = react.useState(null);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var statusPair = react.useState(null);
      var status = statusPair[0];
      var setStatus = statusPair[1];
      var runningPair = react.useState({});
      var running = runningPair[0];
      var setRunning = runningPair[1];
      var configOpenPair = react.useState(false);
      var configOpen = configOpenPair[0];
      var setConfigOpen = configOpenPair[1];

      var commands = visibleCommands(config, projectPath, sessionId !== undefined);

      // 状态提示 6 秒后自动消失。
      react.useEffect(function () {
        if (status === null) return undefined;
        var timer = setTimeout(function () {
          setStatus(null);
        }, 6000);
        return function () {
          clearTimeout(timer);
        };
      }, [status]);

      // 点菜单外部 / Esc 关闭菜单。
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

      async function refreshRunning() {
        if (sessionId === undefined) {
          setRunning({});
          return;
        }
        var remote = getTerminalRemote(runtimeCtx);
        if (remote === undefined || remote === null) return;
        try {
          var list = await listTerminals(remote, sessionId);
          var registry = loadRegistry();
          var saved = registry.sessions[sessionId] || {};
          var next = {};
          Object.keys(saved).forEach(function (commandId) {
            var entry = saved[commandId];
            if (entry === undefined || entry === null) return;
            var live = list.find(function (info) {
              return info !== null && info !== undefined && info.id === entry.terminalId;
            });
            if (live !== undefined && live.state === "running") next[commandId] = true;
          });
          setRunning(next);
        } catch (_error) {
          /* ignore */
        }
      }

      function toggleMenu() {
        if (!menuOpen) {
          refreshRunning();
          try {
            var rect = buttonRef.current !== null ? buttonRef.current.getBoundingClientRect() : null;
            var width = typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 1280;
            var height = typeof window !== "undefined" && typeof window.innerHeight === "number" ? window.innerHeight : 800;
            if (rect !== null) {
              var menuWidth = Math.min(400, width - 16);
              var left = Math.min(Math.max(8, rect.left), Math.max(8, width - menuWidth - 8));
              setMenuPos({
                left: left,
                bottom: height - rect.top + 8,
                maxHeight: Math.max(160, rect.top - 24)
              });
            } else {
              setMenuPos(null);
            }
          } catch (_error) {
            setMenuPos(null);
          }
        }
        setMenuOpen(!menuOpen);
      }

      function handleRun(command) {
        if (busy !== null) return;
        if (sessionId === undefined) {
          setStatus({ phase: "error", text: "请先进入一个会话，再运行命令" });
          return;
        }
        setMenuOpen(false);
        setBusy(command.id);
        setStatus({ phase: "starting", text: "正在启动：" + command.title });
        runCommand(runtimeCtx, sessionId, command).then(
          function (result) {
            setStatus({
              phase: "running",
              text: result.status === "reused" ? ("已在运行 · 已切换到 " + result.title) : ("运行中 · " + result.title)
            });
            refreshRunning();
          },
          function (error) {
            setStatus({ phase: "error", text: "启动失败：" + messageOf(error) });
          }
        ).then(function () {
          setBusy(null);
        });
      }

      function handleStopAll() {
        if (busy !== null || sessionId === undefined) return;
        setMenuOpen(false);
        setBusy("__stop__");
        setStatus({ phase: "starting", text: "正在停止 Limob 终端…" });
        stopAllTerminals(runtimeCtx, sessionId).then(
          function (count) {
            setStatus({ phase: "idle", text: count > 0 ? ("已停止 Limob 终端（" + count + " 个）") : "当前没有正在运行的 Limob 终端" });
            setRunning({});
          },
          function (error) {
            setStatus({ phase: "error", text: "停止失败：" + messageOf(error) });
          }
        ).then(function () {
          setBusy(null);
        });
      }

      function handleCheckUpdate() {
        setStatus({ phase: "starting", text: "正在检查 GitHub 更新…" });
        checkForUpdateShared(true).then(function (result) {
          if (result.phase === "error") {
            setStatus({ phase: "error", text: "检查更新失败：" + result.message });
          } else if (result.available) {
            setStatus({ phase: "idle", text: "发现新版本 v" + result.latestVersion });
          } else {
            setStatus({ phase: "idle", text: "已是最新版本 v" + PLUGIN_VERSION });
          }
        });
      }

      function handleUpdateClick() {
        setMenuOpen(false);
        openPluginUpdatePage(runtimeCtx, updateStatus && updateStatus.releaseUrl, function (text) {
          setStatus({ phase: "idle", text: text });
        });
      }

      if (config.ui.visible === false) return null;

      // 菜单用 fixed 定位（相对按钮的视口坐标），避免被输入框区域的 overflow 裁切。
      var menuStyle = menuPos !== null
        ? {
            position: "fixed",
            left: menuPos.left + "px",
            bottom: menuPos.bottom + "px",
            top: "auto",
            right: "auto",
            maxHeight: menuPos.maxHeight + "px"
          }
        : { left: "0" };

      var menu = menuOpen
        ? h("div", { className: "dshLimobRunMenu", style: menuStyle, role: "menu" },
            updateStatus !== null && updateStatus.available
              ? h("button", { type: "button", className: "dshLimobRunItem", onClick: handleUpdateClick },
                  h("span", { className: "dshLimobRunItemMain" },
                    h("span", { className: "dshLimobRunItemTitle" }, "发现新版本 v" + updateStatus.latestVersion),
                    h("span", { className: "dshLimobRunItemCmd" }, "点击查看升级方式（当前 v" + PLUGIN_VERSION + "）")))
              : null,
            h("div", { className: "dshLimobRunMenuTitle" },
              h("span", null, "运行 Limob 命令"),
              h("span", null, projectPath !== undefined ? String(projectPath) : "当前会话")),
            commands.length === 0
              ? h("div", { className: "dshLimobRunMenuTitle" }, "当前项目没有可用命令：去「管理命令」里添加，或把命令作用域设为全局。")
              : commands.map(function (command) {
                  return h("button", {
                    key: command.id,
                    type: "button",
                    className: "dshLimobRunItem",
                    disabled: busy !== null || sessionId === undefined,
                    onClick: function () { handleRun(command); }
                  },
                    running[command.id] ? h("span", { className: "dshLimobRunRunningDot", title: "运行中" }) : null,
                    h("span", { className: "dshLimobRunItemMain" },
                      h("span", { className: "dshLimobRunItemTitle" }, command.title),
                      h("span", { className: "dshLimobRunItemCmd" }, command.command)),
                    h("span", { className: "dshLimobRunTag" }, command.scope === "project" ? "项目" : "全局"));
                }),
            h("div", { className: "dshLimobRunSep" }),
            h("button", {
              type: "button",
              className: "dshLimobRunItem",
              disabled: busy !== null || sessionId === undefined,
              onClick: handleStopAll
            },
              h("span", { className: "dshLimobRunItemMain" },
                h("span", { className: "dshLimobRunItemTitle" }, "停止本会话 Limob 终端"),
                h("span", { className: "dshLimobRunItemCmd" }, "关闭由本插件创建的终端进程"))),
            h("button", {
              type: "button",
              className: "dshLimobRunItem",
              onClick: function () { setMenuOpen(false); setConfigOpen(true); }
            },
              h("span", { className: "dshLimobRunItemMain" },
                h("span", { className: "dshLimobRunItemTitle" }, "管理命令…"),
                h("span", { className: "dshLimobRunItemCmd" }, "新增/编辑/删除/排序，设置全局或项目作用域"))),
            h("button", {
              type: "button",
              className: "dshLimobRunItem",
              disabled: updateStatus !== null && updateStatus.phase === "checking",
              onClick: handleCheckUpdate
            },
              h("span", { className: "dshLimobRunItemMain" },
                h("span", { className: "dshLimobRunItemTitle" }, updateStatus !== null && updateStatus.phase === "checking" ? "正在检查更新…" : "检查更新"),
                h("span", { className: "dshLimobRunItemCmd" },
                  updateStatus !== null && updateStatus.latestVersion
                    ? "GitHub 最新 release：v" + updateStatus.latestVersion
                    : "从 GitHub Releases 检查新版本（当前 v" + PLUGIN_VERSION + "）"))))
        : null;

      var configModal = configOpen
        ? h("div", {
            className: "dshLimobCfgModalBackdrop",
            onMouseDown: function (event) {
              if (event.target === event.currentTarget) setConfigOpen(false);
            }
          },
            h("div", { className: "dshLimobCfgModal" },
              h("div", { className: "dshLimobCfgH", style: { marginBottom: "10px" } },
                h("span", null, "Limob 运行器 · 命令配置"),
                h("button", {
                  type: "button",
                  className: "dshLimobCfgBtn",
                  onClick: function () { setConfigOpen(false); }
                }, "关闭")),
              h(LimobConfigEditor, { currentProjectPath: projectPath })))
        : null;

      return h("div", { ref: rootRef, className: "dshLimobRunDock" },
        h("button", {
          ref: buttonRef,
          type: "button",
          className: "dshLimobRunBtn",
          "data-busy": busy !== null ? "true" : "false",
          title: "在 DSH 自带终端里运行 Limob 命令（点击选择命令）",
          "aria-label": "运行 Limob 命令",
          onClick: function () {
            if (busy !== null) return;
            toggleMenu();
          }
        },
          h("span", { "aria-hidden": "true" }, busy !== null ? "…" : "▶"),
          h("span", null, "运行"),
          updateStatus !== null && updateStatus.available ? h("span", { className: "dshLimobRunDot", title: "有新版本" }) : null),
        status !== null
          ? h("span", { className: "dshLimobRunStatus", "data-phase": status.phase || "idle", title: status.text }, status.text)
          : null,
        menu,
        configModal);
    }

    // =====================================================================
    // 十二、注册
    // =====================================================================
    function registerSlot(ctx, slotName, entryId, component, order, label) {
      try {
        var options = { name: slotName, id: entryId, order: order };
        if (typeof label === "string" && label !== "") options.label = label;
        ctx.slots.inject(slotName, function () {
          return ctx.slots.register(options, component);
        });
      } catch (error) {
        logPluginError(ctx, "注册槽位失败（" + slotName + "）", error);
      }
    }

    function apply(ctx) {
      runtimeCtx = ctx;
      // 输入框卡片正下方的小按钮（conversation.composer.dock）。
      registerSlot(ctx, "conversation.composer.dock", "limob-runner-run", LimobComposerButton, 40);
      // 设置弹窗左侧新增「Limob 运行器」页（settings.section 的每个条目就是一页）。
      registerSlot(ctx, "settings.section", "limob-runner", LimobSettingsSection, 60, "Limob 运行器");
      // DSH 插件页的更新提示（沿用 0.2 的能力）。
      registerSlot(ctx, "plugins.detail.badge", "limob-runner-update", LimobUpdateBadge, 100);
      registerSlot(ctx, "plugins.detail.section", "limob-runner-update", LimobUpdateSection, 100);
    }

    exports.name = "dsh-limob-runner";
    exports.inject = ["slots"];
    exports.apply = apply;

    // 仅给离线测试/CI 用的内部入口；DSH loader 只读 name/inject/apply。
    exports.__limob = {
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
      repoSlug: REPO_SLUG,
      installSpec: INSTALL_SPEC,
      upgradeCommand: UPGRADE_COMMAND,
      parseVersion: parseVersion,
      compareVersions: compareVersions,
      checkForUpdate: checkForUpdate,
      config: {
        defaults: defaultConfig,
        normalize: normalizeConfig,
        normalizeCommand: normalizeCommand,
        visibleCommands: visibleCommands,
        commandMatchesProject: commandMatchesProject,
        normalizePath: normalizePath
      }
    };

    return module.exports;
  }
});
