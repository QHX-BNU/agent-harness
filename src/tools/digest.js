// 跨会话聚合工具：让机器人在一个群里回答「别的群/别人在忙什么」。
// 这是「把分散的团队信息整合起来」的关键——记忆是沉淀，这几个工具是现场检索。
//
// 说话人来历：新消息在 message.sender 里带结构化元数据；老消息只有正文前缀
// `[飞书群「X」 · 名字(ou_xxx)]`，所以这里做了一层兼容解析。

const PREFIX_RE = /^\[(飞书群「(.+?)」|飞书私聊) · (.+?)\((ou_[A-Za-z0-9]+)\)\]/;

/** 从一条用户消息里取出说话人（结构化优先，退回解析正文前缀） */
export function senderOf(message) {
  if (message?.role !== 'user') return null;
  if (message.sender?.id) return message.sender;
  const m = PREFIX_RE.exec(String(message.content || ''));
  if (!m) return null;
  return { id: m[4], name: m[3], chatTitle: m[2] || null, chatType: m[2] ? 'group' : 'p2p' };
}

/** 一个会话里出现过的所有说话人 */
export function sendersOf(session) {
  const map = new Map();
  for (const msg of session?.messages || []) {
    const s = senderOf(msg);
    if (!s?.id) continue;
    const cur = map.get(s.id) || { id: s.id, name: s.name || null, chats: new Set(), messages: 0, lastAt: 0 };
    if (s.name) cur.name = s.name;
    if (s.chatTitle) cur.chats.add(s.chatTitle);
    cur.messages++;
    cur.lastAt = Math.max(cur.lastAt, s.at || 0);
    map.set(s.id, cur);
  }
  return [...map.values()].map((x) => ({ ...x, chats: [...x.chats] }));
}

const where = (session) => {
  const ch = session?.channel;
  if (ch?.type === 'feishu') {
    return ch.chatType === 'p2p' ? '飞书私聊' : `飞书群「${session.title || ch.chatId}」`;
  }
  return '网页';
};

