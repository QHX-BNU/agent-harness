// 工作流工具：跑一个预定义的多阶段流程（阶段内并行、阶段间串行、结果用模板变量传递）。
export const runWorkflow = {
  name: 'run_workflow',
  description:
    '执行一个预定义工作流（多阶段 + 阶段内并行子代理）。用 workflow_list 查看有哪些可用。',
  category: 'workflow',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '工作流名称' },
      input: { type: 'string', description: '传给工作流的输入（会替换模板里的 {{input}}）' },
    },
    required: ['name', 'input'],
  },
  async run({ name, input }, ctx) {
    if (!ctx.workflows) throw new Error('当前环境没有启用工作流能力');
    const run = await ctx.workflows.run(name, {
      input,
      session: ctx.session,
      emit: ctx.emit,
      signal: ctx.signal,
      sandbox: ctx.sandbox,
      modelConfig: ctx.modelConfig, // 同上：工作流每一步都是子代理，凭证必须一起传下去
    });
    return run.summary;
  },
};

export const workflowList = {
  name: 'workflow_list',
  description: '列出可用的工作流及其阶段说明。',
  category: 'workflow',
  readOnly: true,
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const list = ctx.workflows?.list() || [];
    if (!list.length) return '没有可用的工作流';
    return list
      .map((w) => `- ${w.name}: ${w.description}\n  阶段: ${w.phases.map((p) => `${p.title}(${p.steps.length} 步)`).join(' → ')}`)
      .join('\n');
  },
};

export const workflowTools = [runWorkflow, workflowList];
