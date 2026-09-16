// 记忆工具：让模型自己决定「什么值得长期记住」，并维护三块画像文件。
import { CATEGORIES, SCOPES, CHUNK_NAMES, CHUNKS } from '../memory.js';

const CHUNK_HELP =
  `chunk 决定写进哪块常驻画像（都是 global、每轮都注入，所以只放真正长期有用的东西）：` +
  `${CHUNK_NAMES.map((n) => `${n}=${CHUNKS[n].label}`).join(' / ')}。` +
  '不带 chunk 时：global 的 anchor 自动进 user、global 的 self 自动进 preference，其余进结构化记忆库（按需召回）。';

const chunkOf = (item) => (item?.chunk ? `${item.chunk}.md` : `${item.scope}/${item.category}`);

export const memoryAdd = {
  name: 'memory_add',
  description:
    '写入一条长期记忆。scope: global(所有会话可见) / workspace(仅本工作区) / session(仅本会话)。' +
    CHUNK_HELP +
    '只记「以后还用得上的事实或偏好」，不要记流水账。',
  category: 'memory',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要记住的内容，写成一句自包含的事实' },
      scope: { type: 'string', enum: SCOPES, description: '作用域，默认 session；带 chunk 时强制 global' },
      category: {
        type: 'string',
        enum: CATEGORIES,
        description: 'anchor=身份/基础事实, structure=流程方法, knowledge=事实, situation=具体场景, self=偏好反思',
      },
      chunk: {
        type: 'string',
        enum: [...CHUNK_NAMES, 'auto', 'none'],
        description: '画像文件：user=用户是谁(事实) / soul=助手人格原则 / preference=用户偏好；auto 按 category 推断，none 只进结构化记忆',
      },
      importance: { type: 'number', description: '重要度 0~1，默认 0.6（画像条目默认 0.8）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，便于检索' },
    },
    required: ['content'],
  },
  async run(args, ctx) {
    const store = ctx.memory;
    if (!store) return '记忆功能已关闭（MEMORY_ENABLED=0）';
    // 私聊场景：不允许把内容写进共享记忆（否则私聊信息会从别的群漏出去）。
    // 双重保险：既看通道给的 memoryScopeOverride，也直接看会话本身是不是私聊。
    const isPrivateSession =
      ctx.session?.channel?.type === 'feishu' && ctx.session.channel.chatType === 'p2p' && ctx.config?.privateIsolation !== false;
    const forced = ctx.config?.memoryScopeOverride || (isPrivateSession ? 'session' : null);
    const rawChunk = String(args.chunk ?? '').trim();
    const wantsChunk = CHUNK_NAMES.includes(rawChunk);
    if (forced === 'session' && wantsChunk) return '私聊场景不允许写入常驻画像（user/soul/preference），只能写会话级记忆。';
    const chunk = forced === 'session' ? 'none' : rawChunk;
    const scope = forced || (wantsChunk ? 'global' : args.scope || 'session');
    const item = store.add({
      content: args.content,
      scope,
      category: args.category || (wantsChunk ? CHUNKS[rawChunk].defaultCategory : 'knowledge'),
      importance: args.importance ?? (wantsChunk ? 0.8 : 0.6),
      tags: args.tags || [],
      sessionId: ctx.session?.id || null,
      workspaceId: ctx.workspaceId, // workspace 级记忆归属于当前会话所在的工作区
      chunk,
      source: ctx.session?.id ? `session:${ctx.session.id}` : null,
    });
    ctx.emit?.({ type: 'memory', action: 'add', item });
    const note = forced && args.scope && args.scope !== forced ? `（原本要写 ${args.scope} 级，私聊场景已降级为 ${forced}）` : '';
    return `已记住 #${item.id} [${chunkOf(item)} 重要度${item.importance}] ${item.content}${note}`;
  },
};

export const memorySearch = {
  name: 'memory_search',
  description: '按语义相关度检索长期记忆（词元重叠 + 重要度 + 时效）。画像文件（user/soul/preference）的内容本来就在系统提示里，这里也会一并列出。',
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
    if (!ctx.memory) return '记忆功能已关闭（MEMORY_ENABLED=0）';
    const hits = ctx.memory.search({
      query,
      topK: Number(topK) || 5,
      sessionId: ctx.session?.id || null,
      includeSession: include_session !== false,
      recordLoad: true,
      workspaceId: ctx.workspaceId,
    });
    if (!hits.length) return '没有找到相关记忆';
    return hits
      .map(({ item, score }) => `#${item.id} (${score}) [${chunkOf(item)}] ${item.content}`)
      .join('\n');
  },
};

