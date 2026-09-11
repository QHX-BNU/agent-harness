// 配置层：所有可调参数集中在这里，全部支持环境变量覆盖。
// 没有任何第三方依赖，Node 18+ 直接跑。
import path from 'node:path';
import process from 'node:process';
import { sandboxDefaults } from './sandbox.js';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

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

  // ---- 子代理 / 工作流 ----
  maxAgentDepth: num(env.MAX_AGENT_DEPTH, 2), // 允许的委派深度
  maxConcurrentAgents: num(env.MAX_CONCURRENT_AGENTS, 3),
  workflowsDir: path.resolve(env.WORKFLOWS_DIR || 'workflows'),

  // ---- 沙箱：作用区域 / 权限 / 后端 ----
  // scope: workspace | home | custom | full      mode: write | readonly
  // backend: local（策略沙箱） | docker | wsl（真隔离，需本机装好）
  sandbox: sandboxDefaults(env),

  // ---- 持久化 ----
  sessionsDir: path.resolve(env.SESSIONS_DIR || '.sessions'),
  artifactsDir: path.resolve(env.ARTIFACTS_DIR || '.artifacts'),
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
    maxAgentDepth: config.maxAgentDepth,
    maxConcurrentAgents: config.maxConcurrentAgents,
    sandbox: config.sandbox,
  };
}