const ago = (ts) => {
  const d = Date.now() - (ts || 0);
  if (d < 3600e3) return `${Math.max(1, Math.round(d / 60000))} 分钟前`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} 小时前`;
  return `${Math.round(d / 86400e3)} 天前`;
};

const oneLine = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

/**
 * 跨群可见性开关：FEISHU_CROSS_GROUP=0 时通道会把 config.crossGroup 设成 false，
 * 这几个工具就只认当前会话——看不到别的群。
 */
function crossGroupBlocked(ctx) {
  if (ctx?.config?.crossGroup !== false) return null;
  return (
    '跨群信息访问已被关闭（FEISHU_CROSS_GROUP=0）：你只能看到当前这个会话里的内容，' +
    '不能查询其他群/其他同事的会话。如果用户需要跨群汇总，请让管理员打开这个开关。'
  );
}

/** 展示正文时去掉来源前缀（说话人已经单独标出来了，避免重复） */
const bodyOf = (message) => {
  const text = String(message?.content || '');
  return message?.sender?.id ? text.replace(PREFIX_RE, '').trim() : text;
};

/** 会话里的任务清单（模型用 todo_write 维护的） */
const todosOf = (session) => (session?.todos || []).map((t) => `[${t.status}] ${t.content}`);

export const sessionList = {
  name: 'session_list',
  description:
    '列出本工作区最近的会话（含飞书各群/私聊里发生的对话）：标题、参与者、时间、最后结论摘要。' +
    '用于回答「最近大家在做/讨论什么」。也可以按参与者姓名过滤。',
  category: 'digest',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '返回多少条，默认 20' },
      keyword: { type: 'string', description: '按标题关键词过滤（可选）' },
      user: { type: 'string', description: '只看某个人参与过的会话（姓名或 open_id，可选）' },
      max_age_hours: { type: 'number', description: '只看最近多少小时内的会话（可选）' },
    },
  },
  async run({ limit = 20, keyword, user, max_age_hours }, ctx) {
    const blocked = crossGroupBlocked(ctx);
    if (blocked) return blocked;
    const all = ctx.store.list({ workspaceId: ctx.workspaceId === 'default' ? null : ctx.workspaceId });
    const since = max_age_hours ? Date.now() - Number(max_age_hours) * 3600e3 : 0;
    const rows = [];
    for (const s of all) {
      if (keyword && !(s.title || '').includes(keyword)) continue;
      if (s.updatedAt < since) continue;
      const full = ctx.store.get(s.id);
      const people = sendersOf(full);
      if (user) {
        const q = String(user).toLowerCase();
        if (!people.some((p) => p.id.toLowerCase() === q || (p.name || '').toLowerCase().includes(q))) continue;
      }
      if (rows.length >= (Number(limit) || 20)) break;
      const last = [...(full?.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content);
      const who = people.length ? `参与者: ${people.map((p) => p.name || p.id).slice(0, 4).join(', ')}` : '（没有记录到说话人）';
      rows.push(
        `- [${s.id}] ${s.title || '未命名'}（${where(full)}，${ago(s.updatedAt)}，${s.messages} 条消息）\n` +
          `  ${who}\n` +
          `  最后结论: ${oneLine(last?.content, 140) || '（还没有结论）'}`,
      );
    }
    if (!rows.length) return user ? `没有找到「${user}」参与过的会话` : '没有符合条件的会话';
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
    const blocked = crossGroupBlocked(ctx);
    if (blocked) return blocked;
    const s = ctx.store.get(String(session));
    if (!s) throw new Error(`没有这个会话：${session}`);
    const msgs = s.messages.slice(-(Number(limit) || 20));
    const body = msgs
      .map((m) => {
        const sender = senderOf(m);
        const who = m.role === 'user' ? sender?.name || sender?.id || '用户' : m.role === 'assistant' ? '助手' : `工具 ${m.name || ''}`;
        return `【${who}】${oneLine(bodyOf(m), 300) || '(空)'}`;
      })
      .join('\n');
    const people = sendersOf(s);
    return (
      `会话 ${s.id}「${s.title || '未命名'}」（${where(s)}，${s.messages} 条消息，最近 ${msgs.length} 条）\n` +
      `参与者: ${people.map((p) => `${p.name || p.id}(${p.id})`).join(', ') || '无记录'}\n` +
      `${body}`
    );
  },
};

export const userActivity = {
  name: 'user_activity',
  description:
    '查某个人最近做了什么：他在哪些群/会话里出现过、提了什么要求、得到了什么结论、留下什么任务。' +
    '用于回答「小明最近在忙什么」「用户2 在别的群做了什么」。先用 session_list 或本工具按姓名/ open_id 查。',
  category: 'digest',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      user: { type: 'string', description: '姓名或 open_id' },
      hours: { type: 'number', description: '看最近多少小时，默认 168（7 天）' },
      limit: { type: 'integer', description: '最多列几个会话，默认 10' },
    },
    required: ['user'],
  },
  async run({ user, hours = 168, limit = 10 }, ctx) {
    const blocked = crossGroupBlocked(ctx);
    if (blocked) return blocked;
    const q = String(user || '').trim().toLowerCase();
    if (!q) throw new Error('user 不能为空');
    const since = Date.now() - Number(hours) * 3600e3;
    const all = ctx.store.list({ workspaceId: ctx.workspaceId === 'default' ? null : ctx.workspaceId });
    const hits = [];
    const people = new Map();

    for (const s of all) {
      const full = ctx.store.get(s.id);
      const senders = sendersOf(full);
      for (const p of senders) people.set(p.id, p.name || p.id);
      const me = senders.find((p) => p.id.toLowerCase() === q || (p.name || '').toLowerCase().includes(q));
      if (!me) continue;
      const asks = (full.messages || [])
        .filter((m) => m.role === 'user' && senderOf(m)?.id === me.id)
        .slice(-3)
        .map((m) => oneLine(bodyOf(m), 100));
      const last = [...(full.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content);
      hits.push({
        session: full,
        me,
        recent: (full.messages || []).some((m) => senderOf(m)?.id === me.id && (senderOf(m).at || 0) > since) || s.updatedAt > since,
        asks,
        last: oneLine(last?.content, 160),
        todos: todosOf(full),
      });
    }

    const fresh = hits.filter((h) => h.recent).sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    if (!fresh.length) {
      const known = [...people.entries()].map(([id, n]) => `${n}(${id})`).slice(0, 20);
      return (
        `没有找到「${user}」在最近 ${hours} 小时内的活动。\n` +
        (known.length ? `本工作区见过的说话人：${known.join(', ')}` : '本工作区还没有记录到任何说话人。')
      );
    }

    const lines = fresh.slice(0, Number(limit) || 10).map((h) => {
      const t = h.todos.length ? `\n    任务: ${h.todos.slice(0, 4).join(' / ')}` : '';
      return (
        `- ${where(h.session)}（${ago(h.session.updatedAt)}，${h.me.messages} 条发言）\n` +
        h.asks.map((a) => `    他说过: ${a}`).join('\n') +
        `\n    结论: ${h.last || '（还没有结论）'}${t}`
      );
    });

    return (
      `「${fresh[0].me.name || user}」在最近 ${hours} 小时内出现在 ${fresh.length} 个会话里：\n` +
      lines.join('\n') +
      `\n\n提示：这些是跨群汇总的信息，回答时说明来源（哪个群），别把 A 群的结论按到 B 群头上。`
    );
  },
};

export const digestTools = [sessionList, sessionRead, userActivity];
