/**
 * dsh-limob-runner 的 Host 半体（Node 侧）。
 *
 * 本插件的全部功能都在浏览器半体 client.js 里完成：它调用 DSH 客户端已挂载的
 * remote.terminal 命名空间（Host 端由 @deepseek-ai/dsh-api-terminal-controller 提供）
 * 创建 PTY、通过 terminal/attach 流写入命令，再让右侧栏内置的 terminal 页签渲染输出。
 *
 * Host 侧故意保持为空插件：
 * 1. 不注册工具、不改系统提示词、不抢任何服务，避免影响 DSH 正常聊天；
 * 2. DSH loader 需要每个 entry 有一个可导入的插件对象，因此这里只导出 name/apply。
 *
 * 如果将来需要「由模型调用」的能力（例如让 Agent 也能一键跑 Limob 命令），
 * 应另建一个独立工具包，而不是把副作用塞进这个纯 UI 插件里。
 */

/** loader 行身份（与 package.json 的 name、cordis.patch.yml 的 name 保持一致）。 */
export const name = "dsh-limob-runner";

/** 不依赖任何 Host 服务。 */
export const inject = [];

/** 空实现：插件加载成功即代表 Host 半体就绪。 */
export function apply() {
  // 有意为空：真正的逻辑在 client.js（浏览器侧）。
}
