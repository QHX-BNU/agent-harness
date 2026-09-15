// Trace 层：把会话的事件流格式化成可读/可导出的形式。
// 三种出口：JSONL（原始事件，适合喂给脚本）、JSON（完整快照）、Markdown（人读的复盘）。
const ts = (t) => new Date(t || Date.now()).toISOString();

/** 单条事件的一句话摘要（终端、UI、Markdown 共用同一套措辞） */
export function summarizeEvent(ev) {
  const cut = (s, n = 120) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  switch (ev.type) {
    case 'session':
      return `会话 ${ev.sessionId} · ${ev.provider}/${ev.model} · 审批 ${ev.approvalMode}`;
    case 'model':
      return `${ev.provider} · ${ev.model} (${ev.protocol}) ${ev.baseUrl || ''}`;
    case 'state':
      return `状态 → ${ev.status}${ev.lastError ? ` · ${cut(ev.lastError, 80)}` : ''}${ev.costUsd ? ` · $${ev.costUsd}` : ''}`;
    case 'step':
      return `第 ${ev.step}/${ev.maxSteps} 次模型往返`;
    case 'assistant_delta':
      return cut(ev.text, 100);
    case 'reasoning_delta':
      return cut(ev.text, 100);
    case 'assistant_message':
      return cut(ev.content, 160);
    case 'tool_call':
      return `${ev.name}(${cut(JSON.stringify(ev.args ?? {}), 120)}) [${ev.decision}]`;
    case 'tool_result':
      return `${ev.name} ${ev.ok ? '成功' : '失败'} · ${ev.ms}ms · ${String(ev.content ?? '').length} 字符${ev.artifact ? ` · 产物 ${ev.artifact}` : ''}`;
    case 'approval_request':
      return `${ev.name} · ${ev.reason}`;
    case 'approval_result':
      return ev.approved ? '已允许' : '已拒绝';
    case 'retry':
      return `重试 #${ev.attempt}（${ev.waitMs}ms 后）· ${cut(ev.reason, 80)}`;
    case 'memory_recall':
      return `召回 ${ev.hits?.length || 0} 条：${(ev.hits || []).map((h) => `#${h.id}`).join(' ')}`;
    case 'memory':
      return `${ev.action} #${ev.item?.id} ${cut(ev.item?.content, 100)}`;
    case 'todos':
      return `${(ev.todos || []).filter((t) => t.status === 'completed').length}/${(ev.todos || []).length} 完成`;
    case 'subagent_start':
      return `${ev.agentId} · ${ev.description} · 深度 ${ev.depth}`;
    case 'subagent_done':
      return `${ev.agentId} · ${ev.steps} 步 · ${ev.toolCalls} 次工具调用`;
    case 'subagent_event': {
      // 嵌套事件：子代理的一条事件被摊平进父 trace，前面标出它属于哪个子代理
      const inner = ev.event || {};
      return `↳ [${ev.description || ev.agentId}] ${summarizeEvent(inner)}`;
    }
    case 'workflow_start':
      return `${ev.name} · ${(ev.phases || []).join(' → ')}`;
    case 'workflow_phase':
      return `${ev.index}/${ev.total} ${ev.phase}`;
    case 'workflow_step_start':
      return `${ev.phase} · ${ev.label}`;
    case 'workflow_step_done':
      return `${ev.phase} · ${ev.label} ${ev.ok === false ? '失败' : '完成'}`;
    case 'workflow_done':
      return `${ev.name} · ${ev.ok}/${ev.steps} 步 · ${ev.ms}ms`;
    case 'usage':
      return `${ev.usage?.prompt_tokens ?? '?'} in / ${ev.usage?.completion_tokens ?? '?'} out`;
    case 'done':
      return `${ev.steps} 步 · ${ev.reason}`;
    case 'error':
      return cut(ev.message, 160);
    default:
      return cut(JSON.stringify(ev), 140);
  }
}

/** 事件类型分组，用于 UI 上色 */
export const EVENT_GROUPS = {
  session: 'meta',
  model: 'meta',
  state: 'meta',
  step: 'flow',
  done: 'flow',
  retry: 'flow',
  error: 'error',
  assistant_delta: 'model',
  assistant_message: 'model',
  reasoning_delta: 'model',
  usage: 'model',
  tool_call: 'tool',
  tool_result: 'tool',
  approval_request: 'approval',
  approval_result: 'approval',
  memory: 'memory',
  memory_recall: 'memory',
  todos: 'plan',
  subagent_start: 'agent',
  subagent_done: 'agent',
  subagent_event: 'agent',
};

