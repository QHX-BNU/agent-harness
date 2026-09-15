// 记忆工具：让模型自己决定「什么值得长期记住」。
import { CATEGORIES, SCOPES } from '../memory.js';

export const memoryAdd = {
  name: 'memory_add',
  description:
    '写入一条长期记忆。scope: global(所有会话可见) / workspace(仅本工作区) / session(仅本会话)。' +
    '只记「以后还用得上的事实或偏好」，不要记流水账。',
  category: 'memory',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要记住的内容，写成一句自包含的事实' },
      scope: { type: 'string', enum: SCOPES, description: '作用域，默认 session' },
      category: {
        type: 'string',
        enum: CATEGORIES,
        description: 'anchor=身份/基础事实, structure=流程方法, knowledge=事实, situation=具体场景, self=偏好反思',
      },
      importance: { type: 'number', description: '重要度 0~1，默认 0.6' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，便于检索' },
    },
    required: ['content'],
  },
  async run(args, ctx) {
    const item = ctx.memory.add({
      content: args.content,
      scope: args.scope || 'session',
      category: args.category || 'knowledge',
      importance: args.importance ?? 0.6,
      tags: args.tags || [],
      sessionId: ctx.session.id,
      workspaceId: ctx.workspaceId, // workspace 级记忆归属于当前会话所在的工作区
    });
    ctx.emit?.({ type: 'memory', action: 'add', item });
    return `已记住 #${item.id} [${item.scope}/${item.category} 重要度${item.importance}] ${item.content}`;
  },
};

export const memorySearch = {
  name: 'memory_search',
  description: '按语义相关度检索长期记忆（词元重叠 + 重要度 + 时效）。',
  category: 'memory',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索查询' },
      topK: { type: 'integer', description: '返回条数，默认 5' },
      include_session: { type: 'boolean', description: '是否包含本会话记忆，默认 true' },
    },
    required: ['query'],
  },
  async run({ query, topK = 5, include_session = true }, ctx) {
    const hits = ctx.memory.search({
      query,
      topK: Number(topK) || 5,
      sessionId: ctx.session.id,
      includeSession: include_session !== false,
      recordLoad: true,
      workspaceId: ctx.workspaceId,
    });
    if (!hits.length) return '没有找到相关记忆';
    return hits
      .map(({ item, score }) => `#${item.id} (${score}) [${item.scope}/${item.category}] ${item.content}`)
      .join('\n');
  },
};

export const memoryList = {
  name: 'memory_list',
  description: '列出记忆（可按 scope/category/关键词过滤），用于盘点已知信息。',
  category: 'memory',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: SCOPES },
      category: { type: 'string', enum: CATEGORIES },
      keyword: { type: 'string' },
      limit: { type: 'integer', description: '默认 20' },
    },
  },
  async run({ scope, category, keyword, limit = 20 }, ctx) {
    const items = ctx.memory.list({
      sessionId: ctx.session.id,
      scope,
      category,
      keyword,
      limit: Number(limit) || 20,
      workspaceId: ctx.workspaceId,
    });
    if (!items.length) return '记忆库为空（或没有匹配项）';
    return items
      .map((m) => `#${m.id} [${m.scope}/${m.category} ${m.importance}] ${m.content}`)
      .join('\n');
  },
};

export const memoryTools = [memoryAdd, memorySearch, memoryList];
