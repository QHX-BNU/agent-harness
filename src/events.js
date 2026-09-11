// 事件层：harness 内部的一切都通过事件流向外暴露（SSE / 控制台）。
// 这是可观测性的最小形态：谁能订阅事件，谁就能做 UI、日志、回放、计费。
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

/**
 * 创建一个 emitter：把内部事件同时送往 SSE 与终端。
 * @param {(ev: object) => void} sink 事件出口（例如 SSE 写函数）
 * @param {{log?: boolean, prefix?: string}} [opts]
 */
export function createEmitter(sink, opts = {}) {
  const { log = true, prefix = '' } = opts;
  return function emit(ev) {
    const e = { ts: Date.now(), ...ev };
    try {
      sink?.(e);
    } catch {
      /* 客户端可能已断开，忽略 */
    }
    if (log) console.log(prefix + format(e));
  };
}

function format(ev) {
  const c = COLORS;
  switch (ev.type) {
    case 'step':
      return `${c.dim}[step ${ev.step}/${ev.maxSteps}]${c.reset}`;
    case 'assistant_delta':
      return `${c.cyan}${ev.text}${c.reset}`;
    case 'reasoning_delta':
      return `${c.dim}${ev.text}${c.reset}`;
    case 'retry':
      return `${c.yellow}⟳ 重试 #${ev.attempt}（${ev.waitMs}ms 后）: ${ev.reason}${c.reset}`;
    case 'model':
      return `${c.dim}model: ${ev.provider} · ${ev.model}${c.reset}`;
    case 'tool_call':
      return `${c.yellow}→ tool ${ev.name}${c.reset} ${c.dim}${JSON.stringify(ev.args).slice(0, 200)}${c.reset}`;
    case 'approval_request':
      return `${c.yellow}? 等待审批 ${ev.name} (${ev.reason})${c.reset}`;
    case 'approval_result':
      return `${ev.approved ? c.green + '✓ 已允许' : c.red + '✗ 已拒绝'}${c.reset}`;
    case 'tool_result':
      return `${ev.ok ? c.green + '← 结果' : c.red + '← 失败'}${c.reset} ${ev.name} ${c.dim}${ev.ms}ms, ${String(ev.content).length} chars${c.reset}`;
    case 'usage':
      return `${c.dim}usage: ${JSON.stringify(ev.usage)}${c.reset}`;
    case 'state':
      return `${c.dim}state: ${ev.status}${ev.costUsd ? ` $${ev.costUsd}` : ''}${c.reset}`;
    case 'memory_recall':
      return `${c.dim}memory: 召回 ${ev.hits.length} 条 (${ev.hits.map((h) => `#${h.id}`).join(' ')})${c.reset}`;
    case 'memory':
      return `${c.green}memory ${ev.action}${c.reset} ${c.dim}#${ev.item?.id} ${String(ev.item?.content).slice(0, 60)}${c.reset}`;
    case 'todos':
      return `${c.dim}todos: ${ev.todos.filter((t) => t.status === 'completed').length}/${ev.todos.length} 完成${c.reset}`;
    case 'subagent_start':
      return `${c.cyan}⇢ 子代理 ${ev.agentId} 开始: ${ev.description}${c.reset}`;
    case 'subagent_done':
      return `${c.cyan}⇠ 子代理 ${ev.agentId} 结束 (${ev.steps} 步, ${ev.toolCalls} 次工具调用)${c.reset}`;
    case 'workflow_start':
      return `${c.cyan}▶ 工作流 ${ev.name}: ${ev.phases.join(' → ')}${c.reset}`;
    case 'workflow_phase':
      return `${c.dim}  阶段 ${ev.index}/${ev.total}: ${ev.phase}${c.reset}`;
    case 'workflow_step_start':
      return `${c.dim}    · ${ev.label} 开始${c.reset}`;
    case 'workflow_step_done':
      return `${ev.ok === false ? c.red : c.green}    · ${ev.label} 结束${c.reset}${c.dim} ${ev.steps ?? ''} 步${c.reset}`;
    case 'workflow_done':
      return `${c.cyan}◀ 工作流 ${ev.name} 完成 ${ev.ok}/${ev.steps} 步，${ev.ms}ms${c.reset}`;
    case 'sandbox':
      return `${c.dim}sandbox: ${ev.scopeLabel} · ${ev.modeLabel} · ${ev.backend} → ${(ev.roots || []).join(', ')}${c.reset}`;
    case 'sandbox_denied':
      return `${c.red}⛔ 沙箱拒绝 [${ev.rule}] ${ev.reason}${c.reset}`;
    case 'done':
      return `${c.dim}done (${ev.steps} step, ${ev.reason})${c.reset}`;
    case 'error':
      return `${c.red}error: ${ev.message}${c.reset}`;
    default:
      return `${c.dim}${ev.type}${c.reset}`;
  }
}
