/* dsh-runner —— 客户端半体（浏览器侧）v0.7
 *
 * 功能总览：
 *   1) 在对话输入框「正下方」放一个低调的「▶ 运行」小按钮
 *      （conversation.composer.dock 槽位）：点击向上展开命令菜单；
 *   2) 命令配置页（settings.section）：在 DSH 设置弹窗里新增「dsh-runner」页，
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
  id: "dsh-runner",
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
    var PLUGIN_NAME = "dsh-runner";
    var PLUGIN_VERSION = "0.8.1";

    // 更新检查（GitHub Releases）
    var REPO_SLUG = "lcx19970714/dsh-runner";
    var INSTALL_SPEC = "github:" + REPO_SLUG;
    var UPGRADE_COMMAND = "dsh plugin --profile desktop add " + INSTALL_SPEC;
    var GITHUB_REPO_PAGE = "https://github.com/" + REPO_SLUG;
    var GITHUB_RELEASES_PAGE = GITHUB_REPO_PAGE + "/releases";
    var GITHUB_API_LATEST = "https://api.github.com/repos/" + REPO_SLUG + "/releases/latest";
    var GITHUB_RAW_PACKAGE = "https://raw.githubusercontent.com/" + REPO_SLUG + "/main/package.json";
    var UPDATE_CACHE_KEY = "dsh.limob-runner.update.v1";
    var UPDATE_TTL_MS = 10 * 60 * 1000; // 10 分钟：菜单打开时能较快看到 GitHub 新版本

    // 配置与旧终端映射
    var CONFIG_KEY = "dsh.limob-runner.config.v1";
    var TERMINAL_KEY = "dsh.limob-runner.v1";
    var GLOBAL_TABS_KEY = "dsh.runner.globalTabs.v1";
    var CONFIG_VERSION = 1;

    // apply(ctx) 时保存客户端根 Context，组件里按需取 DSH 服务。
    var runtimeCtx = null;
    // Host 侧配置存储的 RPC 连接；Host 半体负责写 commands.json，AI Tool 和浏览器共用同一份配置。
    var hostConnection = null;
    var hostSaveTimer = null;
    var hostSavePending = null;

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
      ".dshLimobRunFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));margin-top:4px;padding:4px 4px 1px 7px;font-size:10px;line-height:16px;opacity:.75}",
      ".dshLimobRunFootBtn{display:inline-flex;align-items:center;gap:4px;min-width:0;padding:2px 4px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:10px;line-height:16px;cursor:pointer;white-space:nowrap;opacity:.8}",
      ".dshLimobRunFootBtn:hover:not(:disabled){background:rgba(128,128,128,.14);opacity:1}",
      ".dshLimobRunFootBtn:disabled{cursor:default;opacity:.55}",
      ".dshLimobRunFootDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,rgba(128,128,128,.65));flex:none}",
      ".dshLimobRunFootDot[data-state=update]{background:#f59e0b}",
      ".dshLimobRunFootDot[data-state=checking]{background:#679efe}",
      ".dshLimobRunFootDot[data-state=error]{background:#f87171}",
      ".dshLimobRunFootGitHub{display:inline-flex;align-items:center;gap:3px;flex:none;padding:2px 4px;border-radius:5px;color:inherit;text-decoration:none;font-size:10px;line-height:16px;opacity:.8;white-space:nowrap}",
      ".dshLimobRunFootGitHub:hover{opacity:1;background:rgba(128,128,128,.14);text-decoration:none}",
      ".dshLimobRunItem{display:flex;align-items:flex-start;gap:7px;width:100%;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dshLimobRunItem:hover{background:rgba(103,158,254,.14)}",
      ".dshLimobRunItem[disabled]{opacity:.55;cursor:default}",
      ".dshLimobRunItem[data-danger=true]:hover:not([disabled]){background:rgba(239,68,68,.12)}",
      ".dshLimobRunItemMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}",
      ".dshLimobRunItemTitle{font-size:12px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobRunItemCmd{font-size:10px;line-height:14px;opacity:.6;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobRunTag{flex:none;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));font-size:10px;line-height:16px;opacity:.75}",
      ".dshLimobRunRunningDot{flex:none;width:6px;height:6px;margin-top:6px;border-radius:50%;background:#22c55e}",
      ".dshLimobRunSep{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l3,rgba(128,128,128,.3))}",
      // ---- 左侧导航「运行」页（全局命令） ----
      ".dshLimobGlobalPage{display:flex;flex-direction:column;gap:16px;width:100%;max-width:780px;margin:0 auto;padding:28px 24px 40px;box-sizing:border-box;font-size:13px;line-height:20px;color:inherit}",
      ".dshLimobGlobalHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));padding-bottom:12px}",
      ".dshLimobGlobalTitle{font-size:17px;font-weight:600;line-height:24px}",
      ".dshLimobGlobalSub{font-size:12px;line-height:18px;opacity:.6;margin-top:3px}",
      ".dshLimobGlobalVersion{font-size:10px;opacity:.4;flex:none}",
      ".dshLimobGlobalToolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshLimobGlobalStat{font-size:12px;opacity:.6;flex:1 1 200px}",
      ".dshLimobGlobalList{display:flex;flex-direction:column;gap:8px}",
      ".dshLimobGlobalRow{display:flex;align-items:center;gap:12px;min-width:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05))}",
      ".dshLimobGlobalRow[data-status=running]{border-color:rgba(34,197,94,.45)}",
      ".dshLimobGlobalMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
      ".dshLimobGlobalNameLine{display:flex;align-items:center;gap:7px;min-width:0}",
      ".dshLimobGlobalName{font-size:13px;font-weight:500;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobGlobalCmd{font-size:11px;line-height:16px;opacity:.55;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobGlobalStatus{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;opacity:.75;white-space:nowrap}",
      ".dshLimobGlobalDot{width:7px;height:7px;border-radius:50%;background:rgba(128,128,128,.55);flex:none}",
      ".dshLimobGlobalDot[data-status=running]{background:#22c55e}",
      ".dshLimobGlobalDot[data-status=exited]{background:#f59e0b}",
      ".dshLimobGlobalDot[data-status=failed]{background:#f87171}",
      ".dshLimobGlobalActions{display:flex;align-items:center;gap:6px;flex:none}",
      ".dshLimobGlobalEmpty{padding:28px 12px;text-align:center;font-size:12px;opacity:.55}",
      ".dshLimobGlobalTips{font-size:11px;line-height:17px;opacity:.5;border-top:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));padding-top:10px}",
      ".dshLimobGlobalNotice{font-size:11px;line-height:17px;color:#22c55e}",
      ".dshLimobGlobalError{font-size:11px;line-height:17px;color:#f87171}",
      ".dshLimobNavIcon{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;color:currentColor}",
      // ---- 设置页：命令配置（紧凑布局） ----
      ".dshLimobCfgPage{display:flex;flex-direction:column;gap:10px;width:100%;max-width:100%;padding:0 0 18px;font-size:12px;line-height:18px;color:inherit;box-sizing:border-box}",
      ".dshLimobPageHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:2px 2px 9px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35))}",
      ".dshLimobPageTitle{font-size:15px;font-weight:600;line-height:22px}",
      ".dshLimobPageSub{font-size:11px;line-height:16px;opacity:.6;margin-top:2px}",
      ".dshLimobPageVersion{font-size:10px;line-height:16px;opacity:.4;flex:none;padding-top:3px}",
      ".dshLimobCfg{display:flex;flex-direction:column;gap:10px;min-width:0}",
      ".dshLimobCfgToolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
      ".dshLimobCfgStat{flex:1 1 160px;min-width:0;font-size:11px;line-height:16px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobSwitch{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:16px;opacity:.85;user-select:none;cursor:pointer;position:relative;white-space:nowrap}",
      ".dshLimobSwitch input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",
      ".dshLimobSwitchTrack{width:26px;height:15px;border-radius:999px;background:rgba(128,128,128,.35);position:relative;flex:none;transition:background .15s}",
      ".dshLimobSwitchTrack::after{content:\"\";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;transition:left .15s}",
      ".dshLimobSwitch input:checked + .dshLimobSwitchTrack{background:#679efe}",
      ".dshLimobSwitch input:checked + .dshLimobSwitchTrack::after{left:13px}",
      ".dshLimobCfgBtn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 9px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap}",
      ".dshLimobCfgBtn:hover{background:rgba(103,158,254,.12)}",
      ".dshLimobCfgBtn[disabled]{opacity:.45;cursor:default}",
      ".dshLimobCfgBtnPrimary{border-color:rgba(103,158,254,.55);background:rgba(103,158,254,.16);color:#679efe}",
      ".dshLimobCfgBtnPrimary:hover{background:rgba(103,158,254,.24)}",
      ".dshLimobCfgBtnDanger{border-color:rgba(239,68,68,.45);color:#f87171}",
      ".dshLimobCfgBtnDanger:hover{background:rgba(239,68,68,.12)}",
      ".dshLimobCfgBtnGhost{border:0;padding:0 6px;height:22px;opacity:.72}",
      ".dshLimobCfgBtnGhost:hover{opacity:1;background:rgba(128,128,128,.12)}",
      ".dshLimobCmdList{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05))}",
      ".dshLimobCmdRow{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.22));min-width:0}",
      ".dshLimobCmdRow:last-child{border-bottom:0}",
      ".dshLimobCmdRow:hover{background:rgba(103,158,254,.06)}",
      ".dshLimobCmdRow[data-disabled=true]{opacity:.55}",
      ".dshLimobCmdMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;cursor:pointer}",
      ".dshLimobCmdTitleLine{display:flex;align-items:center;gap:6px;min-width:0}",
      ".dshLimobCmdTitle{font-size:12px;font-weight:500;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobTag{flex:none;padding:0 5px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));font-size:9px;line-height:14px;opacity:.8;white-space:nowrap;max-width:46%;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobTag[data-scope=project]{border-color:rgba(103,158,254,.45);color:#679efe;background:rgba(103,158,254,.08)}",
      ".dshLimobCmdPreview{font-size:10px;line-height:14px;opacity:.5;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobCmdActions{display:flex;align-items:center;gap:2px;flex:none}",
      ".dshLimobIconBtn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer;opacity:.6}",
      ".dshLimobIconBtn:hover{background:rgba(128,128,128,.16);opacity:1}",
      ".dshLimobIconBtn[disabled]{opacity:.25;cursor:default}",
      ".dshLimobIconBtn[data-danger=true]:hover{background:rgba(239,68,68,.14);color:#f87171}",
      ".dshLimobCfgEmpty{padding:18px 12px;text-align:center;font-size:11px;opacity:.55}",
      ".dshLimobCfgForm{border:.5px solid rgba(103,158,254,.35);border-radius:10px;background:rgba(103,158,254,.05);padding:11px 12px;display:flex;flex-direction:column;gap:9px}",
      ".dshLimobCfgFormTop{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".dshLimobCfgFormTitle{font-size:12px;font-weight:600;line-height:17px}",
      ".dshLimobFormGrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}",
      ".dshLimobFormField{display:flex;flex-direction:column;gap:3px;min-width:0}",
      ".dshLimobFormField[data-wide=true]{grid-column:1 / -1}",
      ".dshLimobFormField > span{font-size:10px;line-height:14px;opacity:.6}",
      ".dshLimobInput,.dshLimobTextarea,.dshLimobSelect{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:6px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:12px;padding:5px 8px;min-width:0}",
      ".dshLimobTextarea{min-height:46px;resize:vertical;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;line-height:16px}",
      ".dshLimobSegment{display:inline-flex;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:6px;overflow:hidden;flex:none}",
      ".dshLimobSegment button{border:0;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:20px;padding:2px 10px;cursor:pointer;opacity:.7}",
      ".dshLimobSegment button[data-active=true]{background:rgba(103,158,254,.16);color:#679efe;opacity:1}",
      ".dshLimobFormRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
      ".dshLimobFormRow .dshLimobSelect{flex:1 1 180px}",
      ".dshLimobLinkBtn{border:0;background:transparent;color:#679efe;font:inherit;font-size:10px;line-height:16px;padding:0;cursor:pointer;opacity:.85}",
      ".dshLimobLinkBtn:hover{opacity:1;text-decoration:underline}",
      ".dshLimobFormFoot{display:flex;align-items:center;gap:8px;justify-content:flex-end;min-height:24px}",
      ".dshLimobFormError{color:#f87171;font-size:11px;line-height:16px;margin-right:auto}",
      ".dshLimobCfgFooter{display:flex;align-items:center;gap:2px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));padding-top:7px;margin-top:1px;flex-wrap:wrap}",
      ".dshLimobCfgFooterVersion{margin-left:auto;font-size:10px;line-height:16px;opacity:.35;flex:none}",
      ".dshLimobImportBox{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));border-radius:8px;padding:8px}",
      ".dshLimobImportBox .dshLimobTextarea{min-height:76px}",
      ".dshLimobCfgNotice{color:#22c55e;font-size:11px;line-height:16px}",
      ".dshLimobCfgError{color:#f87171;font-size:11px;line-height:16px}",
      ".dshLimobFieldHint{font-size:10px;line-height:14px;opacity:.5;margin-top:2px}",
      ".dshLimobCfgTips{display:flex;flex-direction:column;gap:3px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));padding:9px 2px 0;margin-top:2px;font-size:11px;line-height:17px;opacity:.55}",
      ".dshLimobCfgTipsTitle{font-size:11px;font-weight:600;opacity:.9}",
      ".dshLimobCfgModalBackdrop{pointer-events:auto;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:20px}",
      ".dshLimobCfgModal{box-sizing:border-box;width:min(720px,94vw);max-height:min(86vh,780px);overflow:auto;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,#26282c);box-shadow:0 18px 48px rgba(0,0,0,.45);padding:14px}",
      ".dshLimobCfgH{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:600}",
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
        ctx.logger.error("dsh-runner: " + message, error);
      } else if (typeof console !== "undefined") {
        console.error("dsh-runner: " + message, error);
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
      // 同步到 Host 的 commands.json：AI Tool 和浏览器设置页共用同一份配置。
      // 没有 Host（例如离线测试）时自动退化为纯 localStorage。
      persistConfigToHost(normalized);
      return normalized;
    }

    /** 调用 Host 半体注册的 RPC；失败返回 undefined，不阻塞界面。 */
    async function hostRpc(endpoint, payload) {
      if (hostConnection === null || hostConnection === undefined || hostConnection.rpc === undefined) return undefined;
      try {
        var result = await hostConnection.rpc.call("/api", "dsh-runner/" + endpoint, payload === undefined ? {} : payload);
        if (result === null || result === undefined) return undefined;
        if (result.ok !== true) throw new Error(result.error && result.error.message ? result.error.message : "RPC 失败");
        return result.value;
      } catch (_error) {
        return undefined;
      }
    }

    /** 把 Host 的配置应用到浏览器 store（不反向写 Host，避免循环）。 */
    function applyConfigFromHost(raw) {
      var normalized = normalizeConfig(raw);
      configCache = normalized;
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
      } catch (_error) {
        /* ignore */
      }
      configListeners.forEach(function (listener) {
        try {
          listener();
        } catch (_error) {
          /* ignore */
        }
      });
    }

    /** 防抖写入 Host，避免开关/排序连续点击时发很多次 RPC。 */
    function persistConfigToHost(config) {
      if (hostConnection === null || hostConnection === undefined) return;
      hostSavePending = config;
      if (hostSaveTimer !== null) clearTimeout(hostSaveTimer);
      hostSaveTimer = setTimeout(function () {
        hostSaveTimer = null;
        var pending = hostSavePending;
        hostSavePending = null;
        if (pending !== null) hostRpc("config/save", { config: pending });
      }, 300);
    }

    /**
     * 从 Host 拉取最新配置（AI 可能刚通过 Tool 改过）。
     * Host 文件还不存在时，把浏览器当前配置作为初始值写过去。
     */
    async function syncConfigFromHost() {
      // 先把还没落盘的本地修改写掉，避免同步又把刚保存的命令覆盖回旧版本。
      if (hostSavePending !== null) {
        var pending = hostSavePending;
        hostSavePending = null;
        if (hostSaveTimer !== null) {
          clearTimeout(hostSaveTimer);
          hostSaveTimer = null;
        }
        await hostRpc("config/save", { config: pending });
      }
      var value = await hostRpc("config/get", {});
      if (value === undefined) return false;
      if (value.config === null || value.config === undefined) {
        await hostRpc("config/save", { config: getConfigSnapshot() });
        return true;
      }
      var incoming = normalizeConfig(value.config);
      var current = getConfigSnapshot();
      if (JSON.stringify(incoming) !== JSON.stringify(current)) applyConfigFromHost(incoming);
      return true;
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
        h("div", { className: "dshLimobDetailTitle" }, "dsh-runner 更新"),
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
    // 交互原则：列表尽量紧凑、少留白；编辑表单内联展开，作用域用分段按钮选择，
    // 项目级命令直接从 DSH 已注册的工作区下拉选择，不需要手输路径（也允许自定义）。

    /** 从 useWorkspaces 快照里取出「项目选择器」选项（去重、保留标题）。 */
    function workspaceOptionsFrom(useWorkspaces) {
      var workspaces = typeof useWorkspaces === "function" ? useWorkspaces(function (state) { return state; }) : undefined;
      var items = workspaces !== undefined && workspaces !== null && Array.isArray(workspaces.items) ? workspaces.items : [];
      var seen = {};
      var options = [];
      for (var i = 0; i < items.length; i += 1) {
        var workspace = items[i];
        if (workspace === null || workspace === undefined || typeof workspace.path !== "string" || workspace.path === "") continue;
        var key = normalizePath(workspace.path);
        if (seen[key] === true) continue;
        seen[key] = true;
        var title = typeof workspace.title === "string" && workspace.title !== ""
          ? workspace.title
          : (workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path);
        options.push({ path: workspace.path, title: title });
      }
      return options;
    }

    /** 在项目选项里找路径对应的标题；找不到返回路径最后一段。 */
    function projectTitleOf(path, options) {
      if (path === undefined || path === null || path === "") return "未指定项目";
      var key = normalizePath(path);
      for (var i = 0; i < options.length; i += 1) {
        if (normalizePath(options[i].path) === key) return options[i].title;
      }
      var parts = String(path).split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(path);
    }

    /** 16x16 线性小图标（统一 viewBox/颜色，避免用文字符号或 emoji 当图标）。 */
    function limobIcon(name) {
      var base = { width: 15, height: 15, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" };
      if (name === "up") return h("svg", base, h("path", { d: "M8 4l4 4H9v4H7V8H4l4-4z", fill: "currentColor" }));
      if (name === "down") return h("svg", base, h("path", { d: "M8 12l-4-4h3V4h2v4h3l-4 4z", fill: "currentColor" }));
      if (name === "edit") return h("svg", base, h("path", { d: "M3 11.5V13h1.5L12 5.5 10.5 4 3 11.5zM13.7 3.3a1 1 0 0 0 0-1.4l-.6-.6a1 1 0 0 0-1.4 0L11 2l1.9 1.9.8-.6z", fill: "currentColor" }));
      if (name === "trash") return h("svg", base, h("path", { d: "M6.5 2h3l.5 1H13v1H3V3h3l.5-1zM4.2 5h7.6l-.6 8H4.8L4.2 5z", fill: "currentColor" }));
      if (name === "close") return h("svg", base, h("path", { d: "M4.3 3.3L8 7l3.7-3.7 1.4 1.4L9.4 8.4l3.7 3.7-1.4 1.4L8 9.8l-3.7 3.7-1.4-1.4 3.7-3.7-3.7-3.7z", fill: "currentColor" }));
      if (name === "plus") return h("svg", base, h("path", { d: "M7 3h2v4h4v2H9v4H7V9H3V7h4V3z", fill: "currentColor" }));
      return null;
    }

    function LimobConfigEditor(props) {
      var config = useConfig();
      var currentProjectPath = props !== undefined ? props.currentProjectPath : undefined;
      var workspaces = props !== undefined && Array.isArray(props.workspaces) ? props.workspaces : [];

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
      var customProjectPair = react.useState(false);
      var projectCustom = customProjectPair[0];
      var setProjectCustom = customProjectPair[1];

      // 提示 3.5 秒后自动消失。
      react.useEffect(function () {
        if (notice === "") return undefined;
        var timer = setTimeout(function () {
          setNotice("");
        }, 3500);
        return function () {
          clearTimeout(timer);
        };
      }, [notice]);

      // 打开设置页时从 Host 拉一次最新配置，避免 AI 刚改过而页面还是旧的。
      react.useEffect(function () {
        syncConfigFromHost();
      }, []);

      /** 项目选择器的选项：已注册工作区 + 当前工作区（若尚未注册，当前工作区排在最前）。 */
      function projectOptions() {
        var list = workspaces.slice();
        if (currentProjectPath !== undefined && currentProjectPath !== "") {
          var exists = false;
          for (var i = 0; i < list.length; i += 1) {
            if (normalizePath(list[i].path) === normalizePath(currentProjectPath)) {
              exists = true;
              if (i > 0) {
                var moved = list.splice(i, 1)[0];
                list.unshift(moved);
              }
              break;
            }
          }
          if (!exists) list.unshift({ path: currentProjectPath, title: "当前工作区" });
        }
        return list;
      }

      function workspaceFor(path) {
        var list = projectOptions();
        for (var i = 0; i < list.length; i += 1) {
          if (normalizePath(list[i].path) === normalizePath(path)) return list[i];
        }
        return undefined;
      }

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
        setProjectCustom(false);
        setError("");
      }

      function startEdit(command) {
        setEditing(Object.assign({}, command, { terminalTitle: command.terminalTitle || "" }));
        setProjectCustom(command.scope === "project" && workspaceFor(command.projectRoot) === undefined);
        setError("");
      }

      function updateDraft(field, value) {
        if (editing === null) return;
        var next = Object.assign({}, editing);
        next[field] = value;
        if (field === "command" && /[^\x00-\x7f]/.test(String(value))) next.utf8CodePage = true;
        setEditing(next);
      }

      function chooseScope(scope) {
        if (editing === null) return;
        if (scope === "project") {
          var fallback = currentProjectPath !== undefined && currentProjectPath !== "" ? currentProjectPath : "";
          var known = fallback !== "" && workspaceFor(fallback) !== undefined;
          setEditing(Object.assign({}, editing, {
            scope: "project",
            projectRoot: editing.projectRoot !== "" ? editing.projectRoot : fallback,
            cwd: editing.cwd !== "" ? editing.cwd : fallback
          }));
          setProjectCustom(editing.projectRoot === "" && !known);
        } else {
          setEditing(Object.assign({}, editing, { scope: "global" }));
          setProjectCustom(false);
        }
      }

      function chooseProject(value) {
        if (editing === null) return;
        if (value === "__custom__") {
          setProjectCustom(true);
          setEditing(Object.assign({}, editing, { projectRoot: "" }));
          return;
        }
        setProjectCustom(false);
        setEditing(Object.assign({}, editing, {
          projectRoot: value,
          cwd: editing.cwd !== "" ? editing.cwd : value
        }));
      }

      function useProjectAsCwd() {
        if (editing === null || editing.projectRoot === "") return;
        setEditing(Object.assign({}, editing, { cwd: editing.projectRoot }));
      }

      function saveDraft() {
        if (editing === null) return;
        var normalized = normalizeCommand(editing);
        if (normalized === null) {
          setError("请填写名称、工作目录、命令；作用域为「指定项目」时还要选择或填写项目。");
          return;
        }
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
        flash("已保存：" + normalized.title);
      }

      function removeCommand(id) {
        saveConfig(Object.assign({}, config, {
          commands: config.commands.filter(function (command) {
            return command.id !== id;
          })
        }));
        if (editing !== null && editing.id === id) setEditing(null);
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
        saveConfig(Object.assign({}, config, {
          commands: config.commands.map(function (item) {
            if (item.id !== command.id) return item;
            return Object.assign({}, item, { enabled: !item.enabled });
          })
        }));
      }

      function toggleVisible() {
        saveConfig(Object.assign({}, config, {
          ui: Object.assign({}, config.ui, { visible: !config.ui.visible })
        }));
        flash(config.ui.visible ? "已隐藏输入框下方的运行按钮" : "已显示输入框下方的运行按钮");
      }

      function resetDefaults() {
        if (!resetArmed) {
          setResetArmed(true);
          flash("再点一次「确认恢复」：会清空自定义命令（运行按钮开关保留）。");
          return;
        }
        var defaults = defaultConfig();
        defaults.ui = config.ui;
        saveConfig(defaults);
        setEditing(null);
        setResetArmed(false);
        flash("已恢复内置的 4 条命令");
      }

      function exportConfig() {
        var copied = copyTextToClipboard(JSON.stringify(config, null, 2));
        flash(copied ? "配置 JSON 已复制到剪贴板" : "复制失败，请重试");
      }

      function applyImport() {
        try {
          var normalized = normalizeConfig(JSON.parse(importText));
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

      var projectCount = config.commands.filter(function (command) {
        return command.scope === "project";
      }).length;
      var currentWorkspace = currentProjectPath !== undefined && currentProjectPath !== ""
        ? workspaceFor(currentProjectPath)
        : undefined;
      var statText = config.commands.length + " 条命令"
        + (projectCount > 0 ? " · " + projectCount + " 条项目级" : "")
        + (currentWorkspace !== undefined ? " · 当前 " + currentWorkspace.title : "");

      var options = projectOptions();
      var selectedProject = editing !== null && editing.projectRoot !== "" ? workspaceFor(editing.projectRoot) : undefined;
      var projectSelectValue = projectCustom
        ? "__custom__"
        : (selectedProject !== undefined ? selectedProject.path : (editing !== null && editing.projectRoot !== "" ? "__custom__" : (options.length > 0 ? options[0].path : "__custom__")));

      var form = editing === null ? null : h("div", { className: "dshLimobCfgForm" },
        h("div", { className: "dshLimobCfgFormTop" },
          h("span", { className: "dshLimobCfgFormTitle" }, editing.id === "" ? "新增命令" : "编辑命令"),
          h("button", {
            type: "button",
            className: "dshLimobIconBtn",
            title: "关闭",
            "aria-label": "关闭",
            onClick: function () { setEditing(null); setError(""); }
          }, limobIcon("close"))),
        h("div", { className: "dshLimobFormGrid" },
          h("label", { className: "dshLimobFormField" },
            h("span", null, "名称 *"),
            h("input", {
              className: "dshLimobInput",
              value: editing.title,
              placeholder: "例如：开发调试",
              onChange: function (event) { updateDraft("title", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField" },
            h("span", null, "终端标题（可选）"),
            h("input", {
              className: "dshLimobInput",
              value: editing.terminalTitle,
              placeholder: "默认 Limob-<id>",
              onChange: function (event) { updateDraft("terminalTitle", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "工作目录 *"),
            h("div", { className: "dshLimobFormRow" },
              h("input", {
                className: "dshLimobInput",
                style: { flex: "1 1 220px" },
                value: editing.cwd,
                placeholder: "H:\\Limob-windows",
                onChange: function (event) { updateDraft("cwd", event.target.value); }
              }),
              editing.scope === "project" && editing.projectRoot !== ""
                ? h("button", { type: "button", className: "dshLimobLinkBtn", onClick: useProjectAsCwd }, "使用项目目录")
                : null)),
          h("label", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "命令（PowerShell，固定文本）*"),
            h("textarea", {
              className: "dshLimobTextarea",
              value: editing.command,
              placeholder: "pnpm 客户端-调试",
              onChange: function (event) { updateDraft("command", event.target.value); }
            })),
          h("div", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "作用域"),
            h("div", { className: "dshLimobFormRow" },
              h("div", { className: "dshLimobSegment" },
                h("button", {
                  type: "button",
                  "data-active": editing.scope === "global" ? "true" : "false",
                  onClick: function () { chooseScope("global"); }
                }, "所有项目"),
                h("button", {
                  type: "button",
                  "data-active": editing.scope === "project" ? "true" : "false",
                  onClick: function () { chooseScope("project"); }
                }, "指定项目")),
              editing.scope === "project"
                ? h("select", {
                    className: "dshLimobSelect",
                    value: projectSelectValue,
                    onChange: function (event) { chooseProject(event.target.value); }
                  },
                    options.map(function (option) {
                      return h("option", { key: option.path, value: option.path }, option.title + " · " + option.path);
                    }),
                    h("option", { value: "__custom__" }, "自定义路径…"))
                : h("span", { className: "dshLimobPageSub" }, "所有项目都会显示这条命令")),
            editing.scope === "project" && projectCustom
              ? h("input", {
                  className: "dshLimobInput",
                  style: { marginTop: "5px" },
                  value: editing.projectRoot,
                  placeholder: "项目根目录，例如 H:\\Limob-windows",
                  onChange: function (event) { updateDraft("projectRoot", event.target.value); }
                })
              : null,
            editing.scope === "project"
              ? h("span", { className: "dshLimobFieldHint" }, "只在该工作区的会话里出现；下拉列表来自 DSH 已注册的工作区。")
              : null),
          h("div", { className: "dshLimobFormRow", "data-wide": "true" },
            h("label", { className: "dshLimobSwitch" },
              h("input", {
                type: "checkbox",
                checked: editing.utf8CodePage,
                onChange: function (event) { updateDraft("utf8CodePage", event.target.checked); }
              }),
              h("span", { className: "dshLimobSwitchTrack" }),
              h("span", null, "中文命令先执行 chcp 65001")),
            h("label", { className: "dshLimobSwitch" },
              h("input", {
                type: "checkbox",
                checked: editing.enabled,
                onChange: function (event) { updateDraft("enabled", event.target.checked); }
              }),
              h("span", { className: "dshLimobSwitchTrack" }),
              h("span", null, "启用")))),
        h("div", { className: "dshLimobFormFoot" },
          error !== "" ? h("span", { className: "dshLimobFormError" }, error) : null,
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn",
            onClick: function () { setEditing(null); setError(""); }
          }, "取消"),
          h("button", { type: "button", className: "dshLimobCfgBtn dshLimobCfgBtnPrimary", onClick: saveDraft }, "保存")));

      var list = config.commands.length === 0
        ? h("div", { className: "dshLimobCmdList" }, h("div", { className: "dshLimobCfgEmpty" }, "还没有命令，点右上角「+ 新增」添加一条。"))
        : h("div", { className: "dshLimobCmdList" },
            config.commands.map(function (command, index) {
              var projectLabel = command.scope === "project"
                ? "项目 · " + projectTitleOf(command.projectRoot, options)
                : "全局";
              var actions = pendingDelete === command.id
                ? [
                    h("button", {
                      key: "confirm",
                      type: "button",
                      className: "dshLimobCfgBtn dshLimobCfgBtnDanger",
                      onClick: function () { removeCommand(command.id); }
                    }, "确认删除"),
                    h("button", {
                      key: "cancel",
                      type: "button",
                      className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
                      onClick: function () { setPendingDelete(null); }
                    }, "取消")
                  ]
                : [
                    h("label", { key: "enabled", className: "dshLimobSwitch", title: command.enabled ? "停用" : "启用" },
                      h("input", {
                        type: "checkbox",
                        checked: command.enabled,
                        onChange: function () { toggleEnabled(command); }
                      }),
                      h("span", { className: "dshLimobSwitchTrack" })),
                    h("button", {
                      key: "up",
                      type: "button",
                      className: "dshLimobIconBtn",
                      title: "上移",
                      "aria-label": "上移",
                      disabled: index === 0,
                      onClick: function () { moveCommand(index, -1); }
                    }, limobIcon("up")),
                    h("button", {
                      key: "down",
                      type: "button",
                      className: "dshLimobIconBtn",
                      title: "下移",
                      "aria-label": "下移",
                      disabled: index === config.commands.length - 1,
                      onClick: function () { moveCommand(index, 1); }
                    }, limobIcon("down")),
                    h("button", {
                      key: "edit",
                      type: "button",
                      className: "dshLimobIconBtn",
                      title: "编辑",
                      "aria-label": "编辑",
                      onClick: function () { startEdit(command); }
                    }, limobIcon("edit")),
                    h("button", {
                      key: "delete",
                      type: "button",
                      className: "dshLimobIconBtn",
                      "data-danger": "true",
                      title: "删除",
                      "aria-label": "删除",
                      onClick: function () { setPendingDelete(command.id); }
                    }, limobIcon("trash"))
                  ];
              return h("div", {
                key: command.id,
                className: "dshLimobCmdRow",
                "data-disabled": command.enabled ? "false" : "true"
              },
                h("div", {
                  className: "dshLimobCmdMain",
                  onClick: function () { startEdit(command); }
                },
                  h("div", { className: "dshLimobCmdTitleLine" },
                    h("span", { className: "dshLimobCmdTitle" }, command.title),
                    h("span", {
                      className: "dshLimobTag",
                      "data-scope": command.scope,
                      title: command.scope === "project" ? command.projectRoot : "所有项目"
                    }, projectLabel),
                    command.enabled ? null : h("span", { className: "dshLimobTag" }, "已停用")),
                  h("div", { className: "dshLimobCmdPreview" }, command.command)),
                h("div", { className: "dshLimobCmdActions" }, actions));
            }));

      return h("div", { className: "dshLimobCfg" },
        h("div", { className: "dshLimobCfgToolbar" },
          h("span", { className: "dshLimobCfgStat", title: statText }, statText),
          h("label", { className: "dshLimobSwitch", title: "在输入框下方显示「运行」按钮" },
            h("input", { type: "checkbox", checked: config.ui.visible, onChange: toggleVisible }),
            h("span", { className: "dshLimobSwitchTrack" }),
            h("span", null, "运行按钮")),
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnPrimary",
            onClick: startCreate
          }, limobIcon("plus"), h("span", null, "新增"))),

        form,
        list,

        h("div", { className: "dshLimobCfgFooter" },
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
            title: "从宿主 commands.json 重新读取（AI 刚改过配置时用）",
            onClick: function () {
              syncConfigFromHost().then(function (ok) {
                flash(ok ? "已从宿主同步最新配置" : "宿主配置暂不可用，已保留本地配置");
              });
            }
          }, "同步宿主"),
          h("button", { type: "button", className: "dshLimobCfgBtn dshLimobCfgBtnGhost", onClick: exportConfig }, "导出配置"),
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
            onClick: function () { setImportOpen(!importOpen); setError(""); }
          }, importOpen ? "收起导入" : "导入配置"),
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
            style: resetArmed ? { color: "#f87171" } : undefined,
            onClick: resetDefaults
          }, resetArmed ? "确认恢复" : "恢复内置"),
          h("span", { className: "dshLimobCfgFooterVersion" }, "v" + PLUGIN_VERSION)),

        importOpen
          ? h("div", { className: "dshLimobImportBox" },
              h("textarea", {
                className: "dshLimobTextarea",
                value: importText,
                placeholder: "粘贴导出的配置 JSON",
                onChange: function (event) { setImportText(event.target.value); }
              }),
              h("div", { className: "dshLimobFormFoot" },
                h("button", {
                  type: "button",
                  className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
                  onClick: function () { setImportOpen(false); setImportText(""); }
                }, "取消"),
                h("button", { type: "button", className: "dshLimobCfgBtn dshLimobCfgBtnPrimary", onClick: applyImport }, "导入")))
          : null,

        editing === null
          ? h("div", { className: "dshLimobCfgTips" },
              h("div", { className: "dshLimobCfgTipsTitle" }, "小提示"),
              h("div", null, "全局命令在所有项目可见；项目命令只出现在绑定工作区的会话里。"),
              h("div", null, "命令在 DSH 右侧栏终端运行，重复点击会复用同一个终端。"),
              h("div", null, "修改立即生效；关闭「运行按钮」只是隐藏输入框下方的入口。"))
          : null,

        error !== "" ? h("div", { className: "dshLimobCfgError" }, error) : null,
        notice !== "" ? h("div", { className: "dshLimobCfgNotice" }, notice) : null
      );
    }

    // =====================================================================
    // 十、设置页 section（Settings 弹窗左侧新增一个 Tab）
    // =====================================================================
    function LimobSettingsSection(props) {
      var active = useActiveSession(props);
      var workspaces = workspaceOptionsFrom(props !== undefined ? props.useWorkspaces : undefined);
      return h("div", { className: "dshLimobCfgPage" },
        h("div", { className: "dshLimobPageHead" },
          h("div", null,
            h("div", { className: "dshLimobPageTitle" }, "dsh-runner"),
            h("div", { className: "dshLimobPageSub" }, "输入框下方「运行」按钮的命令配置")),
          h("span", { className: "dshLimobPageVersion" }, "v" + PLUGIN_VERSION)),
        h(LimobConfigEditor, {
          currentProjectPath: active.projectPath,
          workspaces: workspaces
        }));
    }
    // =====================================================================
    // 十一、输入框下方的「运行」按钮（conversation.composer.dock）
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
      var workspaces = workspaceOptionsFrom(props !== undefined ? props.useWorkspaces : undefined);
      var updatePair = useUpdateStatus();
      var updateStatus = updatePair[0];
      var setUpdateStatus = updatePair[1];

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
      var terminalCountPair = react.useState(0);
      var terminalCount = terminalCountPair[0];
      var setTerminalCount = terminalCountPair[1];
      var configOpenPair = react.useState(false);
      var configOpen = configOpenPair[0];
      var setConfigOpen = configOpenPair[1];

      var commands = visibleCommands(config, projectPath, sessionId !== undefined).filter(function (command) {
        return command.scope === "project";
      });

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
          setTerminalCount(0);
          return;
        }
        var remote = getTerminalRemote(runtimeCtx);
        if (remote === undefined || remote === null) return;
        try {
          var list = await listTerminals(remote, sessionId);
          var registry = loadRegistry();
          var saved = registry.sessions[sessionId] || {};
          var next = {};
          var liveCount = 0;
          Object.keys(saved).forEach(function (commandId) {
            var entry = saved[commandId];
            if (entry === undefined || entry === null) return;
            var live = list.find(function (info) {
              return info !== null && info !== undefined && info.id === entry.terminalId;
            });
            if (live === undefined) return;
            liveCount += 1;
            if (live.state === "running") next[commandId] = true;
          });
          setRunning(next);
          setTerminalCount(liveCount);
        } catch (_error) {
          /* ignore */
        }
      }

      function toggleMenu() {
        if (!menuOpen) {
          // AI 可能刚通过 dsh_runner_config 改过配置；每次打开菜单先同步一次。
          syncConfigFromHost();
          // 更新检查也用 10 分钟缓存，频繁打开菜单不会刷爆 GitHub API。
          checkForUpdateShared(false).then(function (result) {
            if (result !== undefined && result !== null) setUpdateStatus(result);
          });
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
        if (busy !== null || sessionId === undefined || terminalCount === 0) return;
        setMenuOpen(false);
        setBusy("__stop__");
        setStatus({ phase: "starting", text: "正在关闭本会话终端…" });
        stopAllTerminals(runtimeCtx, sessionId).then(
          function (count) {
            setStatus({
              phase: "idle",
              text: count > 0 ? ("已关闭 " + count + " 个终端（运行中的命令已结束）") : "当前没有可关闭的终端"
            });
            setRunning({});
            setTerminalCount(0);
          },
          function (error) {
            setStatus({ phase: "error", text: "关闭终端失败：" + messageOf(error) });
            refreshRunning();
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

      // 菜单底部的小更新标志：只占很小一行，不单独占一个菜单项。
      var updateDotState = "latest";
      var updateLabel = "v" + PLUGIN_VERSION;
      if (updateStatus !== null && updateStatus !== undefined) {
        if (updateStatus.phase === "checking") {
          updateDotState = "checking";
          updateLabel = "检查中…";
        } else if (updateStatus.available) {
          updateDotState = "update";
          updateLabel = "v" + updateStatus.latestVersion;
        } else if (updateStatus.phase === "error") {
          updateDotState = "error";
          updateLabel = "检查更新";
        }
      }

      var menu = menuOpen
        ? h("div", { className: "dshLimobRunMenu", style: menuStyle, role: "menu" },
            h("div", { className: "dshLimobRunMenuTitle" },
              h("span", null, "运行命令"),
              h("span", null, projectPath !== undefined ? String(projectPath) : "当前会话")),
            commands.length === 0
              ? h("div", { className: "dshLimobRunMenuTitle" }, "当前项目没有项目级命令；全局命令请在左侧「运行」页打开。")
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
              "data-danger": "true",
              disabled: busy !== null || sessionId === undefined || terminalCount === 0,
              title: terminalCount > 0 ? "关闭由「运行」打开的终端" : "当前没有可关闭的终端",
              onClick: handleStopAll
            },
              h("span", { className: "dshLimobRunItemMain" },
                h("span", { className: "dshLimobRunItemTitle" }, "关闭本会话的运行终端"),
                h("span", { className: "dshLimobRunItemCmd" },
                  sessionId === undefined
                    ? "请先进入会话"
                    : terminalCount > 0
                      ? "关闭由「运行」打开的 " + terminalCount + " 个终端；正在运行的命令会一并结束"
                      : "当前没有由「运行」打开的终端"))),
            h("button", {
              type: "button",
              className: "dshLimobRunItem",
              onClick: function () { setMenuOpen(false); setConfigOpen(true); }
            },
              h("span", { className: "dshLimobRunItemMain" },
                h("span", { className: "dshLimobRunItemTitle" }, "管理命令…"),
                h("span", { className: "dshLimobRunItemCmd" }, "新增/编辑/删除/排序，设置全局或项目作用域"))),
            h("div", { className: "dshLimobRunFoot" },
              h("button", {
                type: "button",
                className: "dshLimobRunFootBtn",
                disabled: updateStatus !== null && updateStatus.phase === "checking",
                title: updateDotState === "update"
                  ? ("发现新版本 v" + updateStatus.latestVersion + "，点击查看")
                  : "检查 GitHub 更新（每 10 分钟最多请求一次）",
                onClick: function () {
                  if (updateStatus !== null && updateStatus !== undefined && updateStatus.available) handleUpdateClick();
                  else handleCheckUpdate();
                }
              },
                h("span", { className: "dshLimobRunFootDot", "data-state": updateDotState }),
                h("span", null, updateLabel)),
              h("a", {
                className: "dshLimobRunFootGitHub",
                href: GITHUB_REPO_PAGE,
                target: "_blank",
                rel: "noopener noreferrer",
                title: "打开 GitHub 仓库",
                onClick: function () { setMenuOpen(false); }
              },
                h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
                  h("path", {
                    d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z",
                    fill: "currentColor"
                  })),
                h("span", null, "GitHub"))))
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
                h("span", null, "dsh-runner · 命令配置"),
                h("button", {
                  type: "button",
                  className: "dshLimobCfgBtn",
                  onClick: function () { setConfigOpen(false); }
                }, "关闭")),
              h(LimobConfigEditor, { currentProjectPath: projectPath, workspaces: workspaces })))
        : null;

      return h("div", { ref: rootRef, className: "dshLimobRunDock" },
        h("button", {
          ref: buttonRef,
          type: "button",
          className: "dshLimobRunBtn",
          "data-busy": busy !== null ? "true" : "false",
          title: "在 DSH 自带终端里运行命令（点击选择命令）",
          "aria-label": "运行命令",
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
    // =====================================================================
    // 十二、左侧导航「运行」页 + 全局命令后台运行 + 右侧日志终端
    // =====================================================================
    // 全局命令不再依赖会话终端：Host 侧启动独立进程并写日志；
    // 每个会话右侧栏打开一个「跟随日志」的原生终端，切换项目仍能看到同一份输出。
    var globalTailOpening = {};
    var lastActiveProjectPath = undefined;

    function loadGlobalTabs() {
      try {
        if (typeof localStorage === "undefined") return { sessions: {} };
        var raw = localStorage.getItem(GLOBAL_TABS_KEY);
        if (raw === null) return { sessions: {} };
        var parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && parsed.sessions !== null && typeof parsed.sessions === "object") return parsed;
      } catch (_error) {
        /* ignore */
      }
      return { sessions: {} };
    }

    function saveGlobalTabs(registry) {
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(GLOBAL_TABS_KEY, JSON.stringify(registry));
      } catch (_error) {
        /* ignore */
      }
    }

    function globalTabKey(sessionId, commandId) {
      return sessionId + "::" + commandId;
    }

    function globalTerminalTitle(runner) {
      return "全局 · " + runner.title;
    }

    function buildGlobalTailCommand(runner) {
      var logPath = String(runner.logPath || "").replace(/'/g, "''");
      return "chcp 65001 | Out-Null; Get-Content -LiteralPath '" + logPath + "' -Encoding UTF8 -Tail 600 -Wait";
    }

    /**
     * 在当前会话打开（或聚焦）某个全局命令的日志终端。
     * 终端只是 Get-Content -Wait 的“跟随日志”视图；真正的进程在 Host 侧。
     */
    async function ensureGlobalTail(ctx, sessionId, runner, openIt) {
      if (ctx === null || sessionId === undefined || runner === null || runner === undefined) return;
      if (typeof runner.logPath !== "string" || runner.logPath === "") return;
      var key = globalTabKey(sessionId, runner.commandId);
      if (globalTailOpening[key] === true) return;
      globalTailOpening[key] = true;
      try {
        var remote = getTerminalRemote(ctx);
        if (remote === undefined || remote === null) return;
        var registry = loadGlobalTabs();
        if (registry.sessions[sessionId] === undefined || registry.sessions[sessionId] === null) registry.sessions[sessionId] = {};
        var entry = registry.sessions[sessionId][runner.commandId];
        if (entry !== undefined && entry !== null && typeof entry.terminalId === "string") {
          var list = await listTerminals(remote, sessionId);
          var live = list.find(function (info) {
            return info !== null && info !== undefined && info.id === entry.terminalId;
          });
          if (live !== undefined) {
            if (openIt) await openOrFocusTab(ctx, sessionId, entry.terminalId);
            return;
          }
        }
        var shellPath = await pickShellPath(remote, sessionId);
        var baseId = ("dsh-runner-global-" + String(runner.commandId || "")).replace(/[^\w-]/g, "-").slice(0, 110);
        var created = await createTerminal(remote, sessionId, baseId, shellPath);
        var title = globalTerminalTitle(runner);
        await safeRename(remote, sessionId, created.id, title);
        await sendCommands(remote, sessionId, created.id, [buildGlobalTailCommand(runner)]);
        registry.sessions[sessionId][runner.commandId] = {
          terminalId: created.id,
          title: title,
          logPath: runner.logPath,
          savedAt: Date.now()
        };
        saveGlobalTabs(registry);
        if (openIt) await openOrFocusTab(ctx, sessionId, created.id);
      } catch (_error) {
        /* 终端打不开不影响 Host 进程；页面可以提示日志不可用 */
      } finally {
        delete globalTailOpening[key];
      }
    }

    /** 关闭某个全局命令在所有会话里的日志终端（命令停止时调用）。 */
    async function closeGlobalTails(ctx, commandId) {
      var registry = loadGlobalTabs();
      var sessionIds = Object.keys(registry.sessions || {});
      for (var i = 0; i < sessionIds.length; i += 1) {
        var sessionId = sessionIds[i];
        var entry = registry.sessions[sessionId] !== null && registry.sessions[sessionId] !== undefined
          ? registry.sessions[sessionId][commandId]
          : undefined;
        if (entry === undefined || entry === null || typeof entry.terminalId !== "string") continue;
        await closeTerminal(ctx, sessionId, entry.terminalId);
        delete registry.sessions[sessionId][commandId];
        if (Object.keys(registry.sessions[sessionId]).length === 0) delete registry.sessions[sessionId];
      }
      saveGlobalTabs(registry);
    }

    /** 左侧导航图标：一个简单的播放三角。 */
    function GlobalRunPanelIcon(props) {
      var size = props !== undefined && typeof props.size === "number" ? props.size : 18;
      return h("span", { className: "dshLimobNavIcon" },
        h("svg", { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
          h("path", { d: "M5 3.2l8 4.8-8 4.8V3.2z", fill: "currentColor" })));
    }

    /** 切会话时在后台补开全局命令的日志终端。 */
    function GlobalTailKeeper(props) {
      var active = useActiveSession(props);
      react.useEffect(function () {
        if (active.sessionId === undefined) return undefined;
        if (active.projectPath !== undefined && active.projectPath !== "") lastActiveProjectPath = active.projectPath;
        var cancelled = false;
        async function syncTails() {
          var value = await hostRpc("global/status", {});
          if (cancelled || value === undefined) return;
          var runners = Array.isArray(value.runners) ? value.runners : [];
          for (var i = 0; i < runners.length; i += 1) {
            if (cancelled) return;
            if (runners[i].status !== "running") continue;
            await ensureGlobalTail(runtimeCtx, active.sessionId, runners[i], true);
          }
        }
        function onChanged() {
          syncTails();
        }
        var timer = setTimeout(syncTails, 500);
        window.addEventListener("dsh-runner:global-changed", onChanged);
        return function () {
          cancelled = true;
          clearTimeout(timer);
          window.removeEventListener("dsh-runner:global-changed", onChanged);
        };
      }, [active.sessionId]);
      return null;
    }

    /** 左侧导航「运行」主面板：全局命令列表 + 运行/停止/日志。 */
    function GlobalRunnerPage(props) {
      var config = useConfig();
      var active = useActiveSession(props);
      var runnersPair = react.useState([]);
      var runners = runnersPair[0];
      var setRunners = runnersPair[1];
      var busyPair = react.useState(null);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var noticePair = react.useState("");
      var notice = noticePair[0];
      var setNotice = noticePair[1];
      var errorPair = react.useState("");
      var error = errorPair[0];
      var setError = errorPair[1];

      var globalCommands = config.commands.filter(function (command) {
        return command.scope === "global";
      });

      async function refresh() {
        // AI 可能刚通过 dsh_runner_config 创建/修改了全局命令，刷新状态时顺带同步配置。
        await syncConfigFromHost();
        var value = await hostRpc("global/status", {});
        if (value !== undefined) setRunners(Array.isArray(value.runners) ? value.runners : []);
      }

      react.useEffect(function () {
        refresh();
        var timer = setInterval(refresh, 2500);
        return function () {
          clearInterval(timer);
        };
      }, []);

      function runnerOf(commandId) {
        for (var i = 0; i < runners.length; i += 1) {
          if (runners[i].commandId === commandId) return runners[i];
        }
        return undefined;
      }

      async function start(command) {
        if (busy !== null) return;
        setBusy(command.id);
        setError("");
        var value = await hostRpc("global/start", {
          commandId: command.id,
          workspacePath: active.projectPath !== undefined ? active.projectPath : lastActiveProjectPath
        });
        if (value === undefined || value.runner === undefined) {
          setError("启动失败：Host 运行器不可用");
        } else {
          setNotice("已启动「" + command.title + "」，日志终端已准备");
          await refresh();
          if (active.sessionId !== undefined) await ensureGlobalTail(runtimeCtx, active.sessionId, value.runner, true);
          window.dispatchEvent(new Event("dsh-runner:global-changed"));
        }
        setBusy(null);
      }

      async function stop(command) {
        if (busy !== null) return;
        setBusy(command.id);
        setError("");
        var value = await hostRpc("global/stop", { commandId: command.id });
        if (value === undefined) {
          setError("停止失败：Host 运行器不可用");
        } else {
          setNotice("已停止「" + command.title + "」");
          await closeGlobalTails(runtimeCtx, command.id);
          await refresh();
          window.dispatchEvent(new Event("dsh-runner:global-changed"));
        }
        setBusy(null);
      }

      async function openLog(command) {
        var runner = runnerOf(command.id);
        if (runner === undefined) {
          setError("还没有运行记录；请先点「运行」");
          return;
        }
        if (active.sessionId === undefined) {
          setError("请先进入一个会话，右侧栏才能显示日志终端");
          return;
        }
        await ensureGlobalTail(runtimeCtx, active.sessionId, runner, true);
        setError("");
      }

      function stateText(runner) {
        if (runner === undefined) return "未运行";
        if (runner.status === "running") return "运行中";
        if (runner.status === "failed") return "启动失败";
        if (runner.status === "stopped") return "已停止";
        return "已退出";
      }

      return h("div", { className: "dshLimobGlobalPage" },
        h("div", { className: "dshLimobGlobalHead" },
          h("div", null,
            h("div", { className: "dshLimobGlobalTitle" }, "运行"),
            h("div", { className: "dshLimobGlobalSub" }, "全局命令：任何项目都能用；运行日志会跟随到当前项目右侧栏")),
          h("span", { className: "dshLimobGlobalVersion" }, "v" + PLUGIN_VERSION)),
        h("div", { className: "dshLimobGlobalToolbar" },
          h("span", { className: "dshLimobGlobalStat" }, globalCommands.length + " 条全局命令"), 
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnGhost",
            onClick: refresh
          }, "刷新状态")),
        globalCommands.length === 0
          ? h("div", { className: "dshLimobGlobalEmpty" }, "还没有全局命令。可以直接对 AI 说「给所有项目加一个全局命令：打开记事本」，或去 设置 → dsh-runner 新增一条并把作用域选「所有项目」。")
          : h("div", { className: "dshLimobGlobalList" },
              globalCommands.map(function (command) {
                var runner = runnerOf(command.id);
                var status = runner !== undefined ? runner.status : "idle";
                return h("div", { key: command.id, className: "dshLimobGlobalRow", "data-status": status },
                  h("div", { className: "dshLimobGlobalMain" },
                    h("div", { className: "dshLimobGlobalNameLine" },
                      h("span", { className: "dshLimobGlobalName" }, command.title),
                      h("span", { className: "dshLimobRunTag" }, "全局")),
                    h("div", { className: "dshLimobGlobalCmd" }, command.command)),
                  h("span", { className: "dshLimobGlobalStatus" },
                    h("span", { className: "dshLimobGlobalDot", "data-status": status }),
                    stateText(runner)),
                  h("div", { className: "dshLimobGlobalActions" },
                    runner !== undefined && runner.status === "running"
                      ? h("button", {
                          type: "button",
                          className: "dshLimobCfgBtn dshLimobCfgBtnDanger",
                          disabled: busy !== null,
                          onClick: function () { stop(command); }
                        }, "停止")
                      : h("button", {
                          type: "button",
                          className: "dshLimobCfgBtn dshLimobCfgBtnPrimary",
                          disabled: busy !== null || command.enabled === false,
                          onClick: function () { start(command); }
                        }, "运行"),
                    h("button", {
                      type: "button",
                      className: "dshLimobCfgBtn",
                      disabled: runner === undefined,
                      onClick: function () { openLog(command); }
                    }, "日志")));
              })),
        h("div", { className: "dshLimobGlobalTips" },
          "全局命令由 Host 侧独立进程执行，不绑定会话；右侧栏里的终端是它的只读日志（Get-Content -Wait），所以切换项目后仍然能看到。项目级命令仍在输入框下方的「运行」按钮里。"),
        error !== "" ? h("div", { className: "dshLimobGlobalError" }, error) : null,
        notice !== "" ? h("div", { className: "dshLimobGlobalNotice" }, notice) : null);
    }

    /** 注册左侧导航「运行」入口、主面板和会话切换时的日志终端补开器。 */
    function registerGlobalRunnerUi(ctx) {
      try {
        ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register({ name: "sidebar.panellist", id: "dsh-runner-global", order: 20, label: "运行" }, GlobalRunPanelIcon);
        });
      } catch (error) {
        logPluginError(ctx, "注册左侧导航失败", error);
      }
      try {
        ctx.slots.inject("main", function () {
          return ctx.slots.register({ name: "main", key: "dsh-runner-global" }, GlobalRunnerPage);
        });
      } catch (error) {
        logPluginError(ctx, "注册运行主面板失败", error);
      }
      registerSlot(ctx, "shell.overlay", "dsh-runner-global-keeper", GlobalTailKeeper, 210);
    }
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
      // 连接 Host 的 RPC（配置由 commands.json 统一保存，AI Tool 与设置页共用）。
      try {
        hostConnection = typeof ctx.get === "function" ? ctx.get("connection") : undefined;
      } catch (_error) {
        hostConnection = undefined;
      }
      syncConfigFromHost();
      // 输入框卡片正下方的小按钮（conversation.composer.dock）。
      registerSlot(ctx, "conversation.composer.dock", "dsh-runner-run", LimobComposerButton, 40);
      // 左侧导航「运行」：全局命令入口 + 主面板 + 切会话补开日志终端。
      registerGlobalRunnerUi(ctx);
      // 设置弹窗左侧新增「dsh-runner」页（settings.section 的每个条目就是一页）。
      registerSlot(ctx, "settings.section", "dsh-runner", LimobSettingsSection, 60, "dsh-runner");
      // DSH 插件页的更新提示（沿用 0.2 的能力）。
      registerSlot(ctx, "plugins.detail.badge", "dsh-runner-update", LimobUpdateBadge, 100);
      registerSlot(ctx, "plugins.detail.section", "dsh-runner-update", LimobUpdateSection, 100);
    }

    exports.name = "dsh-runner";
    exports.inject = ["slots", "connection"];
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
