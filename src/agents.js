// 子代理：把一个自包含任务丢进独立上下文里跑，只把结论带回主对话。
// 关键约束：深度限制（防止无限递归）、并发限制、子代理默认自动审批（它没有用户可问）。
import { runTurn } from './loop.js';
import { Policy } from './policy.js';
import { STATUS, setStatus } from './state.js';

export function createAgentRunner({ config, store, tools, memory, createProvider, policy }) {
  let running = 0;
  const waiters = [];

  const acquire = () =>
    new Promise((resolve) => {
      if (running < config.maxConcurrentAgents) {
        running++;
        return resolve();
      }
      waiters.push(resolve);
    });

  const release = () => {
    running--;
    const next = waiters.shift();
    if (next) {
      running++;
      next();
    }
  };

  return {
    get running() {
      return running;
    },

    async run({
      description = '子任务',
      prompt,
      model,
      maxSteps = 8,
      parent,
      depth = 1,
      emit,
      signal,
      onDelta,
      sandbox = null,
      modelConfig = null,
    }) {
      if (!prompt || !String(prompt).trim()) throw new Error('子任务 prompt 不能为空');
      if (depth > config.maxAgentDepth) {
        throw new Error(`子代理递归深度超过上限 ${config.maxAgentDepth}（子代理不能再无限制地派生下去）`);
      }

      // 凭证来源优先级：本次请求的 modelConfig（前端设置里填的 key）> 父会话记录 > 服务端环境变量。
      // 少了第一项，子代理就会退回环境变量——前端配的 key 等于没配，这正是必须继承的原因。
      const cred = modelConfig || {};
      const providerId = cred.provider || parent?.provider || config.provider;
      const modelId = model || cred.model || parent?.model || config.model;
      const credentialSource = cred.apiKey ? 'request' : cred.baseUrl ? 'request(baseUrl only)' : 'server-env';

      await acquire();
      const child = store.create({
        provider: providerId,
        model: modelId,
        approvalMode: 'auto', // 子代理无人可问，写/执行类工具自动放行（父级的策略已放行委派本身）
        title: `[子代理] ${description}`,
        kind: 'subagent',
        parentId: parent?.id || null,
        // 子代理归属同一个工作区（文件工具与 workspace 级记忆都跟着走）
        workspaceId: parent?.workspaceId || 'default',
        workspacePath: parent?.workspacePath || null,
      });

      let provider;
      try {
        provider = createProvider({
          provider: providerId,
          model: modelId,
          baseUrl: cred.baseUrl, // undefined 时自动回落环境变量 / 厂商预设
          apiKey: cred.apiKey,
          timeoutMs: config.modelTimeoutMs,
          retries: config.modelRetries,
        });
        child.model = provider.model;
        child.provider = provider.id;
        store.save(child);
      } catch (err) {
        release();
        throw new Error(
          `子代理无法建立模型连接（${providerId} · ${modelId}）：${err.message}\n` +
            `凭证来源：${credentialSource}。子代理会继承本次请求的 provider/model/baseUrl/apiKey，` +
            `若 key 只配在环境变量里，请设置对应的 *_API_KEY。`,
        );
      }

      emit?.({
        type: 'subagent_start',
        agentId: child.id,
        description,
        model: child.model,
        provider: child.provider,
        credentialSource,
        depth,
      });

      // 增量合并缓冲：攒够一定长度或遇到结构化事件时才往父 trace 里写一条
      const DELTA_FLUSH_CHARS = 400;
      let deltaBuf = { kind: '', text: '', count: 0 };
      const flushDelta = () => {
        if (!deltaBuf.text) return;
        emit?.({
          type: 'subagent_event',
          agentId: child.id,
          description,
          depth,
          ts: Date.now(),
          event: { type: deltaBuf.kind, text: deltaBuf.text, merged: deltaBuf.count },
        });
        deltaBuf = { kind: '', text: '', count: 0 };
      };

      const childEmit = (ev) => {
        // 子代理的事件要做两件事：
        //   1) 流式增量转给父级（工作流用它做实时进度）
        //   2) 结构化事件以 subagent_event 信封嵌进父 trace —— 父 trace 才是完整的执行记录
        // 增量会先在本地攒起来再合并发出，避免几百条 delta 把父 trace 淹掉。
        if (ev.type === 'assistant_delta' || ev.type === 'reasoning_delta') {
          onDelta?.({ type: ev.type, text: ev.text });
          if (deltaBuf.kind && deltaBuf.kind !== ev.type) flushDelta();
          deltaBuf.kind = ev.type;
          deltaBuf.text += ev.text;
          deltaBuf.count += 1;
          if (deltaBuf.text.length >= DELTA_FLUSH_CHARS) flushDelta();
          return;
        }
        flushDelta();
        emit?.({
          type: 'subagent_event',
          agentId: child.id,
          description,
          depth,
          ts: Date.now(),
          event: ev,
        });
      };

      try {
        await runTurn({
          session: child,
          userText: String(prompt),
          provider,
          tools,
          policy: new Policy('auto', policy.broker),
          store,
          emit: childEmit,
          config: { ...config, maxSteps },
          signal,
          depth,
          memory,
          sandbox, // 子代理继承父级的作用区域，不能自己放宽
          agents: null, // 子代理不能再用 task 工具（深度限制已在上层保证，这里再收一道）
        });
      } finally {
        flushDelta(); // 收尾：把没攒满的增量也写进父 trace
        release();
      }

      const assistant = child.messages.filter((m) => m.role === 'assistant').at(-1);
      const summary = (assistant?.content || '').trim() || '(子代理没有产出内容)';
      const toolCalls = child.messages.filter((m) => m.role === 'tool').length;

      setStatus(child, STATUS.IDLE);
      store.save(child);

      emit?.({
        type: 'subagent_done',
        agentId: child.id,
        description,
        steps: child.state.steps,
        toolCalls,
        usage: child.state.usage,
        summary: summary.slice(0, 300),
      });

      return {
        summary,
        sessionId: child.id,
        steps: child.state.steps,
        toolCalls,
        usage: child.state.usage,
        status: child.state.status,
      };
    },
  };
}
