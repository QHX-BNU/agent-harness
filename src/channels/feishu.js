// 飞书通道：把「群里 @机器人」接到 harness 上。
//
// 数据流：
//   lark-cli event consume im.message.receive_v1   （WebSocket 长连接，不需要公网回调）
//        ↓ NDJSON（stdout）
//   过滤：只要用户发的文本、且 @ 了机器人（或私聊）
//        ↓
//   (chat_id + 话题) → 一个 harness 会话（持久化映射，同一话题上下文连续）
//        ↓ runTurn（和网页端完全同一套内核：工具 / 沙箱 / 记忆 / trace）
//   lark-cli im +messages-reply --message-id <om>   把结论回复到原消息
//
// 跨群聚合：所有群共用一个工作区 → workspace 级记忆与「会话清单」类工具是全局共享的，
// A 群记下的事实 B 群能召回；每个话题的对话上下文则各自独立。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { runTurn } from '../loop.js';
import { Policy } from '../policy.js';
import { createProvider } from '../providers/index.js';
import { createSandbox } from '../sandbox.js';
import { getRuntimeModel } from '../runtime-model.js';
import { IdentityStore, defaultIdentityFile } from '../identities.js';

const truncate = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

/** 把长文本切成飞书能接受的多条消息（保守按 3000 字符切，尽量在换行处断） */
export function chunkMessage(text, limit = 3000) {
  const s = String(text ?? '').trim();
  if (!s) return ['（没有产出内容）'];
  if (s.length <= limit) return [s];
  const out = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export function createFeishuChannel({
  config,
  store,
  workspaces,
  tools,
  memory,
  agents,
  workflows,
  broker,
  stateFile,
  identitiesIn = null,
  log = console.log,
  // 依赖注入：测试时替换成假的
  spawnImpl = spawn,
  providerFactory = createProvider,
}) {
  const cfg = config.feishu || {};
  const state = { sessions: {}, dedupe: [], chats: {}, users: {}, members: {}, botOpenId: null };
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      Object.assign(state, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    } catch {
      /* 坏文件就当空的 */
    }
  }
  // 真实姓名/群名放在共享身份缓存里（digest 工具、历史回填都读它）
  const identities = identitiesIn || new IdentityStore({ file: stateFile ? path.join(path.dirname(stateFile), 'identities.json') : defaultIdentityFile(config.sessionsDir) });
  // 老状态文件里的 users/chats 迁进去
  identities.setUsers(Object.fromEntries(Object.entries(state.users || {}).filter(([, n]) => n && !/^ou_/.test(n))));
  for (const [chatId, c] of Object.entries(state.chats || {})) if (c?.name) identities.setChat(chatId, c.name);
  if (state.botOpenId && !cfg.botOpenId) cfg.botOpenId = state.botOpenId;
  const persist = () => {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* 落盘失败不影响主流程 */
    }
  };

  let child = null;
  let ready = false;
  let stopping = false;
  let restarts = 0;
  const status = {
    running: false,
    ready: false,
    startedAt: null,
    handled: 0,
    ignored: 0,
    replied: 0,
    errors: 0,
    lastError: null,
    lastMessageAt: null,
    cli: null,
    botOpenId: cfg.botOpenId || null,
  };

  const sessionKey = (ev) => `${ev.chat_id}:${ev.thread_id || ev.root_id || 'main'}`;

  /** 统一的 lark-cli 参数前缀：profile（可选）+ 自定义入口 */
  const cliBase = () => [...(cfg.cliPrefix || []), ...(cfg.profile ? ['--profile', cfg.profile] : [])];

  /** 这条消息是不是「对我们说的」 */
  function isAddressed(ev) {
    if (ev.chat_type === 'p2p') return true; // 私聊一定是
    if (!cfg.requireMention) return true;
    const mentions = ev.mentions || [];
    if (!mentions.length) return false;
    const wantId = cfg.botOpenId || state.botOpenId;
    const wantNames = [cfg.botName, ...(cfg.botAliases || [])].filter(Boolean);
    return mentions.some((m) => (wantId && m.id === wantId) || (m.name && wantNames.includes(m.name)));
  }

  /**
   * 第一次按名字匹配上时，顺手把机器人的 open_id 记下来 —— 之后判断 @ 就精确到 id，
   * 用户也就不用去后台抄 open_id 了。
   */
  function learnBotOpenId(ev) {
    if (cfg.botOpenId || state.botOpenId) return;
    const names = [cfg.botName, ...(cfg.botAliases || [])].filter(Boolean);
    const hit = (ev.mentions || []).find((m) => m.name && names.includes(m.name) && m.id);
    if (hit) {
      state.botOpenId = hit.id;
      cfg.botOpenId = hit.id;
      status.botOpenId = hit.id;
      persist();
      log(`[feishu] 记住了机器人 open_id=${hit.id}（判断 @ 更准了）`);
    }
  }

  /**
   * 说话人姓名：事件里只有 open_id（飞书不给名字），
   * 所以按群拉一次成员列表（id→名字），缓存 6 小时。
   * bot 身份没有通讯录权限，这里优先用 user 身份，失败就退回 id。
   */
  async function resolveMembers(chatId) {
    const cached = state.members[chatId];
    if (cached && Date.now() - (cached.at || 0) < 6 * 3600e3) return cached.map || {};
    const map = { ...(cached?.map || {}) };
    for (const identity of ['user', 'bot']) {
      const r = await runCli([...cliBase(), 'im', '+chat-members-list', '--chat-id', chatId, '--as', identity], { timeoutMs: 8000 });
      if (!r.ok) continue;
      try {
        const json = r.out.slice(r.out.indexOf('{'));
        const j = JSON.parse(json);
        for (const u of j?.data?.users || []) {
          if (u.member_id && u.name) map[u.member_id] = u.name;
        }
        if (Object.keys(map).length) break;
      } catch {
        /* 解析失败就换下一个身份 */
      }
    }
    // 群成员列表给的是「群内显示名」，可能像 用户138576 这种没设过名的占位；
    // 组织通讯录里的才是真名（localized_name），能拿到就用它覆盖。
    await enrichOrgNames(Object.keys(map)).catch(() => {});
    const refined = {};
    for (const id of Object.keys(map)) refined[id] = identities.name(id) || map[id];
    state.members[chatId] = { at: Date.now(), map: refined };
    persist();
    return refined;
  }

  /** 用通讯录（user 身份）批量换成组织真名 */
  async function enrichOrgNames(ids) {
    const need = (ids || []).filter((id) => id && id.startsWith('ou_') && !identities.data.orgNames?.[id]);
    if (!need.length) return 0;
    const r = await runCli([...cliBase(), 'contact', '+search-user', '--user-ids', need.join(','), '--as', 'user'], {
      timeoutMs: 10000,
    });
    if (!r.ok) return 0;
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
      let n = 0;
      for (const u of j?.data?.users || []) {
        const name = u.localized_name || u.name;
        if (u.open_id && name) {
          identities.setOrgName(u.open_id, name);
          n++;
        }
      }
      if (n) log(`[feishu] 通讯录换真名 ${n} 个`);
      return n;
    } catch {
      return 0;
    }
  }

  /** 给某个 open_id 找名字（找不到就返回 null，调用方退回 id） */
  async function resolveName(chatId, openId) {
    if (!openId) return null;
    const cached = identities.name(openId);
    if (cached) return cached;
    const map = await resolveMembers(chatId);
    const name = map[openId] || null;
    if (name) identities.setUser(openId, name);
    return name;
  }

  /** 群名：只查一次，之后缓存；顺带把会话标题从占位改成真名 */
  async function ensureChatName(chatId) {
    const cur = state.chats[chatId] || {};
    if (cur.name) return cur.name;
    if (cur.nameTried) return null;
    state.chats[chatId] = { ...cur, nameTried: true, lastAt: Date.now() };
    persist();
    const r = await runCli([...cliBase(), 'im', 'chats', 'get', '--chat-id', chatId, '--as', 'bot'], { timeoutMs: 5000 });
    if (!r.ok) return null;
    try {
      const j = JSON.parse(r.out);
      const name = j?.data?.chat?.name || j?.data?.name || null;
      if (!name) return null;
      state.chats[chatId] = { ...(state.chats[chatId] || {}), name, lastAt: Date.now() };
      identities.setChat(chatId, name);
      persist();
      const sid = state.sessions[`${chatId}:main`] || state.sessions[`${chatId}:${cur.threadKey || 'main'}`];
      const s = sid ? store.get(sid) : null;
      if (s && /^飞书群/.test(s.title || '')) {
        s.title = name;
        store.save(s);
      }
      return name;
    } catch {
      return null;
    }
  }

  /** 去掉正文里 @机器人 的前缀，留下真正的要求 */
  function cleanText(ev) {
    let text = String(ev.content ?? '');
    for (const name of [cfg.botName, ...(cfg.botAliases || [])].filter(Boolean)) {
      text = text.split(`@${name}`).join(' ');
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function ensureSession(ev) {
    const key = sessionKey(ev);
    const existing = state.sessions[key];
    if (existing && store.get(existing)) return store.get(existing);

    // 工作区：默认用配置的那个；也支持按 chat_id 指定
    const wsId = (cfg.workspaceByChat || {})[ev.chat_id] || cfg.workspaceId || 'default';
    const ws = workspaces?.get(wsId) || workspaces?.get('default');
    const chat = state.chats[ev.chat_id] || {};
    const chatTitle = identities.chatName(ev.chat_id) || chat.name || null;
    const session = store.create({
      provider: cfg.provider || config.provider,
      model: cfg.model || config.model,
      approvalMode: cfg.approvalMode || 'auto',
      title: chatTitle || (ev.chat_type === 'p2p' ? '飞书私聊' : `飞书群 ${String(ev.chat_id).slice(-6)}`),
      workspaceId: ws?.id || 'default',
      workspacePath: ws?.path || config.workspace,
    });
    session.channel = { type: 'feishu', chatId: ev.chat_id, chatType: ev.chat_type, threadKey: ev.thread_id || ev.root_id || 'main' };
    store.save(session);
    state.sessions[key] = session.id;
    persist();
    return session;
  }

  /** 交给模型看的输入：带上来源，让它可以跨群聚合时区分谁说的 */
  function decoratePrompt(ev, text, session) {
    const chat = state.chats[ev.chat_id] || {};
    const who = identities.name(ev.sender_id) || ev.sender_name || ev.sender_id;
    const where = ev.chat_type === 'p2p' ? '飞书私聊' : `飞书群「${chat.name || String(ev.chat_id).slice(-6)}」`;
    return `[${where} · ${who}(${ev.sender_id})]\n${text}`;
  }

  // ---------- 回复 ----------
  function runCli(args, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve) => {
      const p = spawnImpl(cfg.cliCommand || process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      p.stdout?.on('data', (d) => (out += d));
      p.stderr?.on('data', (d) => (err += d));
      const t = setTimeout(() => {
        try {
          p.kill('SIGTERM');
        } catch {}
      }, timeoutMs);
      p.on('error', (e) => {
        clearTimeout(t);
        resolve({ ok: false, out, err: String(e.message) });
      });
      p.on('close', (code) => {
        clearTimeout(t);
        // lark-cli 对高风险写操作有强制门禁：exit 10 + confirmation_required。
        // 机器人无人可问，所以这里只如实记录，不偷偷加 --yes。
        if (code === 10 && /confirmation_required/.test(err)) {
          status.lastError = `lark-cli 要求确认高风险操作，已被拦下：${truncate(err, 200)}`;
        }
        resolve({ ok: code === 0, code, out, err });
      });
    });
  }

  async function reply(messageId, text, { inThread = cfg.replyInThread !== false } = {}) {
    const parts = chunkMessage(text, cfg.chunkSize || 3000);
    const sent = [];
    for (const [i, part] of parts.entries()) {
      const body = parts.length > 1 ? `（${i + 1}/${parts.length}）\n${part}` : part;
      const args = [...cliBase(), 'im', '+messages-reply', '--message-id', messageId, '--markdown', body, '--as', 'bot'];
      if (inThread) args.push('--reply-in-thread');
      const r = await runCli(args);
      if (!r.ok) {
        status.errors++;
        status.lastError = truncate(r.err || `exit ${r.code}`, 300);
        log(`[feishu] 回复失败: ${status.lastError}`);
        // markdown 失败时退化成纯文本再试一次
        const fb = await runCli([...cliBase(), 'im', '+messages-reply', '--message-id', messageId, '--text', body, '--as', 'bot']);
        if (!fb.ok) return sent;
      }
      sent.push(body);
      status.replied++;
    }
    return sent;
  }

  // ---------- 处理一条消息 ----------
  /**
   * @param ev 飞书事件（扁平结构）
   * @param opts.dryRun 只跑内核、不真的往飞书回消息（给自己做跨群/联调测试用）
   */
  async function handleEvent(ev, opts = {}) {
    const simulated = [];
    const sendReply = opts.dryRun ? async (id, text) => (simulated.push(text), [text]) : reply;
    if (!ev || ev.type !== 'im.message.receive_v1') return { ok: false, reason: 'not_message' };
    status.lastMessageAt = Date.now();
    if (ev.sender_type === 'bot') {
      status.ignored++;
      return { ok: false, reason: 'from_bot' };
    }
    // 只服务群时，私聊直接不理
    if (ev.chat_type === 'p2p' && cfg.allowP2p === false) {
      status.ignored++;
      return { ok: false, reason: 'p2p_disabled' };
    }
    if (!['text', 'post'].includes(ev.message_type)) {
      status.ignored++;
      return { ok: false, reason: 'unsupported_type' };
    }
    if (state.dedupe.includes(ev.message_id)) {
      status.ignored++;
      return { ok: false, reason: 'duplicate' };
    }
    if (!isAddressed(ev)) {
      status.ignored++;
      return { ok: false, reason: 'not_addressed' };
    }
    const text = cleanText(ev);
    state.dedupe = [...state.dedupe, ev.message_id].slice(-500);
    persist();
    learnBotOpenId(ev);
    if (ev.chat_type === 'group') {
      await ensureChatName(ev.chat_id).catch(() => {});
      // 事件里只有 open_id，这里补上说话人姓名（按群缓存，一次调用覆盖全群）
      await resolveName(ev.chat_id, ev.sender_id).catch(() => {});
    }
    if (!text) {
      await sendReply(ev.message_id, '我在，直接说需求就行（例如：@我 看一下 xxx 目录为什么构建失败）');
      return { ok: true, reason: 'empty_text' };
    }

    const session = ensureSession(ev);
    const ws = workspaces?.get(session.workspaceId) || workspaces?.get('default');
    const isPrivate = ev.chat_type === 'p2p';
    const turnConfig = {
      ...config,
      workspace: ws?.path || config.workspace,
      workspaceName: ws?.name || '',
      // 跨群可见性开关跟着通道配置走（digest 工具会读它）
      crossGroup: cfg.crossGroup !== false,
      // 私聊隔离：私聊会话不会被别人的查询看到，私聊里记的事实也不进共享记忆
      privateIsolation: cfg.privateIsolation !== false,
      ...(isPrivate && cfg.privateIsolation !== false ? { memoryScopeOverride: 'session' } : {}),
      channelPrompt: isPrivate
        ? [
            '你正在飞书**私聊**里为用户提供服务：他私聊 @ 你，你用工具帮他干活，结论回复给他本人。',
            '- 私聊是私密的：不要把这里的内容写进 workspace 级记忆（写记忆会自动降级为会话级）。',
            '- 不要主动把别的群、别的同事的会话内容搬到私聊里；对方明确问起团队公开进展时，可以说群里讨论过什么。',
            '- 回答要能直接贴进聊天窗口：先给结论，再给必要细节。',
          ].join('\n')
        : [
            '你正在飞书里为团队提供服务：用户在群聊里 @ 你，你用工具帮他干活，结论会回复到原消息。',
            '- 回答要能直接贴进聊天窗口：先给结论，再给必要细节；不要长篇大论，不要复述工具输出。',
            '- 你看不到聊天记录以外的群消息。需要背景时，用 memory_search / session_list 查这个工作区里沉淀的信息。',
            '- 群里沉淀下来的、以后还用得上的事实（约定、结论、负责人、进度），用 memory_add 时**显式传 scope="workspace"**，' +
              '这样别的群、别的会话也能召回；只跟当前话题有关的临时信息才用默认的 session。',
            '- 所有群共用同一个工作区，所以别的群里记下的事实你也能查到；引用时说明来源群，别把 A 群的结论按到 B 群头上。',
            '- 有人问「某某最近做了什么/在忙什么」时，用 user_activity（按姓名或 open_id）查；' +
              '问「最近大家在聊什么」用 session_list，要细节再用 session_read。回答时点明是谁、在哪个群、什么时候。',
            '- 私聊内容你查不到，也不要声称知道别人私聊说了什么。',
          ].join('\n'),
    };

    // 凭证优先级：通道自己的配置 > 网页同步过来的运行时配置 > 服务端环境变量
    const rt = getRuntimeModel() || {};
    const provider = providerFactory({
      provider: cfg.provider || rt.provider || config.provider,
      model: cfg.model || rt.model || config.model,
      baseUrl: cfg.baseUrl || rt.baseUrl || config.baseUrl,
      apiKey: cfg.apiKey || rt.apiKey || config.apiKey,
      timeoutMs: config.modelTimeoutMs,
      retries: config.modelRetries,
    });
    // 会话上记录本轮真正用的模型（否则界面上显示的是创建时的默认值，会误导）
    if (session.provider !== provider.id || session.model !== provider.model) {
      session.provider = provider.id;
      session.model = provider.model;
      store.save(session);
    }

    let answer = '';
    // 注意：runTurn 内部会自己把事件落盘（loop 的 emit 已经做了），这里再 append 一次
    // 会让 trace 每条事件写两遍。所以给 loop 的是「只处理不落盘」的版本，
    // 而给沙箱的（不经过 loop）仍然要落盘。
    const observe = (e) => {
      if (e.type === 'assistant_message') answer = e.content;
      if (e.type === 'error') status.lastError = truncate(e.message, 300);
      onEvent?.(e, session, ev);
    };
    const emit = observe;
    const sandboxEmit = (e) => {
      store.appendEvent(session.id, e);
      observe(e);
    };

    const slowTimer = setTimeout(
      () => {
        sendReply(ev.message_id, '任务还在跑，我处理完会把结论发上来…').catch(() => {});
      },
      opts.dryRun ? 3600000 : cfg.progressAfterMs ?? 15000,
    );

    try {
      const result = await runTurn({
        session,
        userText: decoratePrompt(ev, text, session),
        provider,
        tools,
        policy: new Policy(session.approvalMode || cfg.approvalMode || 'auto', broker),
        store,
        emit,
        config: turnConfig,
        signal: new AbortController().signal,
        memory,
        agents,
        workflows,
        // digest 工具用它把 open_id 还原成真实姓名
        identities,
        // 结构化记下「谁在哪个群说的」——跨群查「某人做了什么」全靠它
        userMeta: {
          id: ev.sender_id,
          name: identities.name(ev.sender_id) || ev.sender_name || null,
          chatId: ev.chat_id,
          chatType: ev.chat_type,
          chatTitle: identities.chatName(ev.chat_id) || (state.chats[ev.chat_id] || {}).name || null,
          threadKey: ev.thread_id || ev.root_id || 'main',
          messageId: ev.message_id,
        },
        sandbox: createSandbox({
          ...(config.sandbox || {}),
          workspace: ws?.path || config.workspace,
          sessionId: session.id,
          emit: sandboxEmit,
        }),
        modelConfig: {
          provider: provider.id,
          model: provider.model,
          baseUrl: cfg.baseUrl || rt.baseUrl || config.baseUrl || undefined,
          apiKey: cfg.apiKey || rt.apiKey || config.apiKey || undefined,
        },
        depth: 0,
      });
      clearTimeout(slowTimer);
      status.handled++;
      const body = answer || (result.reason === 'max_steps' ? '任务超过步数上限被中止了，说个更具体的目标我再试。' : '（没有产出内容）');
      await sendReply(ev.message_id, body);
      return { ok: true, sessionId: session.id, answer: body, replies: simulated };
    } catch (err) {
      clearTimeout(slowTimer);
      status.errors++;
      status.lastError = truncate(err.message, 300);
      await sendReply(ev.message_id, `出错了：${err.message}`);
      return { ok: false, reason: 'error', error: err.message, replies: simulated };
    }
  }

  /**
   * 模拟一条入站消息：只跑内核（真的调模型、真的写文件/记忆），但不会往飞书发消息。
   * 用来验证「换个群还能不能共享信息」这类行为，不用去真群里刷屏。
   */
  async function simulate({ chatId, chatType = 'group', senderId = 'ou_simulated_user', senderName, content, mentions }) {
    const ev = {
      type: 'im.message.receive_v1',
      message_id: `om_sim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      chat_id: chatId,
      chat_type: chatType,
      message_type: 'text',
      sender_type: 'user',
      sender_id: senderId,
      sender_name: senderName,
      content,
      mentions: mentions || [{ id: cfg.botOpenId || state.botOpenId, key: '@_user_1', name: cfg.botName }],
      create_time: String(Date.now()),
    };
    if (senderName) identities.setUser(senderId, senderName);
    return handleEvent(ev, { dryRun: true });
  }

  let onEvent = null;

  // ---------- 子进程：事件流 ----------
  function start() {
    // 正在退出中的进程还没关掉，等它关了再起（否则 start→stop→start 会静默失败）
    if (child && stopping) {
      child.once('close', () => {
        child = null;
        start();
      });
      return status;
    }
    if (child) return status;
    stopping = false;
    const args = [
      ...cliBase(),
      'event',
      'consume',
      cfg.eventKey || 'im.message.receive_v1',
      '--as',
      'bot',
      ...(cfg.consumeArgs || []),
    ];
    const cmd = cfg.cliCommand || process.execPath;
    status.cli = `${path.basename(cmd)} ${args.join(' ')}`;
    log(`[feishu] 启动事件订阅: ${status.cli}`);
    child = spawnImpl(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    status.running = true;
    status.startedAt = Date.now();

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // 非 JSON 行忽略
        }
        handleEvent(ev).catch((err) => {
          status.errors++;
          status.lastError = truncate(err.message, 300);
        });
      }
    });

    let ebuf = '';
    child.stderr.on('data', (d) => {
      ebuf += d.toString();
      let nl;
      while ((nl = ebuf.indexOf('\n')) >= 0) {
        const line = ebuf.slice(0, nl).trim();
        ebuf = ebuf.slice(nl + 1);
        if (!line) continue;
        if (/\[event\] ready/.test(line) || /listening for events/.test(line)) {
          if (!ready) {
            ready = true;
            status.ready = true;
            log('[feishu] 已就绪，等待 @ 消息');
          }
        } else if (/exited/.test(line)) {
          log(`[feishu] ${line}`);
        }
      }
    });

    child.on('error', (err) => {
      status.running = false;
      status.ready = false;
      status.lastError = err.message;
      log(`[feishu] 子进程启动失败: ${err.message}`);
    });

    child.on('close', (code) => {
      child = null;
      status.running = false;
      ready = false;
      status.ready = false;
      if (stopping) return;
      log(`[feishu] 事件订阅退出（code=${code}），${restarts < (cfg.maxRestarts ?? 5) ? '准备重连' : '已达重连上限'}`);
      if (restarts < (cfg.maxRestarts ?? 5)) {
        restarts++;
        setTimeout(() => start(), Math.min(30000, 1000 * 2 ** restarts));
      }
    });

    // 保持 stdin 打开：EOF 会被 lark-cli 当成优雅退出信号
    return status;
  }

  function stop() {
    stopping = true;
    if (!child) return status;
    // 用 SIGTERM，不要 kill -9（会漏掉服务端订阅清理）
    try {
      child.kill('SIGTERM');
    } catch {}
    const c = child;
    setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {}
    }, 5000);
    status.running = false;
    status.ready = false;
    return status;
  }

  return {
    start,
    stop,
    handleEvent,
    simulate,
    reply,
    status: () => ({ ...status, sessions: Object.keys(state.sessions).length, chats: Object.keys(state.chats).length, stateFile }),
    /** 当前生效的通道配置（给接口/界面看） */
    describe: () => ({
      botName: cfg.botName || '',
      botAliases: cfg.botAliases || [],
      botOpenId: cfg.botOpenId || state.botOpenId || '',
      requireMention: cfg.requireMention !== false,
      replyInThread: cfg.replyInThread !== false,
      workspaceId: cfg.workspaceId || 'default',
      approvalMode: cfg.approvalMode || 'auto',
      profile: cfg.profile || '',
      eventKey: cfg.eventKey || 'im.message.receive_v1',
    }),
    /**
     * 热更新通道配置：不用重启服务就能换机器人 / 换工作区（重启会丢掉同步过来的模型 key）
     */
    configure(patch = {}) {
      if (patch.botName !== undefined) cfg.botName = String(patch.botName).trim();
      if (patch.botAliases !== undefined) cfg.botAliases = patch.botAliases || [];
      if (patch.botOpenId !== undefined && patch.botOpenId) {
        cfg.botOpenId = String(patch.botOpenId).trim();
        state.botOpenId = cfg.botOpenId;
      }
      if (patch.workspaceId !== undefined) cfg.workspaceId = String(patch.workspaceId).trim() || 'default';
      if (patch.requireMention !== undefined) cfg.requireMention = Boolean(patch.requireMention);
      if (patch.replyInThread !== undefined) cfg.replyInThread = Boolean(patch.replyInThread);
      if (patch.approvalMode !== undefined) cfg.approvalMode = String(patch.approvalMode);
      if (patch.profile !== undefined) cfg.profile = String(patch.profile).trim();
      if (patch.workspaceByChat !== undefined) cfg.workspaceByChat = patch.workspaceByChat || {};
      persist();
      log(`[feishu] 配置已更新：机器人=${cfg.botName || '(未设)'} · 工作区=${cfg.workspaceId} · 需要@=${cfg.requireMention !== false}`);
      return { ...status, config: undefined };
    },
    /** 记录群名，让日志与 prompt 更可读 */
    noteChat(chatId, name) {
      state.chats[chatId] = { ...(state.chats[chatId] || {}), name, lastAt: Date.now() };
      identities.setChat(chatId, name);
      persist();
    },
    identities,
    ensureChatName,
    noteBotOpenId(id) {
      state.botOpenId = id;
      cfg.botOpenId = id;
      persist();
    },
    onEvent(fn) {
      onEvent = fn;
    },
    sessionKey,
    state,
  };
}
