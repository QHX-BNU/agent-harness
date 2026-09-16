// 配置层：所有可调参数集中在这里，全部支持环境变量覆盖。
// 没有任何第三方依赖，Node 18+ 直接跑。
import path from 'node:path';
import process from 'node:process';
import { sandboxDefaults } from './sandbox.js';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

/** lark-cli 的 JS 入口：Windows 上 npm 装的是 .cmd/.ps1 shim，直接 spawn 会失败，所以跑它的真身 */
const LARK_CLI_ENTRY =
  env.LARK_CLI_ENTRY ||
  path.join(env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

export const config = {
  // ---- 服务 ----
  port: num(env.PORT, 5175),
  host: env.HOST || '127.0.0.1',

  // ---- 工作区：所有文件工具的根目录，越界一律拒绝 ----
  workspace: path.resolve(env.WORKSPACE || process.cwd()),

  // ---- 模型（供应商/模型/key 的最终解析在 src/providers/index.js） ----
  // provider 可选值见 src/providers/presets.js（deepseek / openai / anthropic / qwen / ollama ...）
  provider: env.PROVIDER || 'mock',
  model: env.MODEL || '', // 留空则用该供应商预设的默认模型
  baseUrl: env.BASE_URL || '', // 留空则用预设端点
  apiKey: env.API_KEY || '', // 留空则按供应商专属变量找（DEEPSEEK_API_KEY / OPENAI_API_KEY ...）
  modelTimeoutMs: num(env.MODEL_TIMEOUT_MS, 120000),
  modelRetries: num(env.MODEL_RETRIES, 2),

  // ---- 策略 ----
  // auto: 只读工具直接放行，写/执行类自动放行
  // ask : 写/执行类需要前端点“允许”（默认，用于演示审批机制）
  // deny: 写/执行类一律拒绝
  approvalMode: env.APPROVAL_MODE || 'ask',
  approvalTimeoutMs: num(env.APPROVAL_TIMEOUT_MS, 120000),

  // ---- 预算 ----
  maxSteps: num(env.MAX_STEPS, 12), // 单轮最多几次模型往返
  maxHistoryChars: num(env.MAX_HISTORY_CHARS, 60000), // 上下文预算（按字符粗估）
  toolResultMaxChars: num(env.TOOL_RESULT_MAX_CHARS, 8000), // 单个工具结果上限，超出落盘
  shellTimeoutMs: num(env.SHELL_TIMEOUT_MS, 60000),

  // ---- 记忆 ----
  memoryEnabled: env.MEMORY_ENABLED !== '0',
  memoryTopK: num(env.MEMORY_TOP_K, 5), // 每轮自动召回条数
  memoryDir: path.resolve(env.MEMORY_DIR || '.memory'),
  // user.md / soul.md / preference.md 三块画像常驻注入，按字符预算截断
  memoryProfileEnabled: env.MEMORY_PROFILE_ENABLED !== '0',
  memoryProfileMaxChars: num(env.MEMORY_PROFILE_MAX_CHARS, 3000),

  // ---- 技能（技能包 = 目录 + SKILL.md，安装走 zip）----
  skillsEnabled: env.SKILLS_ENABLED !== '0',
  skillsDir: path.resolve(env.SKILLS_DIR || '.skills'),

  // ---- 子代理 / 工作流 ----
  maxAgentDepth: num(env.MAX_AGENT_DEPTH, 2), // 允许的委派深度
  maxConcurrentAgents: num(env.MAX_CONCURRENT_AGENTS, 3),
  workflowsDir: path.resolve(env.WORKFLOWS_DIR || 'workflows'),

  // ---- 沙箱：作用区域 / 权限 / 后端 ----
  // scope: workspace | home | custom | full      mode: write | readonly
  // backend: windows（免安装原生边界） | local（策略） | docker（命令容器隔离） | wsl（子系统）
  sandbox: sandboxDefaults(env),

  // ---- 持久化 ----
  sessionsDir: path.resolve(env.SESSIONS_DIR || '.sessions'),
  artifactsDir: path.resolve(env.ARTIFACTS_DIR || '.artifacts'),
  // 删除的会话先进回收站（默认 .sessions-trash），确认无误再彻底清空
  trashDir: path.resolve(env.TRASH_DIR || '.sessions-trash'),

  // ---- 飞书通道：群/私聊里 @ 机器人干活 ----
  // 走 lark-cli 的 WebSocket 长连接收事件，不需要公网回调地址
  feishu: {
    enabled: env.FEISHU_ENABLED === '1',
    // 启动 lark-cli 的方式：默认用 node 直接跑它的入口（Windows 上是 .cmd shim，直接 spawn 会失败）
    cliCommand: env.FEISHU_CLI_COMMAND || process.execPath,
    cliPrefix: env.FEISHU_CLI_ENTRY ? [path.resolve(env.FEISHU_CLI_ENTRY)] : [LARK_CLI_ENTRY],
    // lark-cli 的 profile：用独立 profile 绑机器人应用，就不会动到默认 profile（用户身份那套）
    profile: env.FEISHU_CLI_PROFILE || '',
    eventKey: env.FEISHU_EVENT_KEY || 'im.message.receive_v1',
    // 机器人自己的名字/open_id：用来判断有没有被 @
    botName: env.FEISHU_BOT_NAME || '',
    botAliases: (env.FEISHU_BOT_ALIASES || '').split(',').map((s) => s.trim()).filter(Boolean),
    botOpenId: env.FEISHU_BOT_OPEN_ID || '',
    requireMention: env.FEISHU_REQUIRE_MENTION !== '0',
    replyInThread: env.FEISHU_REPLY_IN_THREAD !== '0',
    // 飞书会话落到哪个工作区（也可以按 chat_id 指定：FEISHU_WORKSPACE_MAP='oc_xxx=wid,oc_yyy=wid2'）
    workspaceId: env.FEISHU_WORKSPACE_ID || 'default',
    workspaceByChat: Object.fromEntries(
      (env.FEISHU_WORKSPACE_MAP || '')
        .split(',')
        .map((s) => s.split('='))
        .filter((p) => p.length === 2)
        .map(([k, v]) => [k.trim(), v.trim()]),
    ),
    approvalMode: env.FEISHU_APPROVAL_MODE || 'auto', // 机器人没人可问，默认自动放行
    // 0 = 关掉跨群/跨会话查询（user_activity / session_list / session_read），只看得到当前会话
    crossGroup: env.FEISHU_CROSS_GROUP !== '0',
    // 私聊隔离：私聊会话永远不出现在别人的查询结果里，私聊里写的事实也不会进共享记忆
    privateIsolation: env.FEISHU_PRIVATE_ISOLATION !== '0',
    // 0 = 机器人完全不理会私聊（只服务群）
    allowP2p: env.FEISHU_ALLOW_P2P !== '0',
    progressAfterMs: num(env.FEISHU_PROGRESS_AFTER_MS, 15000),
    chunkSize: num(env.FEISHU_CHUNK_SIZE, 3000),
    maxRestarts: num(env.FEISHU_MAX_RESTARTS, 5),
  },
};

export function publicConfig() {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    hasApiKey: Boolean(config.apiKey),
    workspace: config.workspace,
    approvalMode: config.approvalMode,
    maxSteps: config.maxSteps,
    modelTimeoutMs: config.modelTimeoutMs,
    modelRetries: config.modelRetries,
    memoryEnabled: config.memoryEnabled,
    memoryTopK: config.memoryTopK,
    memoryProfileEnabled: config.memoryProfileEnabled,
    memoryProfileMaxChars: config.memoryProfileMaxChars,
    skillsEnabled: config.skillsEnabled,
    maxAgentDepth: config.maxAgentDepth,
    maxConcurrentAgents: config.maxConcurrentAgents,
    sandbox: config.sandbox,
  };
}
