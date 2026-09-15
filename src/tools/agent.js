// 委派工具：把一件独立的事丢给子代理去做，主对话只拿回结论。
// 上下文隔离是重点——子代理看不到主对话，必须自包含地描述任务。
export const task = {
  name: 'task',
  description:
    '把一个自包含的子任务委派给子代理（独立上下文，看不到当前对话），只返回它的最终结论。' +
    '适合：独立的调研/审查/批量改写。不适合：需要和用户来回确认的事。',
  category: 'agent',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '3-5 个字的短描述，用于展示' },
      prompt: { type: 'string', description: '完整、自包含的任务描述（子代理看不到当前对话）' },
      model: { type: 'string', description: '可选：给子代理换一个模型' },
      max_steps: { type: 'integer', description: '可选：子代理的最大步数，默认 8' },
    },
    required: ['prompt'],
  },
  async run({ description, prompt, model, max_steps }, ctx) {
    if (!ctx.agents) throw new Error('当前环境没有启用子代理能力');
    const result = await ctx.agents.run({
      description: description || '子任务',
      prompt,
      model,
      maxSteps: Number(max_steps) || 8,
      parent: ctx.session,
      depth: (ctx.depth || 0) + 1,
      emit: ctx.emit,
      signal: ctx.signal,
      sandbox: ctx.sandbox,
      modelConfig: ctx.modelConfig, // 继承本次请求的 key/端点，否则前端填的 key 会丢
      // 隐私开关要跟着子代理走：父会话禁用跨群查询时，子代理也不能绕过
      crossGroup: ctx.config?.crossGroup,
    });
    return result.summary;
  },
};

export const agentTools = [task];
