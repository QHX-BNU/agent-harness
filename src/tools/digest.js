// 跨会话聚合工具：让机器人在一个群里回答「别的群/别人在忙什么」。
// 这是「把分散的团队信息整合起来」的关键——记忆是沉淀，这几个工具是现场检索。
//
// 说话人来历：新消息在 message.sender 里带结构化元数据；老消息只有正文前缀
// `[飞书群「X」 · 名字(ou_xxx)]`，所以这里做了一层兼容解析。
import { looksLikeId } from '../identities.js';

const PREFIX_RE = /^\[(飞书群「(.+?)」|飞书私聊) · (.+?)\((ou_[A-Za-z0-9]+)\)\]/;

/**
 * 显示用姓名：身份缓存（别名/组织真名，最新）→ 消息里存的快照名 → 退回顾 open_id。
 * 顺序不能反：消息里存的是写入当时的名字，可能是「用户138576」这种占位，
 * 而通讯录里已经是真名了。
 */
function displayName(ctx, sender) {
  if (!sender) return null;
  const live = ctx?.identities?.name?.(sender.id);
  if (live) return live;
  const stored = sender.name && !looksLikeId(sender.name) ? sender.name : null;
  return stored || sender.name || sender.id;
}

/** 群名同理：身份缓存优先 */
function displayChat(ctx, sender, fallback = null) {
  return (
    ctx?.identities?.chatName?.(sender?.chatId) ||
    (sender?.chatTitle && !looksLikeId(sender.chatTitle) ? sender.chatTitle : null) ||
    fallback ||
    sender?.chatTitle ||
    null
  );
}

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
    // 真名优先：老消息前缀里塞的可能是 open_id
    if (s.name && !looksLikeId(s.name)) cur.name = s.name;
    if (s.chatTitle && !looksLikeId(s.chatTitle)) cur.chats.add(s.chatTitle);
    cur.messages++;
    cur.lastAt = Math.max(cur.lastAt, s.at || 0);
    map.set(s.id, cur);
  }
  return [...map.values()].map((x) => ({ ...x, chats: [...x.chats] }));
}

