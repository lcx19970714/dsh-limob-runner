/* dsh-runner —— 客户端半体（浏览器侧，0.12.0）
 *
 * 功能总览：
 *   1) 左侧导航新增「运行」面板（sidebar.panellist + main 槽位）：
 *      当前项目的运行命令列表（启停重启、状态/端口/uptime/退出码）+ 实时日志 +
 *      端口诊断（未托管占用者可一键结束）；
 *   2) 输入框下方保留紧凑「▶ 运行」按钮（conversation.composer.dock）：
 *      按项目过滤的快捷菜单，只做启动/停止/重启，不再创建任何终端；
 *   3) 命令配置页（settings.section）：命令编辑器，直接调用 Host 的
 *      config/create|update|delete|reorder RPC；
 *   4) 插件详情页更新提示（plugins.detail.badge / plugins.detail.section）。
 *
 * 数据流（单一事实来源 = Host）：
 *   配置：config/*            —— 只从 Host RPC 读，内存 store + 订阅，无 localStorage
 *   进程：project/status|start|stop|restart|startAll|stopAll
 *   日志：project/log|log/clear（轮询 tail，客户端只展示）
 *   诊断：project/diagnose|killPort
 *
 * 所有 RPC 失败一律 throw（err.code / err.details 透传），界面显示 messageOf(error)。
 * 不依赖右侧栏 / 内置终端 / 终端 RPC；不再有终端创建、tail、项目页签注册表。
 */
