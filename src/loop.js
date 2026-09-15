// 控制循环：整个 harness 的心脏。
// 一轮 turn = 若干次「模型 → 工具 → 模型」往返，直到模型不再调用工具或触到预算上限。
//
// 与状态/记忆/子代理/工作流的接合点都在这里：
//   - 状态机：RUNNING → AWAITING_APPROVAL → RUNNING → IDLE/ERROR/ABORTED
//   - 记忆：每轮开始自动召回 top-K 注入系统提示；模型可用 memory_* 工具主动读写
//   - 工具：统一走注册表 + 策略，超长结果落盘
//   - 子代理/工作流：通过 ctx 注入，工具里直接调用
import { buildSystemPrompt, trimHistory, spillToolResult } from './context.js';
import { STATUS, setStatus, addUsage } from './state.js';

export async function runTurn({
  session,
  userText,
  provider,
  tools,
  policy,
  store,
  emit: outerEmit,
  config,
  signal,
  memory = null,
  agents = null,
  workflows = null,
  sandbox = null,
  modelConfig = null,
  depth = 0,
}) {
  // trace 由 loop 自己负责持久化：任何入口（HTTP / CLI / 子代理）跑一轮都会留下事件日志
  const emit = (ev) => {
    try {
      store.appendEvent?.(session.id, ev);
    } catch {
      /* 日志失败不影响主流程 */
    }
    outerEmit?.(ev);
  };

  const state = setStatus(session, STATUS.RUNNING, { steps: 0, lastError: null, abortRequested: false });
  state.turns += 1;
  store.append(session, { role: 'user', content: userText });
  emit({ type: 'state', status: state.status, sessionId: session.id });

  // ---- 记忆自动召回（只在主会话做，避免子代理重复消耗）----
  let memoryText = '';
  let memoryHits = [];
  if (memory && depth === 0) {
    try {
      const recalled = memory.recall(userText, {
        sessionId: session.id,
        topK: config.memoryTopK,
        workspaceId: session.workspaceId || 'default',
      });
      memoryText = recalled.text;
      memoryHits = recalled.hits.map((h) => ({ id: h.item.id, score: h.score, content: h.item.content.slice(0, 80) }));
      if (memoryText) emit({ type: 'memory_recall', hits: memoryHits });
    } catch (err) {
      emit({ type: 'error', message: `记忆召回失败（已忽略）：${err.message}` });
    }
  }

  // modelConfig：本次请求实际使用的模型凭证（provider/model/baseUrl/apiKey）。
  // 子代理与工作流必须复用它，否则会退回服务端环境变量——前端填的 key 就丢了。
  // workspaceId：会话所属工作区，决定 workspace 级记忆的读写范围。
  const ctx = {
    session,
    store,
    memory,
    agents,
    workflows,
    sandbox,
    modelConfig,
    emit,
    signal,
    config,
    depth,
    workspaceId: session.workspaceId || 'default',
  };

  let steps = 0;
  let reason = 'stop';
  let exhausted = true;

  try {
    for (steps = 1; steps <= config.maxSteps; steps++) {
      if (signal?.aborted) {
        reason = 'aborted';
        setStatus(session, STATUS.ABORTED);
        emit({ type: 'state', status: STATUS.ABORTED });
        exhausted = false;
        break;
      }
      state.steps = steps;
      emit({ type: 'step', step: steps, maxSteps: config.maxSteps });

      // ---- 1. 组装上下文 ----
      const system = buildSystemPrompt({
        workspace: config.workspace,
        workspaceName: config.workspaceName,
        tools: tools.enabled,
        approvalMode: session.approvalMode || config.approvalMode,
        model: session.model,
        memoryText,
        todos: session.todos,
      });
      const history = trimHistory(session.messages, config.maxHistoryChars);
      const messages = [{ role: 'system', content: system }, ...history];

      // ---- 2. 调模型（流式） ----
      let text = '';
      let reasoning = '';
      const calls = [];
      let finishReason = null;
      let usage = null;
      let usageEmitted = false;
      const emitUsage = (u) => {
        if (!u || usageEmitted) return;
        usage = u;
        usageEmitted = true;
        addUsage(session, u, session.model);
        emit({ type: 'usage', usage: u, total: state.usage, costUsd: state.costUsd });
      };

      for await (const ev of provider.stream({
        messages,
        tools: tools.specs,
        model: session.model,
        signal,
        onRetry: (info) => emit({ type: 'retry', ...info }),
      })) {
        if (ev.type === 'text_delta') {
          text += ev.text;
          emit({ type: 'assistant_delta', text: ev.text });
        } else if (ev.type === 'reasoning_delta') {
          reasoning += ev.text;
          emit({ type: 'reasoning_delta', text: ev.text });
        } else if (ev.type === 'tool_call') {
          calls.push(ev);
        } else if (ev.type === 'usage') {
          emitUsage(ev.usage);
        } else if (ev.type === 'done') {
          finishReason = ev.finishReason;
          emitUsage(ev.usage);
        }
      }

      // ---- 3. 落库 assistant 消息 ----
      store.append(session, {
        role: 'assistant',
        content: text,
        reasoning: reasoning || undefined,
        toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      });
      if (text) emit({ type: 'assistant_message', content: text });

      // ---- 4. 没有工具调用 → 这一轮结束 ----
      if (calls.length === 0) {
        reason = finishReason || 'stop';
        exhausted = false;
        break;
      }

      // ---- 5. 策略决策 ----
      const decisions = calls.map((c) => {
        const tool = tools.get(c.name);
        if (!tool) return { action: 'deny', reason: `未知工具 ${c.name}` };
        return policy.decide(tool, c.arguments);
      });
      const allAllow = decisions.every((d) => d.action === 'allow');

      const executeOne = async (call, decision) => {
        const tool = tools.get(call.name);
        emit({
          type: 'tool_call',
          id: call.id,
          name: call.name,
          args: call.arguments,
          readOnly: Boolean(tool?.readOnly),
          category: tool?.category,
          decision: decision.action,
        });

        if (decision.action === 'deny') {
          const content = `未执行：${decision.reason}`;
          emit({ type: 'tool_result', id: call.id, name: call.name, ok: false, content, ms: 0 });
          return { role: 'tool', toolCallId: call.id, name: call.name, content };
        }

        if (decision.action === 'ask') {
          state.pendingApprovals += 1;
          setStatus(session, STATUS.AWAITING_APPROVAL, { pendingApprovals: state.pendingApprovals });
          emit({ type: 'state', status: STATUS.AWAITING_APPROVAL });
          emit({
            type: 'approval_request',
            id: call.id,
            name: call.name,
            args: call.arguments,
            reason: decision.reason,
          });
          const approved = await policy.requestApproval({
            id: call.id,
            tool: call.name,
            args: call.arguments,
            reason: decision.reason,
          });
          state.pendingApprovals -= 1;
          setStatus(session, STATUS.RUNNING, { pendingApprovals: state.pendingApprovals });
          emit({ type: 'state', status: STATUS.RUNNING });
          emit({ type: 'approval_result', id: call.id, approved });
          if (!approved) {
            const content = '用户拒绝执行该工具调用。';
            emit({ type: 'tool_result', id: call.id, name: call.name, ok: false, content, ms: 0 });
            return { role: 'tool', toolCallId: call.id, name: call.name, content };
          }
        }

        const t0 = Date.now();
        const { ok, content } = await tools.execute(call.name, call.arguments, ctx);
        const { content: trimmed, artifact } = spillToolResult({
          store,
          sessionId: session.id,
          toolName: call.name,
          content,
          maxChars: config.toolResultMaxChars,
        });
        emit({
          type: 'tool_result',
          id: call.id,
          name: call.name,
          ok,
          content: trimmed,
          artifact,
          ms: Date.now() - t0,
        });
        return { role: 'tool', toolCallId: call.id, name: call.name, content: trimmed };
      };

      // 全是 allow → 并发；只要有一个要审批/被拒 → 串行，避免审批顺序错乱
      const results = allAllow
        ? await Promise.all(calls.map((c, i) => executeOne(c, decisions[i])))
        : await (async () => {
            const out = [];
            for (let i = 0; i < calls.length; i++) out.push(await executeOne(calls[i], decisions[i]));
            return out;
          })();

      for (const r of results) store.append(session, r);
      reason = finishReason || 'tool_calls';
    }

    if (exhausted && !signal?.aborted) {
      emit({ type: 'error', message: `达到最大步数 ${config.maxSteps}，强制结束本轮` });
      reason = 'max_steps';
    }
    if (signal?.aborted) {
      reason = 'aborted';
      setStatus(session, STATUS.ABORTED);
    } else if (reason === 'max_steps') {
      setStatus(session, STATUS.IDLE, { lastError: `达到最大步数 ${config.maxSteps}` });
    } else {
      setStatus(session, STATUS.IDLE);
    }
    store.save(session);
    emit({ type: 'state', status: state.status, usage: state.usage, costUsd: state.costUsd });
    emit({ type: 'done', steps: Math.min(steps, config.maxSteps), reason });
  } catch (err) {
    const message = err?.name === 'AbortError' ? '客户端断开，已取消' : err.message;
    setStatus(session, err?.name === 'AbortError' ? STATUS.ABORTED : STATUS.ERROR, { lastError: message });
    store.save(session);
    emit({ type: 'error', message, hint: err.hint || '' });
    emit({ type: 'state', status: state.status, lastError: message });
    emit({ type: 'done', steps, reason: err?.name === 'AbortError' ? 'aborted' : 'error' });
  }

  return { reason, steps, state };
}