const where = (session, ctx = null) => {
  const ch = session?.channel;
  if (ch?.type === 'feishu') {
    if (ch.chatType === 'p2p') return '飞书私聊';
    // 群名以身份缓存为准（标题可能还是「飞书群 oc_xxx」这种占位）
    const live = ctx?.identities?.chatName?.(ch.chatId);
    const title = String(live || session.title || ch.chatId || '').replace(/^飞书群\s*/, '');
    return `飞书群「${title}」`;
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

/**
 * 可见会话：**私聊内容不外泄**。
 * 规则：私聊会话只有它自己能读到——群里的人（哪怕在同一个工作区）查不到别人私聊说了什么。
 */
function visibleSessions(ctx) {
  const all = ctx.store.list({ workspaceId: ctx.workspaceId === 'default' ? null : ctx.workspaceId });
  const selfId = ctx.session?.id;
  return all.filter((s) => {
    if (ctx.config?.privateIsolation === false) return true;
    const full = ctx.store.get(s.id);
    const isPrivate = full?.channel?.type === 'feishu' && full.channel.chatType === 'p2p';
    return !isPrivate || s.id === selfId;
  });
}

/** 一个说话人可能有的所有名字（真名/别名/群显示名/id），用于按名字模糊匹配 */
function nameCandidates(ctx, sender) {
  const ident = ctx?.identities;
  const id = sender.id;
  const raw = ident?.data?.users?.[id];
  return [
    displayName(ctx, sender),
    ident?.data?.orgNames?.[id]?.name,
    ident?.data?.aliases?.[id],
    typeof raw === 'string' ? raw : raw?.name,
    sender.name,
    id,
  ]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());
}

const matchesUser = (ctx, sender, query) => nameCandidates(ctx, sender).some((n) => n === query || n.includes(query));

/** 展示正文时去掉来源前缀（说话人已经单独标出来了，避免重复） */
const bodyOf = (message) => String(message?.content || '').replace(PREFIX_RE, '').trim();

/** 会话里的任务清单（模型用 todo_write 维护的） */
const todosOf = (session) => (session?.todos || []).map((t) => `[${t.status}] ${t.content}`);

/**
 * 把「某人说的每一句」和「紧随其后的那条回答」配成对。
 * 不能直接用会话最后一条助手消息——那个可能是别人问的，配对会张冠李戴。
 */
export function pairsOf(messages, userId, ctx = null) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const sender = senderOf(m);
    if (sender?.id !== userId) continue;
    const answer = messages.slice(i + 1).find((x) => x.role === 'assistant' && x.content && !x.toolCalls?.length);
    out.push({
      ask: oneLine(bodyOf(m), 110),
      answer: oneLine(answer?.content, 200),
      at: sender?.at || 0,
      chatTitle: displayChat(ctx, sender),
    });
  }
  return out;
}

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
    const all = visibleSessions(ctx);
    const since = max_age_hours ? Date.now() - Number(max_age_hours) * 3600e3 : 0;
    const rows = [];
    for (const s of all) {
      if (keyword && !(s.title || '').includes(keyword)) continue;
      if (s.updatedAt < since) continue;
      const full = ctx.store.get(s.id);
      const people = sendersOf(full).map((p) => ({ ...p, display: displayName(ctx, p) }));
      if (user) {
        const q = String(user).toLowerCase();
        if (!people.some((p) => matchesUser(ctx, p, q))) continue;
      }
      if (rows.length >= (Number(limit) || 20)) break;
      const last = [...(full?.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content);
      const who = people.length ? `参与者: ${people.map((p) => p.display).slice(0, 4).join(', ')}` : '（没有记录到说话人）';
      rows.push(
        `- [${s.id}] ${s.title || '未命名'}（${where(full, ctx)}，${ago(s.updatedAt)}，${s.messages} 条消息）\n` +
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
    // 私聊会话不许被别人读（哪怕是同一个工作区）
    if (ctx.config?.privateIsolation !== false && s.channel?.type === 'feishu' && s.channel.chatType === 'p2p' && s.id !== ctx.session?.id) {
      return '这是别人的私聊会话，出于隐私保护不能读取。只能看群里的讨论，或者你自己的私聊。';
    }
    const msgs = s.messages.slice(-(Number(limit) || 20));
    const body = msgs
      .map((m) => {
        const sender = senderOf(m);
        const who =
          m.role === 'user' ? displayName(ctx, sender) || '用户' : m.role === 'assistant' ? '助手' : `工具 ${m.name || ''}`;
        return `【${who}】${oneLine(bodyOf(m), 300) || '(空)'}`;
      })
      .join('\n');
    const people = sendersOf(s).map((p) => ({ ...p, display: displayName(ctx, p) }));
    return (
      `会话 ${s.id}「${s.title || '未命名'}」（${where(s, ctx)}，${s.messages} 条消息，最近 ${msgs.length} 条）\n` +
      `参与者: ${people.map((p) => `${p.display}(${p.id})`).join(', ') || '无记录'}\n` +
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
    const all = visibleSessions(ctx);
    const hits = [];
    const people = new Map();

    for (const s of all) {
      const full = ctx.store.get(s.id);
      const senders = sendersOf(full).map((p) => ({ ...p, display: displayName(ctx, p) }));
      for (const p of senders) people.set(p.id, p.display);
      const me = senders.find((p) => matchesUser(ctx, p, q));
      if (!me) continue;
      const threads = pairsOf(full?.messages || [], me.id, ctx);
      const last = [...(full.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content);
      hits.push({
        session: full,
        me,
        recent:
          (full.messages || []).some((m) => senderOf(m)?.id === me.id && (senderOf(m).at || 0) > since) ||
          s.updatedAt > since,
        threads,
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
      const recent = h.threads.slice(-3);
      const body = recent
        .map((t) => `    · 「${t.ask}」 → ${t.answer ? oneLine(t.answer, 160) : '（还没回复）'}`)
        .join('\n');
      const t = h.todos.length ? `\n    任务清单: ${h.todos.slice(0, 4).join(' / ')}` : '';
      return `- ${where(h.session, ctx)}（${ago(h.session.updatedAt)}，共 ${h.me.messages} 条发言）\n${body}${t}`;
    });

    return (
      `「${fresh[0].me.display || user}」在最近 ${hours} 小时内出现在 ${fresh.length} 个会话里：\n` +
      lines.join('\n') +
      `\n\n提示：这些是跨群汇总的信息，回答时说明来源（哪个群），别把 A 群的结论按到 B 群头上。`
    );
  },
};

export const digestTools = [sessionList, sessionRead, userActivity];
