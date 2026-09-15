// 跨会话聚合工具：让机器人在一个群里回答「别的群/别人在忙什么」。
// 这是「把分散的团队信息整合起来」的关键——记忆是沉淀，这两个工具是现场检索。
export const sessionList = {
  name: 'session_list',
  description:
    '列出本工作区最近的会话（含飞书群/私聊里发生的对话）：标题、谁在什么时候聊的、最后结论摘要。' +
    '用于回答「最近大家在做/讨论什么」这类跨群聚合问题。',
  category: 'digest',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '返回多少条，默认 20' },
      keyword: { type: 'string', description: '按标题关键词过滤（可选）' },
      max_age_hours: { type: 'number', description: '只看最近多少小时内的会话（可选）' },
    },
  },
  async run({ limit = 20, keyword, max_age_hours }, ctx) {
    const all = ctx.store.list({ workspaceId: ctx.workspaceId === 'default' ? null : ctx.workspaceId });
    const since = max_age_hours ? Date.now() - Number(max_age_hours) * 3600e3 : 0;
    const rows = all
      .filter((s) => (keyword ? (s.title || '').includes(keyword) : true))
      .filter((s) => s.updatedAt >= since)
      .slice(0, Number(limit) || 20)
      .map((s) => {
        const full = ctx.store.get(s.id);
        const last = [...(full?.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content);
        const where = full?.channel?.type === 'feishu' ? `飞书/${full.channel.chatType}` : '网页';
        const ago = Math.round((Date.now() - s.updatedAt) / 60000);
        return `- [${s.id}] ${s.title || '未命名'}（${where}，${ago} 分钟前，${s.messages} 条消息）\n  ${String(last?.content || '（还没有结论）').replace(/\s+/g, ' ').slice(0, 160)}`;
      });
    if (!rows.length) return '没有符合条件的会话';
    return `最近 ${rows.length} 个会话：\n${rows.join('\n')}`;
  },
};

export const sessionRead = {
  name: 'session_read',
  description:
    '读取某个会话（可能是另一个飞书群里的对话）的最近消息，用于汇总上下文。' +
    '先用 session_list 找到会话 id，再用这个工具读细节。',
  category: 'digest',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      session: { type: 'string', description: '会话 id（来自 session_list）' },
      limit: { type: 'integer', description: '读最近多少条消息，默认 20' },
    },
    required: ['session'],
  },
  async run({ session, limit = 20 }, ctx) {
    const s = ctx.store.get(String(session));
    if (!s) throw new Error(`没有这个会话：${session}`);
    const msgs = s.messages.slice(-Number(limit) || -20);
    const body = msgs
      .map((m) => {
        const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : `工具 ${m.name || ''}`;
        return `【${who}】${String(m.content || '(空)').replace(/\s+/g, ' ').slice(0, 300)}`;
      })
      .join('\n');
    return `会话 ${s.id}「${s.title || '未命名'}」（${s.messages.length} 条消息，最近 ${msgs.length} 条）：\n${body}`;
  },
};

export const digestTools = [sessionList, sessionRead];
