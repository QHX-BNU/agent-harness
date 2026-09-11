// 计划工具：模型自己维护的任务清单。前端会把它渲染成实时进度面板。
export const todoWrite = {
  name: 'todo_write',
  description:
    '记录/更新当前任务的待办清单（整表覆盖）。多步任务开始前先列清单，每完成一项立即更新状态。' +
    '状态：pending / in_progress / completed。',
  category: 'plan',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整的待办列表（会替换旧列表）',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '待办内容' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run({ todos }, ctx) {
    if (!Array.isArray(todos)) throw new Error('todos 必须是数组');
    ctx.session.todos = todos.map((t) => ({
      content: String(t.content || ''),
      status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
    }));
    ctx.store.save(ctx.session);
    ctx.emit?.({ type: 'todos', todos: ctx.session.todos });
    const done = ctx.session.todos.filter((t) => t.status === 'completed').length;
    const icon = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
    return (
      `清单已更新（${done}/${ctx.session.todos.length} 完成）：\n` +
      ctx.session.todos.map((t) => `${icon[t.status]} ${t.content}`).join('\n')
    );
  },
};

export const planTools = [todoWrite];
