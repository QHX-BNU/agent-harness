// 飞书通道测试：@ 识别 / 去重 / 会话映射 / 跨群记忆 / 回复分片 / 真实子进程契约 / 服务接口。
// 用法: node scripts/feishu-test.js [baseUrl]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { config } from '../src/config.js';
import { SessionStore } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { ApprovalBroker, Policy } from '../src/policy.js';
import { createToolRegistry } from '../src/tools/index.js';
import { createAgentRunner } from '../src/agents.js';
import { createWorkflowEngine } from '../src/workflow.js';
import { createProvider } from '../src/providers/index.js';
import { createFeishuChannel, chunkMessage } from '../src/channels/feishu.js';
import { WorkspaceStore } from '../src/workspaces.js';
import { startFakeLLM } from './fake-llm.js';

const BASE = process.argv[2] || 'http://127.0.0.1:5175';
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-'));
const fake = await startFakeLLM();

const testConfig = {
  ...config,
  sessionsDir: path.join(tmp, '.sessions'),
  artifactsDir: path.join(tmp, '.artifacts'),
  trashDir: path.join(tmp, '.sessions-trash'),
  memoryDir: path.join(tmp, '.memory'),
  workflowsDir: path.resolve('workflows'),
  workspace: tmp,
  maxSteps: 3,
  maxAgentDepth: 1,
  maxConcurrentAgents: 1,
  modelTimeoutMs: 15000,
  modelRetries: 0,
  memoryTopK: 3,
  feishu: {
    enabled: false,
    cliCommand: process.execPath,
    cliPrefix: [],
    botName: '小助手',
    botAliases: ['Helper'],
    botOpenId: 'ou_bot_123',
    requireMention: true,
    replyInThread: true,
    workspaceId: 'default',
    workspaceByChat: {},
    approvalMode: 'auto',
    progressAfterMs: 60000,
    chunkSize: 3000,
    maxRestarts: 0,
  },
};

const store = new SessionStore({ dir: testConfig.sessionsDir, artifactsDir: testConfig.artifactsDir, trashDir: testConfig.trashDir });
const memory = new MemoryStore({ dir: testConfig.memoryDir, workspaceId: 'default' });
const workspaces = new WorkspaceStore({ file: path.join(tmp, '.workspaces.json'), defaultPath: tmp });
const tools = createToolRegistry();
const broker = new ApprovalBroker(1500);
const provider = () =>
  createProvider({ provider: 'custom', model: 'fake-1', baseUrl: fake.baseUrl, apiKey: 'k', retries: 0 });
const agents = createAgentRunner({ config: testConfig, store, tools, memory, createProvider: provider, policy: { broker } });
const workflows = createWorkflowEngine({ dir: testConfig.workflowsDir, agents, config: testConfig });