window.__ModuleLoader__.load({
  id: "dsh-runner",
  factory: (require) => {
    "use strict";

    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 只用基线共享模块 react；react-dom 仅用于把弹出菜单 portal 到 body（有则用，无则内联）。
    var react = require("react");
    var reactDom = null;
    try {
      reactDom = require("react-dom");
    } catch (_error) {
      reactDom = null;
    }
    var h = react.createElement;

    // =====================================================================
    // 一、常量
    // =====================================================================
    var PLUGIN_NAME = "dsh-runner";
    var PLUGIN_VERSION = "0.14.0";

    // 左侧导航面板 / main 面板的稳定 id。
    var PANEL_ID = "dsh-runner";
    var PANEL_LABEL = "运行";

    // 更新检查（GitHub Releases）；只提示不自动升级。
    var REPO_SLUG = "lcx19970714/dsh-runner";
    var INSTALL_SPEC = "github:" + REPO_SLUG;
    var UPGRADE_COMMAND = "dsh plugin --profile desktop add " + INSTALL_SPEC;
    var GITHUB_REPO_PAGE = "https://github.com/" + REPO_SLUG;
    var GITHUB_RELEASES_PAGE = GITHUB_REPO_PAGE + "/releases";
    var GITHUB_API_LATEST = "https://api.github.com/repos/" + REPO_SLUG + "/releases/latest";
    var GITHUB_RAW_PACKAGE = "https://raw.githubusercontent.com/" + REPO_SLUG + "/main/package.json";
    var UPDATE_CACHE_KEY = "dsh.limob-runner.update.v1";
    var UPDATE_TTL_MS = 10 * 60 * 1000;

    // Host RPC：POST /api/dsh-runner/<endpoint>，信封由 client.rpc.call 负责。
    var RPC_CHANNEL = "/api";
    var RPC_NAMESPACE = PLUGIN_NAME;

    // 轮询节奏与日志单次读取上限（与 SPEC 2.2 一致）。
    var STATUS_POLL_MS = 2000;
    var LOG_POLL_MS = 1000;
    var LOG_MAX_BYTES = 65536;

    // apply(ctx) 时保存客户端根 Context；组件里按需取 DSH 服务。
    var runtimeCtx = null;
    // Host RPC 连接（connection 服务）。
    var hostConnection = null;

    // =====================================================================
    // 二、样式（factory 阶段注入一次，模块系统会随插件卸载清理）
    // =====================================================================
    var STYLE_ID = "dsh-limob-runner-css";
    var CSS = [
      // ---- 输入框下方的「运行」按钮与快捷菜单 ----
      ".dshLimobRunDock{position:relative;display:flex;align-items:center;gap:8px;min-width:0;max-width:100%}",
      ".dshLimobRunBtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap;user-select:none}",
      ".dshLimobRunBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:inherit}",
      ".dshLimobRunBtn[data-busy=true]{cursor:progress;opacity:.7}",
      ".dshLimobRunStatus{display:inline-flex;align-items:center;min-width:0;font-size:11px;line-height:16px;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobRunStatus[data-phase=error]{color:#f87171}",
      ".dshLimobRunMenu{position:fixed;z-index:1000;box-sizing:border-box;min-width:280px;max-width:min(400px,92vw);max-height:min(60vh,520px);overflow:auto;padding:6px;border-radius:11px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,#26282c);box-shadow:0 12px 32px rgba(0,0,0,.38);font-family:inherit;font-size:12px;line-height:18px;color:inherit}",
      ".dshLimobRunMenuTitle{padding:5px 9px 3px;font-size:11px;opacity:.6;user-select:none;display:flex;justify-content:space-between;gap:8px;min-width:0}",
      ".dshLimobRunMenuTitle > span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshLimobRunRow{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;min-width:0}",
      ".dshLimobRunRow:hover{background:rgba(103,158,254,.1)}",
      ".dshLimobRunRowMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}",
      ".dshLimobRunItemTitle{font-size:12px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobRunItemCmd{font-size:10px;line-height:14px;opacity:.6;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobRunRowActions{display:flex;align-items:center;gap:2px;flex:none}",
      ".dshLimobRunSep{height:1px;margin:5px 4px;background:var(--dsw-alias-border-l3,rgba(128,128,128,.3))}",
      ".dshLimobRunHint{padding:5px 9px 3px;font-size:10px;line-height:15px;opacity:.55;user-select:none}",
      ".dshLimobRunEmpty{padding:8px 9px;font-size:11px;line-height:16px;opacity:.6}",
      // ---- 通用小按钮 / 标签 ----
      ".dshLimobCfgBtn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 9px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap}",
      ".dshLimobCfgBtn:hover:not([disabled]){background:rgba(103,158,254,.12)}",
      ".dshLimobCfgBtn[disabled]{opacity:.45;cursor:default}",
      ".dshLimobCfgBtnPrimary{border-color:rgba(103,158,254,.55);background:rgba(103,158,254,.16);color:#679efe}",
      ".dshLimobCfgBtnPrimary:hover:not([disabled]){background:rgba(103,158,254,.24)}",
      ".dshLimobCfgBtnDanger{border-color:rgba(239,68,68,.45);color:#f87171}",
      ".dshLimobCfgBtnDanger:hover:not([disabled]){background:rgba(239,68,68,.12)}",
      ".dshLimobCfgBtnGhost{border:0;padding:0 6px;height:22px;opacity:.72}",
      ".dshLimobCfgBtnGhost:hover:not([disabled]){opacity:1;background:rgba(128,128,128,.12)}",
      ".dshLimobIconBtn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer;opacity:.6}",
      ".dshLimobIconBtn:hover:not([disabled]){background:rgba(128,128,128,.16);opacity:1}",
      ".dshLimobIconBtn[disabled]{opacity:.25;cursor:default}",
      ".dshLimobIconBtn[data-danger=true]:hover:not([disabled]){background:rgba(239,68,68,.14);color:#f87171}",
      ".dshLimobTag{flex:none;padding:0 5px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));font-size:9px;line-height:14px;opacity:.8;white-space:nowrap;max-width:46%;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobTag[data-scope=project]{border-color:rgba(103,158,254,.45);color:#679efe;background:rgba(103,158,254,.08)}",
      // ---- 设置页 / 配置编辑器 ----
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
      ".dshLimobCmdList{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05))}",
      ".dshLimobCmdRow{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.22));min-width:0}",
      ".dshLimobCmdRow:last-child{border-bottom:0}",
      ".dshLimobCmdRow:hover{background:rgba(103,158,254,.06)}",
      ".dshLimobCmdRow[data-disabled=true]{opacity:.55}",
      ".dshLimobCmdMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;cursor:pointer}",
      ".dshLimobCmdTitleLine{display:flex;align-items:center;gap:6px;min-width:0}",
      ".dshLimobCmdTitle{font-size:12px;font-weight:500;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobCmdPreview{font-size:10px;line-height:14px;opacity:.5;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshLimobCmdActions{display:flex;align-items:center;gap:2px;flex:none}",
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
      ".dshLimobFormError{color:#f87171;font-size:11px;line-height:16px;margin-right:auto;word-break:break-word}",
      ".dshLimobCfgError{color:#f87171;font-size:11px;line-height:16px;word-break:break-word}",
      ".dshLimobCfgNotice{color:#22c55e;font-size:11px;line-height:16px}",
      ".dshLimobFieldHint{font-size:10px;line-height:14px;opacity:.5;margin-top:2px}",
      ".dshLimobDepList{display:flex;flex-wrap:wrap;gap:4px 12px;padding:2px 0 0}",
      ".dshLimobDepItem{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;opacity:.85;cursor:pointer;max-width:100%}",
      ".dshLimobDepItem span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshLimobCfgModalBackdrop{pointer-events:auto;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:20px}",
      ".dshLimobCfgModal{box-sizing:border-box;width:min(760px,94vw);max-height:min(86vh,820px);overflow:auto;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,#26282c);box-shadow:0 18px 48px rgba(0,0,0,.45);padding:14px}",
      ".dshLimobCfgH{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:600}",
      // ---- 运行面板 ----
      ".dshRunnerPage{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:100%;height:100%;min-height:0;padding:12px 14px;font-size:12px;line-height:18px;color:inherit}",
      ".dshRunnerHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:8px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));min-width:0}",
      ".dshRunnerHeadMain{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1 1 240px}",
      ".dshRunnerTitle{font-size:14px;font-weight:600;line-height:20px;flex:none}",
      ".dshRunnerProject{font-size:11px;line-height:16px;opacity:.6;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
      ".dshRunnerToolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}",
      ".dshRunnerBody{display:grid;grid-template-columns:minmax(300px,42%) minmax(0,1fr);gap:10px;flex:1;min-height:0}",
      "@media (max-width:860px){.dshRunnerBody{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,auto) minmax(160px,1fr)}}",
      ".dshRunnerList{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05))}",
      ".dshRunnerRow{display:flex;align-items:flex-start;gap:7px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.22));min-width:0;cursor:pointer}",
      ".dshRunnerRow:last-child{border-bottom:0}",
      ".dshRunnerRow:hover{background:rgba(103,158,254,.06)}",
      ".dshRunnerRow[data-selected=true]{background:rgba(103,158,254,.12)}",
      ".dshRunnerRow[data-disabled=true]{opacity:.55}",
      ".dshRunnerDot{width:7px;height:7px;border-radius:50%;margin-top:6px;flex:none;background:rgba(128,128,128,.6)}",
      ".dshRunnerDot[data-status=starting]{background:#f59e0b}",
      ".dshRunnerDot[data-status=running]{background:#22c55e}",
      ".dshRunnerDot[data-status=stopping]{background:#f59e0b}",
      ".dshRunnerDot[data-status=failed]{background:#f87171}",
      ".dshRunnerDot[data-status=exited]{background:#f87171}",
      ".dshRunnerRowMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
      ".dshRunnerRowTitle{display:flex;align-items:center;gap:5px;min-width:0}",
      ".dshRunnerRowTitleText{font-size:12px;font-weight:500;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
      ".dshRunnerStateText{font-size:10px;line-height:14px;opacity:.65;flex:none;white-space:nowrap}",
      ".dshRunnerStateText[data-status=running]{color:#22c55e;opacity:1}",
      ".dshRunnerStateText[data-status=starting],.dshRunnerStateText[data-status=stopping]{color:#f59e0b;opacity:1}",
      ".dshRunnerStateText[data-status=failed],.dshRunnerStateText[data-status=exited]{color:#f87171;opacity:1}",
      ".dshRunnerRowCmd{font-size:10px;line-height:14px;opacity:.55;font-family:ui-monospace,Consolas,'Courier New',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshRunnerRowMeta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:10px;line-height:14px;opacity:.75;min-width:0}",
      ".dshRunnerPort{flex:none;padding:0 5px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));font-size:9px;line-height:14px;font-family:ui-monospace,Consolas,'Courier New',monospace}",
      ".dshRunnerPortWarn{border-color:rgba(245,158,11,.65);color:#f59e0b;background:rgba(245,158,11,.1)}",
      ".dshRunnerRowActions{display:flex;align-items:center;gap:2px;flex:none}",
      ".dshRunnerMiniBtn{height:20px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:10px;line-height:18px;cursor:pointer;white-space:nowrap}",
      ".dshRunnerMiniBtn:hover:not([disabled]){background:rgba(103,158,254,.14)}",
      ".dshRunnerMiniBtn[disabled]{opacity:.35;cursor:default}",
      ".dshRunnerMiniBtn[data-action=stop]:hover:not([disabled]){background:rgba(239,68,68,.12);color:#f87171}",
      ".dshRunnerEmpty{padding:22px 12px;text-align:center;font-size:11px;line-height:17px;opacity:.55}",
      ".dshRunnerLogPane{display:flex;flex-direction:column;min-width:0;min-height:0;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));overflow:hidden}",
      ".dshRunnerLogHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 9px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.28));font-size:11px;line-height:16px;min-width:0}",
      ".dshRunnerLogTitle{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 120px}",
      ".dshRunnerLogMeta{font-size:10px;opacity:.55;white-space:nowrap;flex:none}",
      ".dshRunnerPre{flex:1;min-height:140px;margin:0;padding:8px 10px;overflow:auto;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;user-select:text;background:rgba(0,0,0,.18);color:inherit}",
      ".dshRunnerDiag{display:flex;flex-direction:column;gap:4px;flex:none}",
      ".dshRunnerDiagTitle{font-size:11px;font-weight:600;line-height:16px;opacity:.85}",
      ".dshRunnerDiagRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;padding:5px 9px;border:.5px solid rgba(245,158,11,.38);border-radius:8px;background:rgba(245,158,11,.07)}",
      ".dshRunnerDiagText{flex:1 1 200px;min-width:0;word-break:break-word}",
      ".dshRunnerError{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;border:.5px solid rgba(239,68,68,.45);background:rgba(239,68,68,.08);color:#f87171;border-radius:8px;padding:7px 9px;font-size:11px;line-height:16px;flex:none}",
      ".dshRunnerErrorText{flex:1 1 220px;min-width:0;word-break:break-word}",
      ".dshRunnerErrorDetail{flex:0 0 100%;opacity:.85;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:10px;line-height:15px;word-break:break-word}",
      // ---- 端口冲突对话框 ----
      ".dshRunnerDialogBackdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:24px}",
      ".dshRunnerDialog{width:min(740px,100%);max-height:min(80vh,760px);overflow:auto;display:flex;flex-direction:column;gap:9px;padding:14px 16px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));background:var(--dsw-alias-bg-layer-1,#1f1f22);box-shadow:0 18px 48px rgba(0,0,0,.45)}",
      ".dshRunnerDialogHead{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}",
      ".dshRunnerDialogSub{font-size:11px;line-height:17px;opacity:.75}",
      ".dshRunnerConflictEntry{display:flex;flex-direction:column;gap:3px;padding:9px 10px;border-radius:9px;border:.5px solid rgba(245,158,11,.38);background:rgba(245,158,11,.07);font-size:11px;line-height:16px}",
      ".dshRunnerConflictHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-weight:600}",
      ".dshRunnerConflictPort{font-family:ui-monospace,Consolas,'Courier New',monospace;color:#f59e0b}",
      ".dshRunnerConflictMeta{opacity:.8;word-break:break-word}",
      ".dshRunnerConflictCode{font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:10px;line-height:15px;opacity:.72;word-break:break-all;max-height:52px;overflow:auto;user-select:text}",
      ".dshRunnerConflictTag{flex:none;padding:0 6px;border-radius:999px;font-size:9px;line-height:15px;border:.5px solid rgba(245,158,11,.6);color:#f59e0b}",
      ".dshRunnerDialogActions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:2px}",
      ".dshRunnerDialogError{font-size:11px;line-height:16px;color:#f87171;background:rgba(239,68,68,.08);border-radius:8px;padding:6px 9px;word-break:break-word}",
      ".dshRunnerDialogBusy{font-size:11px;opacity:.75}",
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
      if (ctx === null || ctx === undefined) return undefined;
      try {
        return ctx.get(name);
      } catch (_error) {
        return undefined;
      }
    }

    function messageOf(error) {
      if (error === undefined || error === null) return "未知错误";
      if (typeof error === "string") return error;
      if (error.message) return String(error.message);
      return String(error);
    }

    function logPluginError(ctx, message, error) {
      if (ctx !== null && ctx !== undefined && ctx.logger !== undefined && ctx.logger !== null
        && typeof ctx.logger.error === "function") {
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

    function confirmAction(text) {
      if (typeof window === "undefined" || typeof window.confirm !== "function") return false;
      return window.confirm(text) === true;
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
        /* 缓存写失败只影响下次是否重新请求 GitHub，忽略 */
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
          /* 回退到复制发布页地址 */
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
    // 五、Host RPC（失败一律 throw，code/details 透传）
    // =====================================================================
    function connectionOf() {
      if (hostConnection !== null && hostConnection !== undefined) return hostConnection;
      // connection 服务可能比 apply 晚就绪：这里再取一次（不是数据兜底）。
      if (runtimeCtx !== null && runtimeCtx !== undefined) {
        try {
          var value = runtimeCtx.get("connection");
          if (value !== undefined && value !== null) {
            hostConnection = value;
            return value;
          }
        } catch (_error) {
          /* 没有 connection 服务：下面按「无连接」抛出明确错误 */
        }
      }
      return null;
    }

    function rpcError(code, message, details) {
      var error = new Error(message);
      error.code = code;
      error.details = details;
      return error;
    }

    /**
     * 调用 Host 半体注册的 RPC。
     * 成功返回 value；失败 throw（err.code / err.details 来自 Host 结构化错误）；无连接直接 throw。
     */
    async function rpc(endpoint, payload) {
      var connection = connectionOf();
      if (connection === null || connection.rpc === undefined || connection.rpc === null
        || typeof connection.rpc.call !== "function") {
        throw rpcError("no-connection", "Host 项目运行器不可用（RPC 未连接）", undefined);
      }
      var result;
      try {
        result = await connection.rpc.call(RPC_CHANNEL, RPC_NAMESPACE + "/" + endpoint, payload === undefined ? {} : payload);
      } catch (error) {
        throw rpcError(
          error !== null && error !== undefined && typeof error.code === "string" ? error.code : "rpc-failed",
          messageOf(error) + "（" + endpoint + "）",
          error !== null && error !== undefined ? error.details : undefined
        );
      }
      if (result === null || result === undefined || typeof result !== "object") {
        throw rpcError("rpc-failed", "Host RPC " + endpoint + " 没有返回结果", undefined);
      }
      if (result.ok !== true) {
        var info = result.error !== null && result.error !== undefined && typeof result.error === "object" ? result.error : {};
        throw rpcError(
          typeof info.code === "string" ? info.code : "rpc-failed",
          typeof info.message === "string" && info.message !== "" ? info.message : ("RPC 失败：" + endpoint),
          info.details
        );
      }
      return result.value;
    }

    // =====================================================================
    // 六、配置 store（内存 + 订阅；唯一数据来源是 Host）
    // =====================================================================
    var configState = null;
    var configLoaded = false;
    var configListeners = new Set();

    function getConfigSnapshot() {
      return configState;
    }

    function notifyConfig() {
      configListeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          logPluginError(runtimeCtx, "配置订阅回调异常", error);
        }
      });
    }

    function setConfigState(next) {
      configState = next;
      configLoaded = true;
      notifyConfig();
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

    /** 从 Host 读取最新配置并写入内存 store（返回 RPC 的整个 value）。 */
    async function loadConfig() {
      var value = await rpc("config/get", {});
      setConfigState(value !== null && value !== undefined && value.config !== undefined ? value.config : null);
      return value;
    }

    /**
     * 调 config/* 写接口：Host 返回的 config 就是唯一事实，直接覆盖 store；返回整个 value。
     * 失败由 rpc throw，调用方展示并保持 store 不变。
     */
    async function mutate(endpoint, payload) {
      var value = await rpc(endpoint, payload);
      if (value !== null && value !== undefined && value.config !== undefined) setConfigState(value.config);
      return value;
    }

    function commandsOf(config) {
      return config !== null && config !== undefined && Array.isArray(config.commands) ? config.commands : [];
    }

    function findCommandOf(config, commandId) {
      var commands = commandsOf(config);
      for (var i = 0; i < commands.length; i += 1) {
        if (commands[i] !== null && commands[i] !== undefined && commands[i].id === commandId) return commands[i];
      }
      return undefined;
    }

    function uiVisibleOf(config) {
      if (config === null || config === undefined || config.ui === null || config.ui === undefined) return true;
      return config.ui.visible !== false;
    }

    // =====================================================================
    // 七、纯函数（路径 / 状态 / 日志格式化）
    // =====================================================================
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

    /** 当前项目应显示的命令：匹配项目的 project 命令 + 所有 global 命令。 */
    function visibleCommandsForProject(config, projectPath) {
      var list = [];
      var commands = commandsOf(config);
      for (var i = 0; i < commands.length; i += 1) {
        var command = commands[i];
        if (command === null || command === undefined) continue;
        if (command.scope === "global" || commandMatchesProject(command, projectPath)) list.push(command);
      }
      return list;
    }

    function runnerStatusText(status) {
      if (status === "starting") return "启动中";
      if (status === "running") return "运行中";
      if (status === "stopping") return "停止中";
      if (status === "stopped") return "已停止";
      if (status === "exited") return "已退出";
      if (status === "failed") return "启动失败";
      return "未运行";
    }

    /** 去掉 ANSI 转义（CSI 颜色/光标、OSC 标题/超链接），日志展示用。 */
    function stripAnsi(text) {
      var value = String(text === undefined || text === null ? "" : text);
      return value
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\u001b[@-_]/g, "");
    }

    function pad2(value) {
      return (value < 10 ? "0" : "") + String(value);
    }

    /** 运行时长：0s / 1m 05s / 1h 02m。 */
    function formatUptime(ms) {
      var number = Number(ms);
      if (!Number.isFinite(number) || number < 0) return "—";
      var total = Math.floor(number / 1000);
      if (total >= 3600) return Math.floor(total / 3600) + "h " + pad2(Math.floor((total % 3600) / 60)) + "m";
      if (total >= 60) return Math.floor(total / 60) + "m " + pad2(total % 60) + "s";
      return total + "s";
    }

    /** 字节数：0 B / 512 B / 64.0 KB / 1.0 MB。 */
    function formatBytes(bytes) {
      var value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return "0 B";
      if (value < 1024) return Math.floor(value) + " B";
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
      return (value / (1024 * 1024)).toFixed(1) + " MB";
    }

    /** 错误条里补充的结构化详情（端口冲突 / 依赖失败）。 */
    function errorDetailText(error) {
      if (error === null || error === undefined) return "";
      var details = error.details;
      if ((error.code === "port-conflict" || error.code === "port-mismatch")
        && details !== null && details !== undefined && Array.isArray(details.ports)) {
        var text = details.ports.map(function (item) {
          return "端口 " + String(item.port) + (item.occupant === undefined ? "" : " · " + occupantSummary(item.occupant));
        }).join("；");
        if (Array.isArray(details.actualPorts) && details.actualPorts.length > 0) {
          text += "；实际绑定：" + details.actualPorts.map(String).join("、");
        }
        return text;
      }
      if (error.code === "managed-port" && details !== null && details !== undefined && details.occupant !== undefined) {
        return "端口 " + String(details.port) + " 由托管命令占用：" + occupantSummary(details.occupant);
      }
      if (error.code === "port-changed" && details !== null && details !== undefined && details.occupant !== undefined) {
        return "端口 " + String(details.port) + " 已换成 " + occupantSummary(details.occupant);
      }
      if (error.code === "dependency-failed" && details !== null && details !== undefined && typeof details === "object") {
        return "依赖命令 " + String(details.commandId) + " 启动失败：" + String(details.message);
      }
      if (error.code === "ready-timeout" && details !== null && details !== undefined && typeof details === "object") {
        return "端口 " + String(details.port) + " 未在 " + String(details.timeoutMs) + "ms 内就绪";
      }
      if (details !== null && details !== undefined && typeof details === "object" && Object.keys(details).length > 0) {
        return JSON.stringify(details);
      }
      return "";
    }

    /** 占用者的简短描述：name（PID 1234）。 */
    function occupantSummary(occupant) {
      if (occupant === null || occupant === undefined) return "未知进程";
      var name = typeof occupant.name === "string" && occupant.name !== "" ? occupant.name : "进程";
      var suffix = typeof occupant.pid === "number" ? "（PID " + String(occupant.pid) + "）" : "";
      return name + suffix;
    }

    /** 父进程链：cmd.exe（123）← Code.exe（45，窗口：项目 - Visual Studio Code）；没有祖先时返回空串。 */
    function formatProcessChain(occupant) {
      if (occupant === null || occupant === undefined || !Array.isArray(occupant.ancestors)) return "";
      var parts = [];
      for (var i = 0; i < occupant.ancestors.length; i += 1) {
        var item = occupant.ancestors[i];
        if (item === null || item === undefined) continue;
        var name = typeof item.name === "string" && item.name !== "" ? item.name : "进程";
        var title = typeof item.windowTitle === "string" && item.windowTitle !== "" ? "，窗口：" + item.windowTitle : "";
        var pidText = typeof item.pid === "number" ? String(item.pid) : "?";
        parts.push(name + "（" + pidText + title + "）");
      }
      return parts.join(" ← ");
    }

    /** 子进程摘要：a.exe（12）、b.exe（34），最多 6 个；没有返回空串。 */
    function formatProcessChildren(occupant) {
      if (occupant === null || occupant === undefined || !Array.isArray(occupant.children)) return "";
      var parts = [];
      for (var i = 0; i < occupant.children.length && i < 6; i += 1) {
        var item = occupant.children[i];
        if (item === null || item === undefined) continue;
        var name = typeof item.name === "string" && item.name !== "" ? item.name : "进程";
        parts.push(name + (typeof item.pid === "number" ? "（" + String(item.pid) + "）" : ""));
      }
      if (occupant.children.length > 6) parts.push("…");
      return parts.join("、");
    }

    /** 是否是端口阻塞错误（port-conflict / port-mismatch，均带占用者列表）。 */
    function isPortBlockingError(error) {
      return error !== null && error !== undefined
        && (error.code === "port-conflict" || error.code === "port-mismatch")
        && error.details !== null && error.details !== undefined && Array.isArray(error.details.ports);
    }

    // =====================================================================
    // 八、会话 / 工作区 hooks
    // =====================================================================
    /** 从壳层 slots 提供的 hooks 里解析「当前会话 + 当前工作区路径」。 */
    function useActiveSession(hooks) {
      var sessions = hooks !== undefined && hooks !== null && typeof hooks.useSessions === "function"
        ? hooks.useSessions(function (state) { return state; })
        : undefined;
      var workspaces = hooks !== undefined && hooks !== null && typeof hooks.useWorkspaces === "function"
        ? hooks.useWorkspaces(function (state) { return state; })
        : undefined;
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

    /** 由工作区快照反查某个会话所属工作区路径（composer 按钮用）。 */
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

    // =====================================================================
    // 九、更新状态 hook 与插件详情页提示
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
        hint = "检查失败：" + update.message + "（不影响运行面板）";
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
    // 十、工作区选项 / 小图标
    // =====================================================================
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

    /** 左侧导航「运行」面板图标：播放三角（props.size）。 */
    function RunnerPanelIcon(props) {
      var size = props !== undefined && props !== null && typeof props.size === "number" ? props.size : 16;
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        "aria-hidden": "true",
        focusable: "false"
      }, h("path", { d: "M5 3.2l8 4.8-8 4.8V3.2z", fill: "currentColor" }));
    }

    // =====================================================================
    // 十一、配置编辑器（settings.section 与运行面板「管理命令」弹窗共用）
    // =====================================================================
    function emptyDraft(projectPath) {
      var hasProject = typeof projectPath === "string" && projectPath !== "";
      return {
        id: "",
        title: "",
        command: "",
        cwd: "",
        scope: hasProject ? "project" : "global",
        projectRoot: hasProject ? projectPath : "",
        enabled: true,
        envText: "",
        portsText: "",
        readyPortText: "",
        readyTimeoutText: "120000",
        dependsOn: []
      };
    }

    function draftFromCommand(command) {
      var env = command.env !== null && command.env !== undefined && typeof command.env === "object" ? command.env : {};
      var envLines = [];
      var envKeys = Object.keys(env);
      for (var i = 0; i < envKeys.length; i += 1) envLines.push(envKeys[i] + "=" + String(env[envKeys[i]]));
      var ports = Array.isArray(command.ports) ? command.ports : [];
      return {
        id: typeof command.id === "string" ? command.id : "",
        title: typeof command.title === "string" ? command.title : "",
        command: typeof command.command === "string" ? command.command : "",
        cwd: typeof command.cwd === "string" ? command.cwd : "",
        scope: command.scope === "project" ? "project" : "global",
        projectRoot: typeof command.projectRoot === "string" ? command.projectRoot : "",
        enabled: command.enabled !== false,
        envText: envLines.join("\n"),
        portsText: ports.join(", "),
        readyPortText: command.readyPort === null || command.readyPort === undefined ? "" : String(command.readyPort),
        readyTimeoutText: typeof command.readyTimeoutMs === "number" ? String(command.readyTimeoutMs) : "120000",
        dependsOn: Array.isArray(command.dependsOn) ? command.dependsOn.slice() : []
      };
    }

    /**
     * 把表单草稿转成 RPC 的 command/patch。
     * 只做「文本 → 结构」的输入解析（env 行、端口列表），语义校验交给 Host。
     */
    function parseDraft(draft) {
      var title = String(draft.title === undefined || draft.title === null ? "" : draft.title).trim();
      if (title === "") throw new Error("请填写命令名称");
      var command = String(draft.command === undefined || draft.command === null ? "" : draft.command).trim();
      if (command === "") throw new Error("请填写要执行的命令");
      var scope = draft.scope === "project" ? "project" : "global";
      var projectRoot = String(draft.projectRoot === undefined || draft.projectRoot === null ? "" : draft.projectRoot).trim();
      if (scope === "project" && projectRoot === "") throw new Error("「指定项目」必须选择或填写项目根目录");

      var env = {};
      var envLines = String(draft.envText === undefined || draft.envText === null ? "" : draft.envText).split(/\r?\n/);
      for (var i = 0; i < envLines.length; i += 1) {
        var line = envLines[i].trim();
        if (line === "" || line.charAt(0) === "#") continue;
        var matched = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (matched === null) throw new Error("环境变量第 " + (i + 1) + " 行格式错误，应为 KEY=VALUE：" + line);
        env[matched[1]] = matched[2];
      }

      var ports = [];
      var portTexts = String(draft.portsText === undefined || draft.portsText === null ? "" : draft.portsText).split(/[,\s]+/);
      for (var j = 0; j < portTexts.length; j += 1) {
        var portText = portTexts[j].trim();
        if (portText === "") continue;
        var port = Number(portText);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error("端口必须是 0-65535 的整数：" + portText);
        }
        if (ports.indexOf(port) === -1) ports.push(port);
      }

      var readyPortText = String(draft.readyPortText === undefined || draft.readyPortText === null ? "" : draft.readyPortText).trim();
      var readyPort = null;
      if (readyPortText !== "") {
        var parsedReadyPort = Number(readyPortText);
        if (!Number.isInteger(parsedReadyPort) || parsedReadyPort < 0 || parsedReadyPort > 65535) {
          throw new Error("就绪端口必须是 0-65535 的整数：" + readyPortText);
        }
        readyPort = parsedReadyPort;
      }

      var readyTimeoutText = String(draft.readyTimeoutText === undefined || draft.readyTimeoutText === null ? "" : draft.readyTimeoutText).trim();
      var readyTimeoutMs = 120000;
      if (readyTimeoutText !== "") {
        var parsedTimeout = Number(readyTimeoutText);
        if (!Number.isInteger(parsedTimeout) || parsedTimeout < 1000 || parsedTimeout > 1800000) {
          throw new Error("就绪超时必须是不小于 1000 的整数毫秒（上限 1800000）");
        }
        readyTimeoutMs = parsedTimeout;
      }

      var dependsOn = [];
      if (Array.isArray(draft.dependsOn)) {
        for (var k = 0; k < draft.dependsOn.length; k += 1) {
          var dependency = draft.dependsOn[k];
          if (typeof dependency === "string" && dependency !== "" && dependsOn.indexOf(dependency) === -1) {
            dependsOn.push(dependency);
          }
        }
      }

      return {
        title: title,
        command: command,
        cwd: String(draft.cwd === undefined || draft.cwd === null ? "" : draft.cwd).trim(),
        scope: scope,
        projectRoot: scope === "project" ? projectRoot : "",
        enabled: draft.enabled !== false,
        env: env,
        ports: ports,
        readyPort: readyPort,
        readyTimeoutMs: readyTimeoutMs,
        dependsOn: dependsOn
      };
    }

    function ConfigEditor(props) {
      var config = useConfig();
      var currentProjectPath = props !== undefined ? props.currentProjectPath : undefined;
      var workspaces = props !== undefined && Array.isArray(props.workspaces) ? props.workspaces : [];

      var editingPair = react.useState(null);
      var editing = editingPair[0];
      var setEditing = editingPair[1];
      var busyPair = react.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var errorPair = react.useState("");
      var error = errorPair[0];
      var setError = errorPair[1];
      var noticePair = react.useState("");
      var notice = noticePair[0];
      var setNotice = noticePair[1];
      var deletePair = react.useState(null);
      var pendingDelete = deletePair[0];
      var setPendingDelete = deletePair[1];
      var projectCustomPair = react.useState(false);
      var projectCustom = projectCustomPair[0];
      var setProjectCustom = projectCustomPair[1];

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

      // 打开时从 Host 读一次最新配置（AI 可能刚通过 Tool 改过）。
      react.useEffect(function () {
        var alive = true;
        loadConfig().catch(function (loadError) {
          if (alive) setError(messageOf(loadError));
        });
        return function () {
          alive = false;
        };
      }, []);

      /** 项目选择器的选项：已注册工作区 + 当前工作区（若尚未注册，当前工作区排在最前）。 */
      function projectOptions() {
        var list = workspaces.slice();
        if (currentProjectPath !== undefined && currentProjectPath !== null && currentProjectPath !== "") {
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
        setEditing(emptyDraft(currentProjectPath));
        setProjectCustom(false);
        setError("");
      }

      function startEdit(command) {
        var draft = draftFromCommand(command);
        setEditing(draft);
        setProjectCustom(draft.scope === "project" && draft.projectRoot !== "" && workspaceFor(draft.projectRoot) === undefined);
        setError("");
      }

      function updateDraft(field, value) {
        setEditing(function (previous) {
          if (previous === null || previous === undefined) return previous;
          var next = Object.assign({}, previous);
          next[field] = value;
          return next;
        });
      }

      function chooseScope(scope) {
        setEditing(function (previous) {
          if (previous === null || previous === undefined) return previous;
          var next = Object.assign({}, previous);
          next.scope = scope;
          if (scope === "project") {
            if (next.projectRoot === "") next.projectRoot = currentProjectPath !== undefined && currentProjectPath !== null ? currentProjectPath : "";
            if (next.cwd === "" && next.projectRoot !== "") next.cwd = next.projectRoot;
          }
          return next;
        });
        setProjectCustom(false);
      }

      function chooseProject(value) {
        if (value === "__custom__") {
          setProjectCustom(true);
          updateDraft("projectRoot", "");
          return;
        }
        setProjectCustom(false);
        setEditing(function (previous) {
          if (previous === null || previous === undefined) return previous;
          var next = Object.assign({}, previous);
          next.projectRoot = value;
          if (next.cwd === "") next.cwd = value;
          return next;
        });
      }

      function useProjectAsCwd() {
        setEditing(function (previous) {
          if (previous === null || previous === undefined || previous.projectRoot === "") return previous;
          var next = Object.assign({}, previous);
          next.cwd = next.projectRoot;
          return next;
        });
      }

      function toggleDependency(id) {
        setEditing(function (previous) {
          if (previous === null || previous === undefined) return previous;
          var next = Object.assign({}, previous);
          var list = Array.isArray(previous.dependsOn) ? previous.dependsOn.slice() : [];
          var index = list.indexOf(id);
          if (index === -1) list.push(id);
          else list.splice(index, 1);
          next.dependsOn = list;
          return next;
        });
      }

      async function saveDraft() {
        if (editing === null || editing === undefined || busy) return;
        setBusy(true);
        setError("");
        try {
          var payload = parseDraft(editing);
          if (editing.id === "") {
            var created = await mutate("config/create", { command: payload });
            flash("已创建：" + (created !== null && created !== undefined && created.command !== null
              && created.command !== undefined && typeof created.command.title === "string"
              ? created.command.title : payload.title));
          } else {
            var updated = await mutate("config/update", { id: editing.id, patch: payload });
            flash("已保存：" + (updated !== null && updated !== undefined && updated.command !== null
              && updated.command !== undefined && typeof updated.command.title === "string"
              ? updated.command.title : payload.title));
          }
          setEditing(null);
          setProjectCustom(false);
        } catch (saveError) {
          setError(messageOf(saveError));
        } finally {
          setBusy(false);
        }
      }

      async function removeCommand(id) {
        setBusy(true);
        setError("");
        try {
          await mutate("config/delete", { id: id });
          if (editing !== null && editing !== undefined && editing.id === id) setEditing(null);
          setPendingDelete(null);
          flash("已删除命令");
        } catch (deleteError) {
          setError(messageOf(deleteError));
        } finally {
          setBusy(false);
        }
      }

      async function moveCommand(index, delta) {
        if (busy) return;
        var commands = commandsOf(config);
        var target = index + delta;
        if (target < 0 || target >= commands.length) return;
        var ids = [];
        for (var i = 0; i < commands.length; i += 1) ids.push(commands[i].id);
        var moved = ids[index];
        ids[index] = ids[target];
        ids[target] = moved;
        setBusy(true);
        setError("");
        try {
          await mutate("config/reorder", { ids: ids });
        } catch (reorderError) {
          setError(messageOf(reorderError));
        } finally {
          setBusy(false);
        }
      }

      async function toggleEnabled(command) {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await mutate("config/update", { id: command.id, patch: { enabled: command.enabled === false } });
        } catch (toggleError) {
          setError(messageOf(toggleError));
        } finally {
          setBusy(false);
        }
      }

      async function toggleVisible() {
        if (busy) return;
        var visible = !uiVisibleOf(config);
        setBusy(true);
        setError("");
        try {
          await mutate("config/ui", { visible: visible });
          flash(visible ? "已显示输入框下方的运行按钮" : "已隐藏输入框下方的运行按钮");
        } catch (visibleError) {
          setError(messageOf(visibleError));
        } finally {
          setBusy(false);
        }
      }

      var commands = commandsOf(config);
      var options = projectOptions();
      var projectCount = 0;
      for (var countIndex = 0; countIndex < commands.length; countIndex += 1) {
        if (commands[countIndex].scope === "project") projectCount += 1;
      }
      var currentWorkspace = currentProjectPath !== undefined && currentProjectPath !== null && currentProjectPath !== ""
        ? workspaceFor(currentProjectPath)
        : undefined;
      var statText = (configLoaded ? commands.length + " 条命令" : "正在读取 Host 配置…")
        + (projectCount > 0 ? " · " + projectCount + " 条项目级" : "")
        + (currentWorkspace !== undefined ? " · 当前 " + currentWorkspace.title : "");

      var selectedProject = editing !== null && editing !== undefined && editing.projectRoot !== ""
        ? workspaceFor(editing.projectRoot)
        : undefined;
      var projectSelectValue = projectCustom
        ? "__custom__"
        : (selectedProject !== undefined
          ? selectedProject.path
          : (editing !== null && editing !== undefined && editing.projectRoot !== ""
            ? "__custom__"
            : (options.length > 0 ? options[0].path : "__custom__")));

      // dependsOn 候选：同一项目（或当前项目）里已启用的其它命令。
      var depProjectPath = editing !== null && editing !== undefined && editing.scope === "project" && editing.projectRoot !== ""
        ? editing.projectRoot
        : currentProjectPath;
      var depCandidates = editing === null || editing === undefined ? [] : visibleCommandsForProject(config, depProjectPath).filter(function (command) {
        return command.id !== editing.id && command.enabled !== false;
      });

      var form = editing === null || editing === undefined ? null : h("div", { className: "dshLimobCfgForm" },
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
              placeholder: "例如：调试后端",
              onChange: function (event) { updateDraft("title", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField" },
            h("span", null, "触发端口（逗号分隔）"),
            h("input", {
              className: "dshLimobInput",
              value: editing.portsText,
              placeholder: "8001, 5173",
              onChange: function (event) { updateDraft("portsText", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "命令（PowerShell 固定文本）*"),
            h("textarea", {
              className: "dshLimobTextarea",
              value: editing.command,
              placeholder: "python -m uvicorn main:app --port 8001 --reload",
              onChange: function (event) { updateDraft("command", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "工作目录（空 = 项目目录）"),
            h("div", { className: "dshLimobFormRow" },
              h("input", {
                className: "dshLimobInput",
                style: { flex: "1 1 220px" },
                value: editing.cwd,
                placeholder: "H:\\项目\\后端",
                onChange: function (event) { updateDraft("cwd", event.target.value); }
              }),
              editing.scope === "project" && editing.projectRoot !== ""
                ? h("button", { type: "button", className: "dshLimobLinkBtn", onClick: useProjectAsCwd }, "使用项目目录")
                : null)),
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
                  placeholder: "项目根目录，例如 H:\\项目",
                  onChange: function (event) { updateDraft("projectRoot", event.target.value); }
                })
              : null,
            editing.scope === "project"
              ? h("span", { className: "dshLimobFieldHint" }, "只在该工作区的会话与运行面板里出现；下拉列表来自 DSH 已注册的工作区。")
              : null),
          h("label", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "环境变量（每行 KEY=VALUE）"),
            h("textarea", {
              className: "dshLimobTextarea",
              value: editing.envText,
              placeholder: "APP_ENV=dev\nAPP_PORT=8001",
              onChange: function (event) { updateDraft("envText", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField" },
            h("span", null, "就绪端口（空 = 不等就绪）"),
            h("input", {
              className: "dshLimobInput",
              value: editing.readyPortText,
              placeholder: "8001",
              onChange: function (event) { updateDraft("readyPortText", event.target.value); }
            })),
          h("label", { className: "dshLimobFormField" },
            h("span", null, "就绪超时（毫秒，>=1000）"),
            h("input", {
              className: "dshLimobInput",
              value: editing.readyTimeoutText,
              placeholder: "120000",
              onChange: function (event) { updateDraft("readyTimeoutText", event.target.value); }
            })),
          h("div", { className: "dshLimobFormField", "data-wide": "true" },
            h("span", null, "依赖命令（先启动这些命令）"),
            depCandidates.length === 0
              ? h("span", { className: "dshLimobFieldHint" }, "当前项目没有可选的其它命令")
              : h("div", { className: "dshLimobDepList" },
                  depCandidates.map(function (command) {
                    return h("label", { key: command.id, className: "dshLimobDepItem" },
                      h("input", {
                        type: "checkbox",
                        checked: Array.isArray(editing.dependsOn) && editing.dependsOn.indexOf(command.id) !== -1,
                        onChange: function () { toggleDependency(command.id); }
                      }),
                      h("span", null, command.title));
                  }))),
          h("div", { className: "dshLimobFormRow", "data-wide": "true" },
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
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnPrimary",
            disabled: busy,
            onClick: saveDraft
          }, busy ? "保存中…" : "保存")));

      var list = commands.length === 0
        ? h("div", { className: "dshLimobCmdList" },
            h("div", { className: "dshLimobCfgEmpty" },
              configLoaded ? "还没有命令，点右上角「+ 新增」添加一条。" : "正在从 Host 读取命令配置…"))
        : h("div", { className: "dshLimobCmdList" },
            commands.map(function (command, index) {
              var projectLabel = command.scope === "project"
                ? "项目 · " + projectTitleOf(command.projectRoot, options)
                : "全局";
              var actions = pendingDelete === command.id
                ? [
                    h("button", {
                      key: "confirm",
                      type: "button",
                      className: "dshLimobCfgBtn dshLimobCfgBtnDanger",
                      disabled: busy,
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
                        checked: command.enabled !== false,
                        onChange: function () { toggleEnabled(command); }
                      }),
                      h("span", { className: "dshLimobSwitchTrack" })),
                    h("button", {
                      key: "up",
                      type: "button",
                      className: "dshLimobIconBtn",
                      title: "上移",
                      "aria-label": "上移",
                      disabled: index === 0 || busy,
                      onClick: function () { moveCommand(index, -1); }
                    }, limobIcon("up")),
                    h("button", {
                      key: "down",
                      type: "button",
                      className: "dshLimobIconBtn",
                      title: "下移",
                      "aria-label": "下移",
                      disabled: index === commands.length - 1 || busy,
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
                "data-disabled": command.enabled === false ? "true" : "false"
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
                      title: command.scope === "project" ? String(command.projectRoot) : "所有项目"
                    }, projectLabel),
                    command.enabled === false ? h("span", { className: "dshLimobTag" }, "已停用") : null),
                  h("div", { className: "dshLimobCmdPreview" }, String(command.command))),
                h("div", { className: "dshLimobCmdActions" }, actions));
            }));

      return h("div", { className: "dshLimobCfg" },
        h("div", { className: "dshLimobCfgToolbar" },
          h("span", { className: "dshLimobCfgStat", title: statText }, statText),
          h("label", { className: "dshLimobSwitch", title: "在输入框下方显示「运行」按钮" },
            h("input", { type: "checkbox", checked: uiVisibleOf(config), onChange: toggleVisible }),
            h("span", { className: "dshLimobSwitchTrack" }),
            h("span", null, "运行按钮")),
          h("button", {
            type: "button",
            className: "dshLimobCfgBtn dshLimobCfgBtnPrimary",
            disabled: busy,
            onClick: startCreate
          }, limobIcon("plus"), h("span", null, "新增"))),
        form,
        list,
        error !== "" ? h("div", { className: "dshLimobCfgError" }, error) : null,
        notice !== "" ? h("div", { className: "dshLimobCfgNotice" }, notice) : null);
    }

    // =====================================================================
    // 十二、设置页 section（Settings 弹窗左侧新增一个 Tab）
    // =====================================================================
    function LimobSettingsSection(props) {
      var active = useActiveSession(props);
      var workspaces = workspaceOptionsFrom(props !== undefined ? props.useWorkspaces : undefined);
      return h("div", { className: "dshLimobCfgPage" },
        h("div", { className: "dshLimobPageHead" },
          h("div", null,
            h("div", { className: "dshLimobPageTitle" }, "dsh-runner"),
            h("div", { className: "dshLimobPageSub" }, "项目运行命令：左侧「运行」面板负责启停与日志，这里编辑命令")),
          h("span", { className: "dshLimobPageVersion" }, "v" + PLUGIN_VERSION)),
        h(ConfigEditor, {
          currentProjectPath: active.projectPath,
          workspaces: workspaces
        }));
    }

    // =====================================================================
    // 十三、运行面板（左侧导航「运行」+ main 槽位）
    // =====================================================================
    function RunnerPage(props) {
      var active = useActiveSession(props);
      var config = useConfig();
      var projectPath = active !== null && active !== undefined && typeof active.projectPath === "string"
        ? active.projectPath
        : undefined;
      var hasProject = projectPath !== undefined && projectPath !== "";

      var runnersPair = react.useState([]);
      var runners = runnersPair[0];
      var setRunners = runnersPair[1];
      var diagnosePair = react.useState([]);
      var diagnose = diagnosePair[0];
      var setDiagnose = diagnosePair[1];
      var selectedPair = react.useState(null);
      var selectedId = selectedPair[0];
      var setSelectedId = selectedPair[1];
      var logPair = react.useState(null);
      var logState = logPair[0];
      var setLogState = logPair[1];
      var errorPair = react.useState(null);
      var error = errorPair[0];
      var setError = errorPair[1];
      var busyPair = react.useState(null);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var conflictPair = react.useState(null);
      var conflict = conflictPair[0];
      var setConflict = conflictPair[1];
      var conflictBusyPair = react.useState(false);
      var conflictBusy = conflictBusyPair[0];
      var setConflictBusy = conflictBusyPair[1];
      var conflictErrorPair = react.useState(null);
      var conflictError = conflictErrorPair[0];
      var setConflictError = conflictErrorPair[1];
      var editorPair = react.useState(false);
      var editorOpen = editorPair[0];
      var setEditorOpen = editorPair[1];
      var copiedPair = react.useState(false);
      var copied = copiedPair[0];
      var setCopied = copiedPair[1];
      var logRef = react.useRef(null);
      var stickRef = react.useRef(true);

      // 日志自动滚到底部：只有用户停留在底部时才跟随，上滚后不强制。
      react.useEffect(function () {
        var pre = logRef.current;
        if (pre === null || pre === undefined) return;
        if (stickRef.current !== true) return;
        pre.scrollTop = pre.scrollHeight;
      }, [logState]);

      // 命中项目后：读配置 + 做一次端口诊断。
      react.useEffect(function () {
        if (!hasProject) return undefined;
        var alive = true;
        loadConfig().catch(function (loadError) {
          if (alive) setError(loadError);
        });
        rpc("project/diagnose", { projectPath: projectPath }).then(function (value) {
          if (alive && value !== null && value !== undefined) setDiagnose(Array.isArray(value.entries) ? value.entries : []);
        }, function (diagnoseError) {
          if (alive) setError(diagnoseError);
        });
        return function () {
          alive = false;
        };
      }, [hasProject, projectPath]);

      // 进程状态：每 2000ms 轮询 project/status（页面卸载清理）。
      react.useEffect(function () {
        if (!hasProject) {
          setRunners([]);
          return undefined;
        }
        var alive = true;
        var timer = null;
        function schedule() {
          if (alive) timer = setTimeout(tick, STATUS_POLL_MS);
        }
        async function tick() {
          try {
            var value = await rpc("project/status", { projectPath: projectPath });
            if (!alive) return;
            setRunners(value !== null && value !== undefined && Array.isArray(value.runners) ? value.runners : []);
          } catch (statusError) {
            if (alive) setError(statusError);
          }
          schedule();
        }
        tick();
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, [hasProject, projectPath]);

      // 选中命令后：每 1000ms 轮询 project/log（maxBytes 65536）。
      react.useEffect(function () {
        if (!hasProject || selectedId === null || selectedId === undefined) {
          setLogState(null);
          return undefined;
        }
        var alive = true;
        var timer = null;
        setLogState(null);
        stickRef.current = true;
        async function tick() {
          try {
            var value = await rpc("project/log", {
              projectPath: projectPath,
              commandId: selectedId,
              maxBytes: LOG_MAX_BYTES
            });
            if (!alive) return;
            setLogState(value !== null && value !== undefined ? value : { text: "", bytes: 0, truncated: false });
          } catch (logError) {
            if (alive) setError(logError);
          }
          if (alive) timer = setTimeout(tick, LOG_POLL_MS);
        }
        tick();
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, [hasProject, projectPath, selectedId]);

      async function refreshDiagnose() {
        if (!hasProject) return;
        try {
          var value = await rpc("project/diagnose", { projectPath: projectPath });
          setDiagnose(value !== null && value !== undefined && Array.isArray(value.entries) ? value.entries : []);
        } catch (diagnoseError) {
          setError(diagnoseError);
        }
      }

      async function refresh() {
        if (!hasProject || busy !== null) return;
        setBusy("__refresh__");
        setError(null);
        try {
          await loadConfig();
          var value = await rpc("project/status", { projectPath: projectPath });
          setRunners(value !== null && value !== undefined && Array.isArray(value.runners) ? value.runners : []);
          await refreshDiagnose();
        } catch (refreshError) {
          setError(refreshError);
        } finally {
          setBusy(null);
        }
      }

      async function runAction(action, commandId) {
        if (!hasProject || busy !== null) return;
        setBusy(commandId);
        setError(null);
        try {
          var endpoint = action === "start" ? "project/start" : action === "stop" ? "project/stop" : "project/restart";
          var value = await rpc(endpoint, { projectPath: projectPath, commandId: commandId });
          if (value !== null && value !== undefined && Array.isArray(value.runners)) setRunners(value.runners);
          if (action !== "stop") setSelectedId(commandId);
          await refreshDiagnose();
        } catch (actionError) {
          if (isPortBlockingError(actionError)) {
            setError(null);
            setConflict({
              commandId: commandId,
              action: action,
              kind: actionError.code,
              ports: actionError.details.ports,
              actualPorts: Array.isArray(actionError.details.actualPorts) ? actionError.details.actualPorts : []
            });
            refreshDiagnose();
          } else {
            setError(actionError);
          }
        } finally {
          setBusy(null);
        }
      }

      async function runStartAll() {
        if (!hasProject || busy !== null) return;
        setBusy("__startAll__");
        setError(null);
        try {
          var value = await rpc("project/startAll", { projectPath: projectPath });
          if (value !== null && value !== undefined && Array.isArray(value.runners)) setRunners(value.runners);
          var failed = value !== null && value !== undefined && Array.isArray(value.failed) ? value.failed : [];
          var conflictFailure = null;
          for (var failedIndex = 0; failedIndex < failed.length; failedIndex += 1) {
            var failedItem = failed[failedIndex];
            if (failedItem !== null && failedItem !== undefined
              && (failedItem.code === "port-conflict" || failedItem.code === "port-mismatch")
              && failedItem.details !== null && failedItem.details !== undefined && Array.isArray(failedItem.details.ports)) {
              conflictFailure = failedItem;
              break;
            }
          }
          if (conflictFailure !== null) {
            setError(null);
            setConflict({
              commandId: conflictFailure.commandId,
              action: "startAll",
              kind: conflictFailure.code,
              ports: conflictFailure.details.ports,
              actualPorts: Array.isArray(conflictFailure.details.actualPorts) ? conflictFailure.details.actualPorts : []
            });
          } else if (failed.length > 0) {
            var first = failed[0] !== null && failed[0] !== undefined ? failed[0] : {};
            var label = typeof first.title === "string" && first.title !== "" ? first.title : String(first.commandId);
            var failure = rpcError(
              typeof first.code === "string" ? first.code : "start-failed",
              "启动失败：" + label + " — " + String(first.message === undefined || first.message === null ? "未知原因" : first.message)
                + (failed.length > 1 ? "（共 " + failed.length + " 条命令启动失败）" : ""),
              first.details
            );
            setError(failure);
          }
          await refreshDiagnose();
        } catch (startAllError) {
          setError(startAllError);
        } finally {
          setBusy(null);
        }
      }

      async function runStopAll() {
        if (!hasProject || busy !== null) return;
        setBusy("__stopAll__");
        setError(null);
        try {
          var value = await rpc("project/stopAll", { projectPath: projectPath });
          if (value !== null && value !== undefined && Array.isArray(value.runners)) setRunners(value.runners);
          await refreshDiagnose();
        } catch (stopAllError) {
          setError(stopAllError);
        } finally {
          setBusy(null);
        }
      }

      async function handleKillPort(entry) {
        if (!hasProject || busy !== null || entry === null || entry === undefined) return;
        var port = entry.port;
        var occupant = entry.occupant === null || entry.occupant === undefined ? undefined : entry.occupant;
        var windowText = occupant !== undefined && typeof occupant.windowTitle === "string" && occupant.windowTitle !== ""
          ? "（窗口：" + occupant.windowTitle + "）"
          : "";
        var owner = "端口 " + String(port) + " 被 " + occupantSummary(occupant) + windowText + " 占用，确定结束该进程吗？"
          + (occupant !== undefined && typeof occupant.commandLine === "string" && occupant.commandLine !== "" ? "\n\n" + occupant.commandLine : "");
        if (!confirmAction(owner)) return;
        setBusy("kill-" + String(port));
        setError(null);
        try {
          await rpc("project/killPort", {
            projectPath: projectPath,
            port: port,
            pid: occupant !== undefined && typeof occupant.pid === "number" ? occupant.pid : undefined
          });
          await refreshDiagnose();
        } catch (killError) {
          setError(killError);
        } finally {
          setBusy(null);
        }
      }

      async function clearLog() {
        if (!hasProject || selectedId === null || selectedId === undefined) return;
        setBusy("__log_clear__");
        setError(null);
        try {
          await rpc("project/log/clear", { projectPath: projectPath, commandId: selectedId });
          setLogState({
            text: "",
            bytes: 0,
            path: logState !== null && logState !== undefined && typeof logState.path === "string" ? logState.path : "",
            truncated: false
          });
          stickRef.current = true;
        } catch (clearError) {
          setError(clearError);
        } finally {
          setBusy(null);
        }
      }

      function copyLog() {
        var text = logState !== null && logState !== undefined && typeof logState.text === "string" ? stripAnsi(logState.text) : "";
        setCopied(copyTextToClipboard(text));
      }

      function handleLogScroll(event) {
        var pre = event !== null && event !== undefined ? event.currentTarget : undefined;
        if (pre === null || pre === undefined) return;
        stickRef.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 32;
      }

      /**
       * 端口冲突确认后的处理：结束未托管进程 / 停止托管命令，然后自动重试启动。
       * killPort 带 expected pid：若这期间端口换了主人，Host 会拒绝并返回 port-changed，避免误杀。
       */
      async function resolveConflict() {
        if (conflict === null || conflict === undefined || conflictBusy) return;
        setConflictBusy(true);
        setConflictError(null);
        try {
          var items = Array.isArray(conflict.ports) ? conflict.ports : [];
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i];
            if (item === null || item === undefined) continue;
            var occupant = item.occupant === null || item.occupant === undefined ? undefined : item.occupant;
            if (occupant !== undefined && occupant.managed === true && typeof occupant.runnerCommandId === "string") {
              await rpc("project/stop", { projectPath: projectPath, commandId: occupant.runnerCommandId });
            } else {
              await rpc("project/killPort", {
                projectPath: projectPath,
                port: item.port,
                pid: occupant !== undefined && typeof occupant.pid === "number" ? occupant.pid : undefined
              });
            }
          }
          if (conflict.action === "startAll") {
            var all = await rpc("project/startAll", { projectPath: projectPath });
            if (all !== null && all !== undefined && Array.isArray(all.runners)) setRunners(all.runners);
            var failed = all !== null && all !== undefined && Array.isArray(all.failed) ? all.failed : [];
            var nextConflict = null;
            for (var failedIndex = 0; failedIndex < failed.length; failedIndex += 1) {
              var failedItem = failed[failedIndex];
              if (failedItem !== null && failedItem !== undefined
                && (failedItem.code === "port-conflict" || failedItem.code === "port-mismatch")
                && failedItem.details !== null && failedItem.details !== undefined && Array.isArray(failedItem.details.ports)) {
                nextConflict = failedItem;
                break;
              }
            }
            await refreshDiagnose();
            if (nextConflict !== null) {
              setConflict({
                commandId: nextConflict.commandId,
                action: "startAll",
                kind: nextConflict.code,
                ports: nextConflict.details.ports,
                actualPorts: Array.isArray(nextConflict.details.actualPorts) ? nextConflict.details.actualPorts : []
              });
              setConflictError(rpcError("port-conflict", String(nextConflict.message), nextConflict.details));
              return;
            }
            if (failed.length > 0) {
              var first = failed[0];
              setError(rpcError("start-failed", "启动失败：" + String(first.message), first.details));
            }
            setConflict(null);
            return;
          }
          var endpoint = conflict.action === "restart" ? "project/restart" : "project/start";
          var value = await rpc(endpoint, { projectPath: projectPath, commandId: conflict.commandId });
          if (value !== null && value !== undefined && Array.isArray(value.runners)) setRunners(value.runners);
          setSelectedId(conflict.commandId);
          await refreshDiagnose();
          setConflict(null);
        } catch (actionError) {
          if (isPortBlockingError(actionError)) {
            setConflict({
              commandId: conflict.commandId,
              action: conflict.action,
              kind: actionError.code,
              ports: actionError.details.ports,
              actualPorts: Array.isArray(actionError.details.actualPorts) ? actionError.details.actualPorts : []
            });
            setConflictError(actionError);
          } else {
            setConflictError(actionError);
          }
          refreshDiagnose();
        } finally {
          setConflictBusy(false);
        }
      }

      var commands = hasProject ? visibleCommandsForProject(config, projectPath) : [];
      var runnerByCommand = {};
      for (var runnerIndex = 0; runnerIndex < runners.length; runnerIndex += 1) {
        var runner = runners[runnerIndex];
        if (runner !== null && runner !== undefined && typeof runner.commandId === "string") {
          runnerByCommand[runner.commandId] = runner;
        }
      }

      function titleOfCommand(commandId) {
        var command = findCommandOf(config, commandId);
        return command !== undefined && typeof command.title === "string" ? command.title : commandId;
      }

      var errorBar = error === null || error === undefined ? null : h("div", {
        className: "dshRunnerError",
        "data-dsh-runner-error": "1",
        role: "alert"
      },
        h("span", { className: "dshRunnerErrorText" }, "错误：" + messageOf(error)),
        h("button", {
          type: "button",
          className: "dshLimobCfgBtnGhost dshLimobCfgBtn",
          onClick: function () { setError(null); }
        }, "关闭"),
        errorDetailText(error) !== "" ? h("span", { className: "dshRunnerErrorDetail" }, errorDetailText(error)) : null);

      function renderRow(command) {
        var current = runnerByCommand[command.id];
        var status = current !== null && current !== undefined && typeof current.status === "string" ? current.status : "idle";
        var disabled = command.enabled === false;
        var active = status === "starting" || status === "running" || status === "stopping";
        var rowBusy = busy !== null;
        var declaredPorts = Array.isArray(command.ports) ? command.ports : [];
        var actualPorts = current !== null && current !== undefined && Array.isArray(current.actualPorts)
          ? current.actualPorts
          : [];
        var extraPorts = actualPorts.filter(function (port) {
          return declaredPorts.indexOf(port) === -1;
        });
        var missingPorts = actualPorts.length > 0
          ? declaredPorts.filter(function (port) {
              return actualPorts.indexOf(port) === -1;
            })
          : [];
        var meta = [];
        if (current !== null && current !== undefined && current.status === "running" && typeof current.startedAt === "number") {
          meta.push(h("span", { key: "uptime", className: "dshRunnerStatusText" }, "运行 " + formatUptime(Date.now() - current.startedAt)));
        }
        if (current !== null && current !== undefined && (current.status === "exited" || current.status === "failed")
          && typeof current.exitCode === "number") {
          meta.push(h("span", { key: "exit", className: "dshRunnerStatusText" }, "退出码 " + current.exitCode));
        }
        return h("div", {
          key: command.id,
          className: "dshRunnerRow",
          "data-command-id": command.id,
          "data-status": status,
          "data-selected": selectedId === command.id ? "true" : "false",
          "data-disabled": disabled ? "true" : "false",
          onClick: function () { setSelectedId(command.id); }
        },
          h("span", { className: "dshRunnerDot", "data-status": status, title: runnerStatusText(status) }),
          h("div", { className: "dshRunnerRowMain" },
            h("div", { className: "dshRunnerRowTitle" },
              h("span", { className: "dshRunnerRowTitleText", title: String(command.title) }, String(command.title)),
              command.scope === "global" ? h("span", { className: "dshLimobTag" }, "全局") : null,
              disabled ? h("span", { className: "dshLimobTag" }, "已停用") : null,
              h("span", { className: "dshRunnerStateText", "data-status": status }, runnerStatusText(status))),
            h("div", { className: "dshRunnerRowCmd", title: String(command.command) }, String(command.command)),
            h("div", { className: "dshRunnerRowMeta" },
              declaredPorts.map(function (port) {
                return h("span", { key: "declared-" + String(port), className: "dshRunnerPort", title: "声明端口 " + String(port) }, ":" + String(port));
              }),
              extraPorts.map(function (port) {
                return h("span", {
                  key: "actual-" + String(port),
                  className: "dshRunnerPort dshRunnerPortWarn",
                  title: "实际监听端口（未在声明 ports 中）"
                }, "实际 :" + String(port));
              }),
              missingPorts.map(function (port) {
                return h("span", {
                  key: "missing-" + String(port),
                  className: "dshRunnerPort dshRunnerPortWarn",
                  title: "声明端口当前未被本命令的进程监听"
                }, "未绑定 :" + String(port));
              }),
              meta)),
          h("div", { className: "dshRunnerRowActions" },
            h("button", {
              type: "button",
              className: "dshRunnerMiniBtn",
              "data-action": "start",
              disabled: rowBusy || disabled || active,
              onClick: function (event) {
                event.stopPropagation();
                runAction("start", command.id);
              }
            }, "启动"),
            h("button", {
              type: "button",
              className: "dshRunnerMiniBtn",
              "data-action": "stop",
              disabled: rowBusy || current === null || current === undefined || !active,
              onClick: function (event) {
                event.stopPropagation();
                runAction("stop", command.id);
              }
            }, "停止"),
            h("button", {
              type: "button",
              className: "dshRunnerMiniBtn",
              "data-action": "restart",
              disabled: rowBusy || disabled,
              onClick: function (event) {
                event.stopPropagation();
                runAction("restart", command.id);
              }
            }, "重启")));
      }

      var selectedCommand = selectedId === null || selectedId === undefined ? undefined : findCommandOf(config, selectedId);
      var selectedTitle = selectedCommand !== undefined && typeof selectedCommand.title === "string"
        ? selectedCommand.title
        : (selectedId === null || selectedId === undefined ? "" : String(selectedId));
      var logText = logState !== null && logState !== undefined && typeof logState.text === "string" ? stripAnsi(logState.text) : "";
      var logBytes = logState !== null && logState !== undefined && typeof logState.bytes === "number" ? logState.bytes : 0;
      var logTruncated = logState !== null && logState !== undefined && logState.truncated === true;
      var logMeta = formatBytes(logBytes) + (logTruncated ? " · 仅显示末尾 " + formatBytes(LOG_MAX_BYTES) : "");

      var logPane = h("div", { className: "dshRunnerLogPane" },
        h("div", { className: "dshRunnerLogHead" },
          h("span", { className: "dshRunnerLogTitle", title: selectedTitle },
            selectedTitle === "" ? "日志" : selectedTitle + " · 日志"),
          h("span", { className: "dshRunnerLogMeta" }, logMeta),
          h("button", {
            type: "button",
            className: "dshRunnerMiniBtn",
            disabled: selectedId === null || selectedId === undefined || busy !== null,
            onClick: clearLog
          }, "清空日志"),
          h("button", {
            type: "button",
            className: "dshRunnerMiniBtn",
            disabled: logText === "",
            onClick: copyLog
          }, copied ? "已复制" : "复制")),
        h("pre", {
          className: "dshRunnerPre",
          "data-dsh-runner-log": "1",
          ref: logRef,
          onScroll: handleLogScroll
        }, selectedId === null || selectedId === undefined
          ? "点左侧命令行查看运行日志。"
          : (logText === "" ? "（暂无日志）" : logText)));

      var unmanaged = [];
      for (var diagIndex = 0; diagIndex < diagnose.length; diagIndex += 1) {
        var entry = diagnose[diagIndex];
        if (entry !== null && entry !== undefined && entry.listening === true
          && entry.occupant !== null && entry.occupant !== undefined && entry.occupant.managed !== true) {
          unmanaged.push(entry);
        }
      }

      var diagnoseSection = unmanaged.length === 0 ? null : h("div", { className: "dshRunnerDiag" },
        h("div", { className: "dshRunnerDiagTitle" }, "端口诊断：检测到未托管的端口占用"),
        unmanaged.map(function (item) {
          var occupant = item.occupant;
          var windowText = occupant !== undefined && typeof occupant.windowTitle === "string" && occupant.windowTitle !== ""
            ? " · 窗口：" + occupant.windowTitle
            : "";
          var chain = formatProcessChain(occupant);
          var ownerText = "端口 " + String(item.port) + " 被 " + occupantSummary(occupant) + " 占用"
            + (typeof item.title === "string" && item.title !== "" ? "（期望命令：" + item.title + "）" : "")
            + windowText
            + (chain !== "" ? " · 父进程：" + chain : "")
            + (occupant !== undefined && typeof occupant.commandLine === "string" && occupant.commandLine !== "" ? " · " + occupant.commandLine : "");
          return h("div", { key: "diag-" + String(item.port), className: "dshRunnerDiagRow" },
            h("span", { className: "dshRunnerDiagText" }, ownerText),
            h("button", {
              type: "button",
              className: "dshRunnerMiniBtn",
              "data-action": "kill-port",
              "data-port": item.port,
              disabled: busy !== null,
              onClick: function () { handleKillPort(item); }
            }, "结束占用进程"));
        }));

      function renderConflictEntry(item, index) {
        var occupant = item !== null && item !== undefined && item.occupant !== null && item.occupant !== undefined
          ? item.occupant
          : undefined;
        var windowTitle = occupant !== undefined && typeof occupant.windowTitle === "string" ? occupant.windowTitle : "";
        var commandLine = occupant !== undefined && typeof occupant.commandLine === "string" ? occupant.commandLine : "";
        var chain = formatProcessChain(occupant);
        var children = formatProcessChildren(occupant);
        var managed = occupant !== undefined && occupant.managed === true;
        return h("div", { key: "conflict-" + String(index), className: "dshRunnerConflictEntry", "data-port": item.port },
          h("div", { className: "dshRunnerConflictHead" },
            h("span", { className: "dshRunnerConflictPort" }, "端口 " + String(item.port)),
            h("span", null, occupantSummary(occupant)),
            h("span", { className: "dshRunnerConflictTag" }, managed ? "本插件托管" : "外部进程"),
            occupant !== undefined && occupant.related === true
              ? h("span", { className: "dshRunnerConflictTag" }, "疑似同项目旧实例")
              : null,
            windowTitle !== "" ? h("span", { className: "dshRunnerConflictTag", title: windowTitle }, "窗口：" + windowTitle) : null),
          managed && occupant !== undefined
            ? h("div", { className: "dshRunnerConflictMeta" },
                "该端口由已托管命令「" + String(occupant.runnerTitle === undefined ? occupant.runnerCommandId : occupant.runnerTitle) + "」占用，确认后将先停止该命令")
            : null,
          commandLine !== "" ? h("div", { className: "dshRunnerConflictCode", title: commandLine }, commandLine) : null,
          chain !== "" ? h("div", { className: "dshRunnerConflictMeta" }, "父进程链：" + chain) : null,
          children !== "" ? h("div", { className: "dshRunnerConflictMeta" }, "子进程：" + children) : null);
      }

      var conflictDialog = conflict === null || conflict === undefined ? null : h("div", {
        className: "dshRunnerDialogBackdrop",
        onMouseDown: function (event) {
          if (event.target === event.currentTarget && !conflictBusy) setConflict(null);
        }
      },
        h("div", { className: "dshRunnerDialog", "data-dsh-runner-conflict": "1" },
          h("div", { className: "dshRunnerDialogHead" }, "端口被占用"),
          h("div", { className: "dshRunnerDialogSub" },
            conflict.kind === "port-mismatch"
              ? "「" + titleOfCommand(conflict.commandId) + "」未能绑定声明端口，本次启动已终止"
                + (Array.isArray(conflict.actualPorts) && conflict.actualPorts.length > 0
                  ? "（实际绑定了 " + conflict.actualPorts.map(String).join("、") + "）"
                  : "")
                + "。处理以下占用后可重试启动。"
              : "启动「" + titleOfCommand(conflict.commandId) + "」需要先处理以下端口占用。确认后会结束外部占用进程 / 停止对应托管命令，并自动重试启动。"),
          (Array.isArray(conflict.ports) ? conflict.ports : []).map(renderConflictEntry),
          conflictError !== null ? h("div", { className: "dshRunnerDialogError", "data-dsh-runner-error": "1" },
            messageOf(conflictError) + (errorDetailText(conflictError) !== "" ? " · " + errorDetailText(conflictError) : "")) : null,
          conflictBusy ? h("div", { className: "dshRunnerDialogBusy" }, "正在处理端口占用并重试启动…") : null,
          h("div", { className: "dshRunnerDialogActions" },
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn",
              "data-action": "cancel-conflict",
              disabled: conflictBusy,
              onClick: function () { if (!conflictBusy) setConflict(null); }
            }, "取消"),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn dshLimobCfgBtnPrimary",
              "data-action": "kill-and-start",
              disabled: conflictBusy,
              onClick: resolveConflict
            }, conflictBusy ? "处理中…" : "结束占用进程并启动"))));

      var editorModal = !editorOpen ? null : h("div", {
        className: "dshLimobCfgModalBackdrop",
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) setEditorOpen(false);
        }
      },
        h("div", { className: "dshLimobCfgModal" },
          h("div", { className: "dshLimobCfgH", style: { marginBottom: "10px" } },
            h("span", null, "dsh-runner · 命令配置"),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn",
              onClick: function () { setEditorOpen(false); }
            }, "关闭")),
          h(ConfigEditor, {
            currentProjectPath: projectPath,
            workspaces: workspaceOptionsFrom(props !== undefined ? props.useWorkspaces : undefined)
          })));

      if (!hasProject) {
        return h("div", { className: "dshRunnerPage", "data-dsh-runner-page": "1" },
          h("div", { className: "dshLimobPageHead" },
            h("div", null,
              h("div", { className: "dshLimobPageTitle" }, "运行"),
              h("div", { className: "dshLimobPageSub" }, "项目运行面板：启停命令、查看日志、诊断端口")),
            h("span", { className: "dshLimobPageVersion" }, "v" + PLUGIN_VERSION)),
          h("div", { className: "dshRunnerEmpty" }, "请先进入一个项目会话"),
          errorBar,
          editorModal);
      }

      return h("div", { className: "dshRunnerPage", "data-dsh-runner-page": "1" },
        h("div", { className: "dshRunnerHead" },
          h("div", { className: "dshRunnerHeadMain" },
            h("span", { className: "dshRunnerTitle" }, "运行"),
            h("span", { className: "dshRunnerProject", title: projectPath }, projectPath)),
          h("div", { className: "dshRunnerToolbar" },
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn",
              disabled: busy !== null,
              onClick: runStartAll
            }, "启动全部"),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn",
              disabled: busy !== null,
              onClick: runStopAll
            }, "停止全部"),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn",
              disabled: busy !== null,
              onClick: refresh
            }, busy === "__refresh__" ? "刷新中…" : "刷新"),
            h("button", {
              type: "button",
              className: "dshLimobCfgBtn dshLimobCfgBtnPrimary",
              onClick: function () { setEditorOpen(true); }
            }, "管理命令"))),
        errorBar,
        h("div", { className: "dshRunnerBody" },
          commands.length === 0
            ? h("div", { className: "dshRunnerList" },
                h("div", { className: "dshRunnerEmpty" },
                  "当前项目还没有命令。点右上角「管理命令」新增，或在「设置 → dsh-runner」里编辑。"))
            : h("div", { className: "dshRunnerList" }, commands.map(renderRow)),
          logPane),
        diagnoseSection,
        conflictDialog,
        editorModal);
    }

    // =====================================================================
    // 十四、输入框下方的「运行」按钮（conversation.composer.dock）
    // =====================================================================
    function LimobComposerButton(props) {
      var config = useConfig();
      var sessionId = props !== undefined && props.sessionId !== undefined
        ? props.sessionId
        : (props !== undefined && props.session !== undefined && props.session !== null ? props.session.sessionId : undefined);
      var projectPath = useProjectPath(props !== undefined ? props.useWorkspaces : undefined, sessionId);
      var hasProject = projectPath !== undefined && projectPath !== null && projectPath !== "";

      var menuPair = react.useState(false);
      var menuOpen = menuPair[0];
      var setMenuOpen = menuPair[1];
      var menuPosPair = react.useState(null);
      var menuPos = menuPosPair[0];
      var setMenuPos = menuPosPair[1];
      var busyPair = react.useState(null);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var statusPair = react.useState(null);
      var status = statusPair[0];
      var setStatus = statusPair[1];
      var runnersPair = react.useState([]);
      var runners = runnersPair[0];
      var setRunners = runnersPair[1];
      var rootRef = react.useRef(null);
      var buttonRef = react.useRef(null);

      var commands = config !== null && config !== undefined && Array.isArray(config.commands)
        ? visibleCommandsForProject(config, projectPath).filter(function (command) {
            return command.enabled !== false;
          })
        : [];

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
          var target = event.target;
          var inMenu = target !== null && target !== undefined && typeof target.closest === "function"
            && target.closest(".dshLimobRunMenu") !== null;
          if (!inMenu && root !== null && root !== undefined && !root.contains(target)) setMenuOpen(false);
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

      async function refreshRunners() {
        if (!hasProject) {
          setRunners([]);
          return;
        }
        try {
          var value = await rpc("project/status", { projectPath: projectPath });
          setRunners(value !== null && value !== undefined && Array.isArray(value.runners) ? value.runners : []);
        } catch (statusError) {
          setStatus({ phase: "error", text: "读取进程状态失败：" + messageOf(statusError) });
        }
      }

      function toggleMenu() {
        if (!menuOpen) {
          // AI 可能刚改过配置，打开菜单先读一次 Host 配置。
          loadConfig().catch(function (loadError) {
            setStatus({ phase: "error", text: "读取配置失败：" + messageOf(loadError) });
          });
          refreshRunners();
          try {
            var rect = buttonRef.current !== null && buttonRef.current !== undefined
              ? buttonRef.current.getBoundingClientRect()
              : null;
            var width = typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 1280;
            var height = typeof window !== "undefined" && typeof window.innerHeight === "number" ? window.innerHeight : 800;
            if (rect !== null) {
              var menuWidth = Math.min(400, width - 16);
              var left = Math.min(Math.max(8, rect.left), Math.max(8, width - menuWidth - 8));
              setMenuPos({ left: left, bottom: height - rect.top + 8, maxHeight: Math.max(160, rect.top - 24) });
            } else {
              setMenuPos(null);
            }
          } catch (_error) {
            setMenuPos(null);
          }
        }
        setMenuOpen(!menuOpen);
      }

      async function runAction(action, command) {
        if (busy !== null) return;
        if (!hasProject) {
          setStatus({ phase: "error", text: "请先进入一个项目会话" });
          return;
        }
        var label = action === "start" ? "启动" : action === "stop" ? "停止" : "重启";
        setBusy(command.id);
        setStatus({ phase: "starting", text: "正在" + label + "：" + command.title });
        try {
          var endpoint = action === "start" ? "project/start" : action === "stop" ? "project/stop" : "project/restart";
          var value = await rpc(endpoint, { projectPath: projectPath, commandId: command.id });
          if (value !== null && value !== undefined && Array.isArray(value.runners)) setRunners(value.runners);
          setStatus({ phase: action === "stop" ? "idle" : "running", text: "已" + label + "：" + command.title });
        } catch (actionError) {
          setStatus({ phase: "error", text: label + "失败：" + messageOf(actionError) });
        } finally {
          setBusy(null);
        }
      }

      if (!uiVisibleOf(config)) return null;

      var runnerByCommand = {};
      for (var runnerIndex = 0; runnerIndex < runners.length; runnerIndex += 1) {
        var runner = runners[runnerIndex];
        if (runner !== null && runner !== undefined && typeof runner.commandId === "string") {
          runnerByCommand[runner.commandId] = runner;
        }
      }

      function renderMenuRow(command) {
        var current = runnerByCommand[command.id];
        var rowStatus = current !== null && current !== undefined && typeof current.status === "string" ? current.status : "idle";
        var rowActive = rowStatus === "starting" || rowStatus === "running" || rowStatus === "stopping";
        return h("div", { key: command.id, className: "dshLimobRunRow" },
          h("span", { className: "dshLimobRunRowMain" },
            h("span", { className: "dshLimobRunItemTitle" }, command.title),
            h("span", { className: "dshLimobRunItemCmd" },
              runnerStatusText(rowStatus) + " · " + String(command.command))),
          h("span", { className: "dshLimobRunRowActions" },
            h("button", {
              type: "button",
              className: "dshRunnerMiniBtn",
              "data-action": "start",
              disabled: busy !== null || rowActive,
              onClick: function () { runAction("start", command); }
            }, "启动"),
            h("button", {
              type: "button",
              className: "dshRunnerMiniBtn",
              "data-action": "stop",
              disabled: busy !== null || !rowActive,
              onClick: function () { runAction("stop", command); }
            }, "停止"),
            h("button", {
              type: "button",
              className: "dshRunnerMiniBtn",
              "data-action": "restart",
              disabled: busy !== null,
              onClick: function () { runAction("restart", command); }
            }, "重启")));
      }

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

      var menuElement = menuOpen
        ? h("div", { className: "dshLimobRunMenu", style: menuStyle, role: "menu" },
            h("div", { className: "dshLimobRunMenuTitle" },
              h("span", null, "运行命令"),
              h("span", null, hasProject ? String(projectPath) : "当前会话")),
            commands.length === 0
              ? h("div", { className: "dshLimobRunEmpty" },
                  hasProject
                    ? "当前项目没有可用命令：到「设置 → dsh-runner」或左侧「运行 → 管理命令」里添加。"
                    : "请先进入一个项目会话。")
              : commands.map(renderMenuRow),
            h("div", { className: "dshLimobRunSep" }),
            h("div", { className: "dshLimobRunHint" }, "完整面板见左侧「运行」"))
        : null;

      // 菜单 portal 到 body：避免输入框容器的 overflow / stacking context 裁切。
      var menu = menuElement;
      if (menuElement !== null && reactDom !== null && typeof reactDom.createPortal === "function"
        && typeof document !== "undefined" && document.body !== null) {
        menu = reactDom.createPortal(menuElement, document.body);
      }

      return h("div", { ref: rootRef, className: "dshLimobRunDock" },
        h("button", {
          ref: buttonRef,
          type: "button",
          className: "dshLimobRunBtn",
          "data-busy": busy !== null ? "true" : "false",
          title: "项目运行：启动/停止/重启（完整面板见左侧「运行」）",
          "aria-label": "运行",
          onClick: function () {
            if (busy !== null) return;
            toggleMenu();
          }
        },
          h("span", { "aria-hidden": "true" }, busy !== null ? "…" : "▶"),
          h("span", null, "运行")),
        status !== null ? h("span", {
          className: "dshLimobRunStatus",
          "data-phase": status.phase || "idle",
          title: status.text
        }, status.text) : null,
        menu);
    }

    // =====================================================================
    // 十五、注册
    // =====================================================================
    function registerSlot(ctx, slotName, options, component) {
      try {
        ctx.slots.inject(slotName, function () {
          return ctx.slots.register(options, component);
        });
      } catch (error) {
        logPluginError(ctx, "注册槽位失败（" + slotName + "）", error);
      }
    }

    function apply(ctx) {
      runtimeCtx = ctx;
      try {
        hostConnection = typeof ctx.get === "function" ? ctx.get("connection") : undefined;
      } catch (_error) {
        hostConnection = undefined;
      }
      // 左侧导航「运行」入口（图标）+ 完整运行面板。
      registerSlot(ctx, "sidebar.panellist", {
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 20,
        label: PANEL_LABEL
      }, RunnerPanelIcon);
      registerSlot(ctx, "main", { name: "main", key: PANEL_ID }, RunnerPage);
      // 输入框下方紧凑「▶ 运行」按钮（只做启停重启，不创建终端）。
      registerSlot(ctx, "conversation.composer.dock", {
        name: "conversation.composer.dock",
        id: "dsh-runner-run",
        order: 40
      }, LimobComposerButton);
      // 设置弹窗左侧新增「dsh-runner」页（命令编辑器）。
      registerSlot(ctx, "settings.section", {
        name: "settings.section",
        id: PANEL_ID,
        order: 60,
        label: PLUGIN_NAME
      }, LimobSettingsSection);
      // 插件详情页更新提示。
      registerSlot(ctx, "plugins.detail.badge", {
        name: "plugins.detail.badge",
        id: "dsh-runner-update",
        order: 100
      }, LimobUpdateBadge);
      registerSlot(ctx, "plugins.detail.section", {
        name: "plugins.detail.section",
        id: "dsh-runner-update",
        order: 100
      }, LimobUpdateSection);
    }

    exports.name = PLUGIN_NAME;
    exports.inject = ["slots", "connection"];
    exports.apply = apply;

    // 仅给离线测试/CI 用的纯函数入口；DSH loader 只读 name/inject/apply。
    exports.__test = {
      stripAnsi: stripAnsi,
      formatUptime: formatUptime,
      formatBytes: formatBytes,
      commandMatchesProject: commandMatchesProject,
      visibleCommandsForProject: visibleCommandsForProject,
      runnerStatusText: runnerStatusText,
      occupantSummary: occupantSummary,
      formatProcessChain: formatProcessChain,
      formatProcessChildren: formatProcessChildren
    };

    return module.exports;
  }
});