export const groupOf = (type) => EVENT_GROUPS[type] || (type.startsWith('workflow_') ? 'workflow' : 'other');

/** 原始 JSONL */
export const eventsToJsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');

/** 完整快照（会话 + 状态 + 消息 + 事件） */
export function sessionToBundle(session, events) {
  return {
    exportedAt: new Date().toISOString(),
    harness: 'mini-harness',
    session: {
      id: session.id,
      title: session.title,
      kind: session.kind,
      parentId: session.parentId,
      createdAt: ts(session.createdAt),
      updatedAt: ts(session.updatedAt),
      provider: session.provider,
      model: session.model,
      approvalMode: session.approvalMode,
      state: session.state,
      todos: session.todos,
    },
    messages: session.messages,
    events,
  };
}

const fence = (s, lang = '') => '```' + lang + '\n' + String(s ?? '') + '\n```';

/** 人读的复盘：对话 + 工具轨迹 + 事件表 */
export function sessionToMarkdown(session, events) {
  const st = session.state || {};
  const lines = [];

  lines.push(`# 会话 ${session.id}`);
  lines.push('');
  lines.push(`- 标题: ${session.title || '(未命名)'}`);
  lines.push(`- 模型: ${session.provider || '?'} · ${session.model || '?'}`);
  lines.push(`- 审批: ${session.approvalMode || '?'}`);
  lines.push(`- 状态: ${st.status || '?'}`);
  lines.push(`- 轮次 / 步数: ${st.turns || 0} / ${st.steps || 0}`);
  lines.push(`- tokens: ${st.usage?.prompt_tokens || 0} in / ${st.usage?.completion_tokens || 0} out`);
  lines.push(`- 估算成本: ${st.costUsd ? '$' + st.costUsd : '—'}`);
  lines.push(`- 创建: ${ts(session.createdAt)}`);
  lines.push(`- 导出: ${new Date().toISOString()}`);
  lines.push('');

  if (session.todos?.length) {
    lines.push('## 任务清单');
    lines.push('');
    const icon = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
    for (const t of session.todos) lines.push(`- ${icon[t.status] || '[ ]'} ${t.content}`);
    lines.push('');
  }

  lines.push('## 对话');
  lines.push('');
  let n = 0;
  for (const m of session.messages || []) {
    if (m.role === 'user') {
      lines.push(`### ${++n}. 用户`);
      lines.push('');
      lines.push(String(m.content ?? ''));
      lines.push('');
    } else if (m.role === 'assistant') {
      lines.push(`### ${++n}. 助手`);
      lines.push('');
      if (m.reasoning) {
        lines.push('<details><summary>思考过程</summary>');
        lines.push('');
        lines.push(fence(m.reasoning));
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
      if (m.content) {
        lines.push(String(m.content));
        lines.push('');
      }
      for (const tc of m.toolCalls || []) {
        lines.push(`- 调用 \`${tc.name}\`：\`${JSON.stringify(tc.arguments ?? {})}\``);
      }
      if (m.toolCalls?.length) lines.push('');
    } else if (m.role === 'tool') {
      const body = String(m.content ?? '');
      lines.push(`<details><summary>工具结果 · ${m.name} · ${body.length} 字符</summary>`);
      lines.push('');
      lines.push(fence(body.length > 4000 ? `${body.slice(0, 4000)}\n… [已截断]` : body));
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('## 事件轨迹');
  lines.push('');
  lines.push('> 子代理的事件以 `↳` 嵌在父 trace 里，缩进表示它发生在哪个子代理内部。');
  lines.push('');
  lines.push('| # | 时间 | 类型 | 摘要 |');
  lines.push('|---|---|---|---|');
  events.forEach((ev, i) => {
    const summary = summarizeEvent(ev).replace(/\|/g, '\\|');
    if (ev.type === 'subagent_event') {
      const inner = ev.event || {};
      lines.push(`| ↳ | ${ts(ev.ts)} | ↳ ${inner.type || 'event'} | ${summary} |`);
    } else {
      lines.push(`| ${i + 1} | ${ts(ev.ts)} | ${ev.type} | ${summary} |`);
    }
  });
  lines.push('');

  return lines.join('\n');
}