export const memoryList = {
  name: 'memory_list',
  description: '列出记忆（可按 scope/category/chunk/关键词过滤），用于盘点已知信息。',
  category: 'memory',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: SCOPES },
      category: { type: 'string', enum: CATEGORIES },
      chunk: { type: 'string', enum: CHUNK_NAMES, description: '只看某块画像文件' },
      keyword: { type: 'string' },
      limit: { type: 'integer', description: '默认 20' },
    },
  },
  async run({ scope, category, chunk, keyword, limit = 20 }, ctx) {
    if (!ctx.memory) return '记忆功能已关闭（MEMORY_ENABLED=0）';
    const items = ctx.memory.list({
      sessionId: ctx.session?.id || null,
      scope,
      category,
      chunk,
      keyword,
      limit: Number(limit) || 20,
      workspaceId: ctx.workspaceId,
    });
    if (!items.length) return '记忆库为空（或没有匹配项）';
    return items.map((m) => `#${m.id} [${chunkOf(m)} 重要度${m.importance}] ${m.content}`).join('\n');
  },
};

/** 读画像文件原文：模型想整体审一遍 user/soul/preference 时用 */
export const memoryProfile = {
  name: 'memory_profile',
  description:
    '读取常驻画像文件（user.md / soul.md / preference.md）的原文。想整体审视/重写「我是谁、用户是谁、用户偏好什么」时用它；改单条用 memory_update / memory_add。',
  category: 'memory',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', enum: CHUNK_NAMES, description: '只读某一块；不填就三块都返回' },
    },
  },
  async run({ name } = {}, ctx) {
    if (!ctx.memory) return '记忆功能已关闭（MEMORY_ENABLED=0）';
    const names = name ? [name] : CHUNK_NAMES;
    return names
      .map((n) => {
        const items = ctx.memory.chunkItems(n);
        return `===== ${n}.md（${items.length} 条）=====\n${ctx.memory.chunkText(n)}`;
      })
      .join('\n');
  },
};

export const memoryUpdate = {
  name: 'memory_update',
  description: '修改一条已有记忆（内容 / 重要度 / 标签 / 归属的画像文件）。id 由 memory_list / memory_search 给出。',
  category: 'memory',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: '记忆 id' },
      content: { type: 'string', description: '新内容' },
      importance: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
      chunk: { type: 'string', enum: [...CHUNK_NAMES, 'none'], description: '移到某块画像文件，或 none 移回结构化记忆' },
    },
    required: ['id'],
  },
  async run(args, ctx) {
    if (!ctx.memory) return '记忆功能已关闭（MEMORY_ENABLED=0）';
    const before = ctx.memory.get(args.id);
    if (!before) return `没有 #${args.id} 这条记忆`;
    if (before.scope === 'session' && before.sessionId !== ctx.session?.id) return '这条是别的会话的记忆，不能改。';
    const patch = {};
    if (args.content !== undefined) patch.content = args.content;
    if (args.importance !== undefined) patch.importance = args.importance;
    if (args.tags !== undefined) patch.tags = args.tags;
    if (args.chunk !== undefined) patch.chunk = args.chunk === 'none' ? null : args.chunk;
    const item = ctx.memory.update(args.id, patch);
    ctx.emit?.({ type: 'memory', action: 'update', item });
    return `已更新 #${item.id} [${chunkOf(item)} 重要度${item.importance}] ${item.content}`;
  },
};

export const memoryRemove = {
  name: 'memory_remove',
  description: '删除一条记忆（写错了、过期了、用户要求忘掉时用）。',
  category: 'memory',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: { id: { type: 'integer', description: '记忆 id' } },
    required: ['id'],
  },
  async run({ id }, ctx) {
    if (!ctx.memory) return '记忆功能已关闭（MEMORY_ENABLED=0）';
    const item = ctx.memory.get(id);
    if (!item) return `没有 #${id} 这条记忆`;
    if (item.scope === 'session' && item.sessionId !== ctx.session?.id) return '这条是别的会话的记忆，不能删。';
    ctx.memory.remove(id);
    ctx.emit?.({ type: 'memory', action: 'remove', item: { id: item.id, content: item.content, chunk: item.chunk } });
    return `已删除 #${item.id} ${item.content}`;
  },
};

export const memoryTools = [memoryAdd, memorySearch, memoryList, memoryProfile, memoryUpdate, memoryRemove];
