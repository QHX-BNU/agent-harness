// 状态层：会话状态机 + 用量/成本聚合。
// harness 的「状态」不只是消息列表，还包括：这一轮跑到哪了、是空闲还是卡在审批、
// 花了多少 token、上一步为什么失败——这些必须是一等公民，否则前端和恢复能力都无从谈起。

export const STATUS = {
  IDLE: 'idle', // 空闲，可以接收新输入
  RUNNING: 'running', // 模型/工具正在跑
  AWAITING_APPROVAL: 'awaiting_approval', // 卡在人工审批
  ABORTED: 'aborted', // 被用户取消
  ERROR: 'error', // 上一轮失败
};

/** 模型单价（美元 / 100 万 token），用于粗略成本估算；找不到就显示 token 数 */
const PRICING = {
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'qwen-max': { in: 1.6, out: 6.4 },
  'qwen-plus': { in: 0.4, out: 1.2 },
};

export function createState({ provider = 'mock', model = '', approvalMode = 'ask' } = {}) {
  return {
    status: STATUS.IDLE,
    provider,
    model,
    approvalMode,
    steps: 0,
    turns: 0,
    requests: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    costUsd: 0,
    startedAt: null,
    endedAt: null,
    lastError: null,
    abortRequested: false,
    pendingApprovals: 0,
  };
}

export function setStatus(session, status, patch = {}) {
  const s = session.state || (session.state = createState());
  s.status = status;
  Object.assign(s, patch);
  if (status === STATUS.RUNNING && !s.startedAt) s.startedAt = Date.now();
  if ([STATUS.IDLE, STATUS.ABORTED, STATUS.ERROR].includes(status)) s.endedAt = Date.now();
  return s;
}

export function addUsage(session, usage, model) {
  if (!usage) return;
  const s = session.state || (session.state = createState());
  s.requests += 1;
  s.usage.prompt_tokens += usage.prompt_tokens || 0;
  s.usage.completion_tokens += usage.completion_tokens || 0;
  const price = PRICING[model || s.model];
  if (price) {
    s.costUsd +=
      ((usage.prompt_tokens || 0) / 1e6) * price.in + ((usage.completion_tokens || 0) / 1e6) * price.out;
    s.costUsd = Number(s.costUsd.toFixed(6));
  }
  return s;
}

export function isBusy(session) {
  return [STATUS.RUNNING, STATUS.AWAITING_APPROVAL].includes(session?.state?.status);
}

/** 列表用的精简视图 */
export function publicSession(session) {
  const s = session.state || {};
  return {
    id: session.id,
    title: session.title || '未命名会话',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: s.status || STATUS.IDLE,
    provider: session.provider,
    model: session.model,
    messages: session.messages.length,
    usage: s.usage || { prompt_tokens: 0, completion_tokens: 0 },
    costUsd: s.costUsd || 0,
    steps: s.steps || 0,
    turns: s.turns || 0,
    lastError: s.lastError || null,
    parentId: session.parentId || null,
    kind: session.kind || 'chat',
  };
}

export const modelPricing = (model) => PRICING[model] || null;