/** 记录所有「回复」调用，替代真实的 lark-cli */
const replies = [];
const cliCalls = [];
const fakeSpawn = (cmd, args) => {
  const rec = { cmd, args };
  cliCalls.push(args.join(' '));
  let stdout = '';
  if (args.includes('+messages-reply')) {
    const i = args.indexOf('--markdown') >= 0 ? args.indexOf('--markdown') : args.indexOf('--text');
    rec.messageId = args[args.indexOf('--message-id') + 1];
    rec.body = args[i + 1];
    rec.inThread = args.includes('--reply-in-thread');
    replies.push(rec);
  } else if (args.includes('chats') && args.includes('get')) {
    // 模拟 im chats get 返回群名
    stdout = JSON.stringify({ ok: true, data: { chat: { chat_id: args[args.indexOf('--chat-id') + 1], name: '研发一组' } } });
  } else if (args.includes('+chat-members-list')) {
    // 模拟群成员列表（说话人姓名来源）
    stdout = JSON.stringify({
      ok: true,
      data: {
        users: [
          { member_id: 'ou_alice', name: '爱丽丝' },
          { member_id: 'ou_bob', name: '小明' },
        ],
        bots: [{ member_id: 'ou_bot_123', name: '小助手' }],
      },
    });
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
};

const channel = createFeishuChannel({
  config: testConfig,
  store,
  workspaces,
  tools,
  memory,
  agents,
  workflows,
  broker,
  stateFile: path.join(tmp, '.channels', 'feishu.json'),
  log: () => {},
  spawnImpl: fakeSpawn,
  providerFactory: provider,
});

const events = [];
channel.onEvent((e) => events.push(e));

const msg = (over = {}) => ({
  type: 'im.message.receive_v1',
  message_id: `om_${Math.random().toString(36).slice(2, 10)}`,
  chat_id: 'oc_group_1',
  chat_type: 'group',
  message_type: 'text',
  sender_type: 'user',
  sender_id: 'ou_alice',
  sender_name: '爱丽丝',
  content: '@小助手 看一下这个项目',
  mentions: [{ id: 'ou_bot_123', key: '@_user_1', name: '小助手' }],
  create_time: String(Date.now()),
  ...over,
});

// ================= 1. @ 识别与过滤 =================
section('[1] 谁的消息才处理');
{
  replies.length = 0;
  const r1 = await channel.handleEvent(msg());
  ok('群里 @ 机器人 → 处理并回复', r1.ok && replies.length === 1, r1.ok ? replies[0].body.slice(0, 40).replace(/\n/g, ' ') : r1.reason);

  const r2 = await channel.handleEvent(msg({ message_id: 'om_nomention', mentions: [], content: '大家好' }));
  ok('群里没 @ 机器人 → 忽略', r2.reason === 'not_addressed', r2.reason);

  const r3 = await channel.handleEvent(msg({ sender_type: 'bot', mentions: [] }));
  ok('别的机器人发的 → 忽略', r3.reason === 'from_bot', r3.reason);

  const r4 = await channel.handleEvent(msg({ message_type: 'image', content: '' }));
  ok('非文本消息 → 忽略', r4.reason === 'unsupported_type', r4.reason);

  const dup = msg();
  const d1 = await channel.handleEvent(dup);
  const d2 = await channel.handleEvent(dup);
  ok('同一条消息重复投递只处理一次', d1.ok && d2.reason === 'duplicate', `${d1.ok} / ${d2.reason}`);

  const p2p = await channel.handleEvent(msg({ chat_id: 'oc_p2p_1', chat_type: 'p2p', mentions: [], content: '帮我看看构建' }));
  ok('私聊不需要 @ 也处理', p2p.ok, p2p.reason || '');

  const alias = await channel.handleEvent(msg({ message_id: 'om_alias', mentions: [{ id: 'ou_bot_123', key: '@_user_1', name: 'Helper' }], content: '@Helper 查个东西' }));
  ok('别名 @ 也认', alias.ok, alias.reason || '');

  const atText = await channel.handleEvent(msg({ message_id: 'om_empty', content: '@小助手', mentions: [{ id: 'ou_bot_123', key: '@_user_1', name: '小助手' }] }));
  ok('只 @ 不说话 → 回提示', atText.ok && /直接说需求/.test(replies.at(-1).body), replies.at(-1)?.body.slice(0, 30));
}

// ================= 2. 会话映射 =================
section('[2] 群/话题 → 会话映射');
{
  const s1 = channel.state.sessions['oc_group_1:main'];
  ok('群消息落到一个会话', Boolean(s1) && store.get(s1), s1);
  const state0 = s1;

  const sameAgain = await channel.handleEvent(msg({ chat_id: 'oc_group_1', content: '@小助手 再问一个' }));
  ok('同一个群继续用同一个会话', channel.state.sessions['oc_group_1:main'] === s1 && sameAgain.sessionId === s1);

  await channel.handleEvent(msg({ chat_id: 'oc_group_1', thread_id: 'omt_thread_a', message_id: 'om_t1', content: '@小助手 话题里问' }));
  const threadKey = channel.state.sessions['oc_group_1:omt_thread_a'];
  ok('不同话题用不同会话', Boolean(threadKey) && threadKey !== s1, threadKey);

  await channel.handleEvent(msg({ chat_id: 'oc_group_2', message_id: 'om_g2', content: '@小助手 另一个群' }));
  const other = channel.state.sessions['oc_group_2:main'];
  ok('不同群用不同会话', Boolean(other) && other !== s1, other);

  const sess = store.get(s1);
  ok('会话记录了来源（群/话题）', sess.channel?.type === 'feishu' && sess.channel.chatId === 'oc_group_1', JSON.stringify(sess.channel));
  ok('映射落盘可恢复', fs.existsSync(path.join(tmp, '.channels', 'feishu.json')));
  ok('会话里能看出说话人', (sess.messages[0]?.content || '').includes('爱丽丝'), (sess.messages[0]?.content || '').slice(0, 50));
  ok('自动查到了群名并写进标题', sess.title === '研发一组', sess.title);
  const g1Calls = cliCalls.filter((c) => c.includes('chats get') && c.includes('oc_group_1')).length;
  ok('同一群名只查一次（之后走缓存）', (await channel.ensureChatName('oc_group_1')) === '研发一组' && g1Calls === 1, `oc_group_1 查了 ${g1Calls} 次`);

  // 说话人姓名：事件里只有 open_id，得靠群成员列表补名字
  const sessNow = store.get(state0);
  const firstUserMsg = sessNow.messages.find((m) => m.role === 'user')?.content || '';
  ok('说话人被解析成姓名', firstUserMsg.includes('爱丽丝'), firstUserMsg.split('\n')[0].slice(0, 60));
  ok('同时保留 open_id（可追溯）', firstUserMsg.includes('ou_alice'));
  ok('姓名进了共享身份缓存', channel.identities.name('ou_alice') === '爱丽丝', JSON.stringify(channel.identities.list().users));
  ok('身份缓存落盘（digest 工具与历史回填共用）', fs.existsSync(path.join(tmp, '.channels', 'identities.json')));
  const memberCalls = cliCalls.filter((c) => c.includes('+chat-members-list') && c.includes('oc_group_1')).length;
  ok('同群成员列表只拉一次', memberCalls === 1, `${memberCalls} 次`);

  // 会话上记录真实生效的模型
  ok('会话记录本轮真实模型', sessNow.provider === 'custom' && sessNow.model === 'fake-1', `${sessNow.provider} · ${sessNow.model}`);
}

// ================= 2b. 零配置：自动学机器人 open_id =================
section('[2b] 免抄 open_id');
{
  const ch = createFeishuChannel({
    config: { ...testConfig, feishu: { ...testConfig.feishu, botOpenId: '' } },
    store,
    workspaces,
    tools,
    memory,
    agents,
    workflows,
    broker,
    stateFile: path.join(tmp, '.channels', 'feishu-learn.json'),
    log: () => {},
    spawnImpl: fakeSpawn,
    providerFactory: provider,
  });
  ok('初始不知道自己的 open_id', ch.status().botOpenId === null);
  await ch.handleEvent(msg({ chat_id: 'oc_learn', message_id: 'om_learn', mentions: [{ id: 'ou_real_bot', key: '@_user_1', name: '小助手' }] }));
  ok('从名字匹配里学到了 open_id', ch.status().botOpenId === 'ou_real_bot', ch.status().botOpenId);
  ok('学到之后按 id 判断 @', ch.state.botOpenId === 'ou_real_bot');
  const again = await ch.handleEvent(msg({ chat_id: 'oc_learn', message_id: 'om_learn2', mentions: [{ id: 'ou_real_bot', key: '@_user_1', name: '改了个名' }] }));
  ok('名字变了也能认出来（认 id 了）', again.ok, again.reason || '');
}

// ================= 3. 跨群记忆 =================
section('[3] 跨群信息聚合');
{
  // 在 A 群沉淀一条 workspace 级记忆
  const aSess = store.get(channel.state.sessions['oc_group_1:main']);
  memory.add({
    content: '项目 X 的发布窗口定在每周四下午', scope: 'workspace', category: 'knowledge',
    importance: 0.9, workspaceId: aSess.workspaceId, sessionId: aSess.id,
  });

  events.length = 0;
  await channel.handleEvent(msg({ chat_id: 'oc_group_2', message_id: 'om_recall', content: '@小助手 项目 X 什么时候发布？' }));
  const recall = events.find((e) => e.type === 'memory_recall');
  ok('B 群能召回 A 群沉淀的记忆', Boolean(recall) && recall.hits.some((h) => /发布窗口/.test(h.content)), recall ? recall.hits.map((h) => h.content).join(' | ').slice(0, 60) : '(无召回)');

  // 跨会话清单工具
  const listRes = await tools.execute('session_list', { limit: 10 }, {
    session: aSess,
    store,
    memory,
    workspaceId: aSess.workspaceId,
    config: testConfig,
  });
  ok('session_list 能跨会话列出最近对话', listRes.ok && /飞书/.test(listRes.content), listRes.content.split('\n')[1]?.slice(0, 70));

  const readRes = await tools.execute('session_read', { session: aSess.id, limit: 4 }, { session: aSess, store, memory, config: testConfig });
  ok('session_read 能读另一个群的对话', readRes.ok && readRes.content.includes('oc_group_1') === false && readRes.content.length > 20, readRes.content.split('\n')[0].slice(0, 60));
}

// ================= 3b. 模拟入站消息（不打扰真群） =================
section('[3b] 模拟入站消息');
{
  replies.length = 0;
  const r = await channel.simulate({
    chatId: 'oc_sim_group',
    senderId: 'ou_carol',
    senderName: '卡罗尔',
    content: '@小助手 你在吗',
  });
  ok('simulate 能跑完整一轮', r.ok && typeof r.answer === 'string' && r.answer.length > 0, (r.answer || '').slice(0, 40).replace(/\n/g, ' '));
  ok('simulate 不会真的往飞书发消息', replies.length === 0 && r.replies.length === 1, `真实回复 ${replies.length} 次 / 模拟 ${r.replies.length} 条`);
  ok('simulate 的会话照常落盘', Boolean(r.sessionId) && Boolean(store.get(r.sessionId)));
  const simSess = store.get(r.sessionId);
  ok('simulate 也带上说话人姓名', (simSess.messages[0]?.content || '').includes('卡罗尔'), (simSess.messages[0]?.content || '').split('\n')[0]);
  ok('不存在的会话不会误报', (await channel.simulate({ chatId: 'oc_empty', content: '' })).ok === true); // 空文本走提示分支
}

// ================= 3c. 谁做了什么（跨群人员视图） =================
section('[3c] 谁做了什么');
{
  // 用户2（小明）在另一个群干活
  await channel.simulate({ chatId: 'oc_group_b', senderId: 'ou_bob', senderName: '小明', content: '@小助手 帮我把部署脚本改一下' });
  await channel.simulate({ chatId: 'oc_group_b', senderId: 'ou_bob', senderName: '小明', content: '@小助手 再补一个回滚步骤' });

  const ctx = { session: store.get(channel.state.sessions['oc_group_1:main']), store, memory, workspaceId: 'default', config: testConfig, identities: channel.identities };

  const a = await tools.execute('user_activity', { user: '小明' }, ctx);
  ok('user_activity 能查到某人在哪个群干活', a.ok && /「小明」/.test(a.content) && /飞书群「/.test(a.content) && /「帮我把部署脚本改一下」/.test(a.content), a.content.split('\n')[0]);
  ok('能看到他提过什么要求', a.ok && /部署脚本|回滚步骤/.test(a.content), (a.content.match(/「.*?」 →/) || [''])[0].slice(0, 60));
  ok('不会把别人的会话混进来', !/爱丽丝/.test(a.content));

  const byId = await tools.execute('user_activity', { user: 'ou_bob' }, ctx);
  ok('用 open_id 也能查', byId.ok && /小明/.test(byId.content));

  const none = await tools.execute('user_activity', { user: '查无此人' }, ctx);
  ok('查不到时给出见过的说话人列表', none.ok && /没有找到/.test(none.content) && /ou_bob|小明/.test(none.content), none.content.replace(/\n/g, ' ').slice(0, 80));

  const list = await tools.execute('session_list', { user: '小明' }, ctx);
  ok('session_list 支持按人过滤', list.ok && /小明/.test(list.content) && !/爱丽丝/.test(list.content), list.content.split('\n')[1]?.slice(0, 60));

  const read = await tools.execute('session_read', { session: channel.state.sessions['oc_group_b:main'], limit: 10 }, ctx);
  ok('session_read 标出是谁说的', read.ok && /【小明】/.test(read.content), (read.content.match(/【小明】.*/) || [''])[0].slice(0, 50));

  // 结构化元数据要落盘（不只是正文前缀）
  const bSess = store.get(channel.state.sessions['oc_group_b:main']);
  const firstAsk = bSess.messages.find((m) => m.role === 'user');
  ok('消息上带结构化说话人', firstAsk.sender?.id === 'ou_bob' && firstAsk.sender?.name === '小明', JSON.stringify(firstAsk.sender));
  ok('结构化元数据含来源群', firstAsk.sender?.chatId === 'oc_group_b' && firstAsk.sender?.chatType === 'group');

  // trace 不能重复落盘（loop 已经写过了，通道别再写一遍）
  // 重复的老 bug 表现为：相邻两条事件完全一样
  const evs = store.readEvents(bSess.id, 500);
  let adjacentDup = 0;
  for (let i = 1; i < evs.length; i++) {
    if (JSON.stringify(evs[i]) === JSON.stringify(evs[i - 1])) adjacentDup++;
  }
  ok('trace 没有重复事件', adjacentDup === 0 && evs.length > 4, `相邻重复 ${adjacentDup} 对 / 共 ${evs.length} 条`);

  // FEISHU_CROSS_GROUP=0 时，跨群查询工具必须拒绝
  const blockedCtx = { ...ctx, config: { ...testConfig, crossGroup: false } };
  const blockedActivity = await tools.execute('user_activity', { user: '小明' }, blockedCtx);
  ok('关闭跨群后 user_activity 被拒', blockedActivity.ok && /已被关闭/.test(blockedActivity.content), blockedActivity.content.slice(0, 40));
  const blockedList = await tools.execute('session_list', {}, blockedCtx);
  ok('关闭跨群后 session_list 被拒', blockedList.ok && /已被关闭/.test(blockedList.content));
  const blockedRead = await tools.execute('session_read', { session: bSess.id }, blockedCtx);
  ok('关闭跨群后 session_read 被拒', blockedRead.ok && /已被关闭/.test(blockedRead.content));

  // 问答配对：每条要求要配它自己的回答，不能一律配会话最后一条助手消息
  const { pairsOf } = await import('../src/tools/digest.js');
  const demoMsgs = [
    { role: 'user', content: '甲：问题一', sender: { id: 'ou_a', name: '甲', at: 1 } },
    { role: 'assistant', content: '回答一' },
    { role: 'user', content: '乙：问题二', sender: { id: 'ou_b', name: '乙', at: 2 } },
    { role: 'assistant', content: '回答二' },
  ];
  const pairsA = pairsOf(demoMsgs, 'ou_a');
  ok('问答配对取的是自己那条的回答', pairsA.length === 1 && pairsA[0].answer === '回答一', JSON.stringify(pairsA));
  // 老消息（只有正文前缀、没有结构化字段）也要认得出来，且正文不带前缀
  const legacy = pairsOf([{ role: 'user', content: '[飞书群「X」 · ou_0000000000000000000000000000aaaa(ou_0000000000000000000000000000aaaa)] 老问题' }, { role: 'assistant', content: '老回答' }], 'ou_0000000000000000000000000000aaaa');
  ok('老消息（前缀形式）也能配对且去掉前缀', legacy.length === 1 && legacy[0].ask === '老问题', JSON.stringify(legacy));
}

// ================= 3d. 私聊隔离 =================
section('[3d] 私聊隔离');
{
  // 私聊里说的话
  const p = await channel.simulate({
    chatId: 'oc_p2p_private',
    chatType: 'p2p',
    senderId: 'ou_dave',
    senderName: '戴夫',
    content: '@小助手 我的工资卡号是 6222****，帮我记一下',
  });
  ok('私聊能正常处理', p.ok && Boolean(p.sessionId), p.reason || '');
  const pSess = store.get(p.sessionId);
  ok('私聊会话标记为 p2p', pSess.channel?.chatType === 'p2p', JSON.stringify(pSess.channel));

  const groupCtx = { session: store.get(channel.state.sessions['oc_group_1:main']), store, memory, identities: channel.identities, workspaceId: 'default', config: { ...testConfig, privateIsolation: true } };
  const privCtx = { session: pSess, store, memory, identities: channel.identities, workspaceId: 'default', config: { ...testConfig, privateIsolation: true } };

  const list = await tools.execute('session_list', { limit: 50 }, groupCtx);
  ok('群里的 session_list 看不到任何私聊', list.ok && !/私聊/.test(list.content), list.content.split('\n')[0]);

  const act = await tools.execute('user_activity', { user: '戴夫' }, groupCtx);
  ok('群里按人查不到私聊活动', act.ok && /没有找到/.test(act.content), act.content.split('\n')[0]);

  const read = await tools.execute('session_read', { session: p.sessionId }, groupCtx);
  ok('群里读别人的私聊被拒', read.ok && /隐私/.test(read.content), read.content.slice(0, 40));

  const selfRead = await tools.execute('session_read', { session: p.sessionId, limit: 5 }, privCtx);
  ok('私聊自己能读自己的', selfRead.ok && /工资卡号/.test(selfRead.content));

  // 私聊里写记忆必须降级为会话级
  const memCtx = { ...privCtx, memory, session: pSess, workspaceId: 'default' };
  const before = memory.stats().total;
  const added = await tools.execute('memory_add', { content: '戴夫的工资卡号尾号 1234', scope: 'workspace' }, memCtx);
  ok('私聊里写 workspace 记忆被降级为 session', added.ok && /已降级为 session/.test(added.content), added.content.slice(0, 70));
  const stored = memory.list({ sessionId: pSess.id, includeSession: true, limit: 500 }).find((m) => /工资卡号尾号/.test(m.content));
  ok('降级后确实只存在会话级', stored?.scope === 'session' && memory.stats().total === before + 1, `scope=${stored?.scope}`);

  // 关掉隔离开关后行为回到「可见」
  const openCtx = { ...groupCtx, config: { ...testConfig, privateIsolation: false } };
  const openRead = await tools.execute('session_read', { session: p.sessionId, limit: 5 }, openCtx);
  ok('关掉隔离后可以读（开关有效）', openRead.ok && /工资卡号/.test(openRead.content));
}

// ================= 4. 回复内容与分片 =================
section('[4] 回复');
{
  replies.length = 0;
  await channel.handleEvent(msg({ chat_id: 'oc_group_3', message_id: 'om_reply', content: '@小助手 说点什么' }));
  ok('回复到原消息（thread 内）', replies.length === 1 && replies[0].messageId === 'om_reply' && replies[0].inThread === true);
  ok('回复用 markdown 且带模型结论', /流式文本|我调用了/.test(replies[0].body), replies[0].body.slice(0, 50).replace(/\n/g, ' '));

  const long = 'A'.repeat(7000);
  const parts = chunkMessage(long, 3000);
  ok('超长回复会分片', parts.length === 3 && parts.every((p) => p.length <= 3000), `${parts.length} 片`);
  ok('空回复有兜底文案', chunkMessage('')[0] === '（没有产出内容）');
}

// ================= 5. 审批模式下不会卡死 =================
section('[5] 无人可问时的审批');
{
  const saved = channel.status;
  void saved;
  const strictConfig = { ...testConfig, feishu: { ...testConfig.feishu, approvalMode: 'ask' } };
  const ch2 = createFeishuChannel({
    config: strictConfig,
    store,
    workspaces,
    tools,
    memory,
    agents,
    workflows,
    broker: new ApprovalBroker(800), // 没人点 → 800ms 后自动拒绝
    stateFile: path.join(tmp, '.channels', 'feishu2.json'),
    log: () => {},
    spawnImpl: fakeSpawn,
    providerFactory: provider,
  });
  replies.length = 0;
  const r = await ch2.handleEvent(msg({ chat_id: 'oc_ask', message_id: 'om_ask', content: '创建 demo/x.txt 文件' }));
  ok('审批超时后仍能给出回复（不卡死）', r.ok && replies.length >= 1, replies.at(-1)?.body.slice(0, 60).replace(/\n/g, ' '));
}

// ================= 6. 真实子进程契约 =================
section('[6] 真实 lark-cli 子进程契约');
{
  const entry = config.feishu.cliPrefix[0];
  if (!fs.existsSync(entry)) {
    console.log('  ⊘ 本机没有 lark-cli，跳过（部署机上会跑）');
  } else {
    const p = spawn(process.execPath, [entry, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--timeout', '4s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    const code = await new Promise((res) => p.on('close', res));
    ok('能启动事件订阅并打出 ready 标记', /\[event\] ready event_key=im\.message\.receive_v1/.test(err));
    ok('超时后优雅退出（code 0）', code === 0, `code=${code}`);
    ok('退出原因可读', /reason: timeout/.test(err));
  }
}

// ================= 7. 服务接口 =================
section('[7] 服务接口');
{
  const r = await fetch(`${BASE}/api/channels`);
  const data = await r.json().catch(() => null);
  if (r.ok && data?.feishu) {
    const wasRunning = data.feishu.running === true;
    ok('GET /api/channels 返回飞书通道状态', typeof data.feishu.running === 'boolean', `running=${data.feishu.running} ready=${data.feishu.ready}`);
    ok('状态里带配置信息', data.feishu.requireMention !== undefined && 'approvalMode' in data.feishu);
    const started = await (await fetch(`${BASE}/api/channels/feishu/start`, { method: 'POST' })).json();
    await sleep(3500);
    const st = await (await fetch(`${BASE}/api/channels`)).json();
    ok('POST start 能拉起订阅', started.running === true && st.feishu.running === true, `ready=${st.feishu.ready}`);
    ok('订阅就绪标记变 true', st.feishu.ready === true);
    const stopped = await (await fetch(`${BASE}/api/channels/feishu/stop`, { method: 'POST' })).json();
    ok('POST stop 能停掉订阅', stopped.running === false);
    // 测试不能把正在跑的通道留在停止状态
    if (wasRunning) {
      await fetch(`${BASE}/api/channels/feishu/start`, { method: 'POST' });
      let back = null;
      for (let i = 0; i < 20; i++) {
        await sleep(700);
        back = await (await fetch(`${BASE}/api/channels`)).json();
        if (back.feishu.running && back.feishu.ready) break;
      }
      ok('测试结束后恢复原有运行状态', back.feishu.running === true, `ready=${back.feishu.ready}`);
    }
  } else {
    console.log('  ⊘ 服务未运行或版本较旧，跳过接口检查');
  }
}

await fake.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✓' : '✗'} 飞书通道测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
