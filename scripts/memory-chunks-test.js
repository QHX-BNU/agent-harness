// 记忆分块专项：迁移 / user.md·soul.md·preference.md 读写 / 手改回读 / 注入预算 / 工具层。
// 用法: node scripts/memory-chunks-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore, CHUNK_NAMES, inferChunk, parseChunkMarkdown } from '../src/memory.js';
import { createToolRegistry } from '../src/tools/index.js';
import { buildSystemPrompt } from '../src/context.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-chunks-'));
const dir = path.join(tmp, '.memory');
fs.mkdirSync(dir, { recursive: true });

// 老格式：全是 memory.json，global anchor / global self 应该被迁移进画像
const legacy = [
  { id: 1, content: '用户在 GitHub 上是 QHX-BNU', scope: 'global', category: 'anchor', importance: 0.9, tags: ['身份'], createdAt: 1, updatedAt: 1, loads: 0 },
  { id: 2, content: '回答一律用中文', scope: 'global', category: 'self', importance: 0.9, tags: [], createdAt: 1, updatedAt: 1, loads: 0 },
  { id: 3, content: '这个项目不引入第三方依赖', scope: 'workspace', category: 'structure', importance: 0.8, tags: ['约定'], workspace: 'default', createdAt: 1, updatedAt: 1, loads: 0 },
  { id: 4, content: '本轮在测记忆', scope: 'session', category: 'situation', importance: 0.3, tags: [], sessionId: 's-1', createdAt: 1, updatedAt: 1, loads: 0 },
];
fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(legacy, null, 2), 'utf8');

console.log('记忆分块测试\n');

section('[1] 迁移：老数据按 scope/category 归块');
{
  const m = new MemoryStore({ dir });
  const stats = m.stats();
  ok('三条画像文件都生成了', CHUNK_NAMES.every((n) => fs.existsSync(path.join(dir, `${n}.md`))));
  ok('global/anchor → user.md', m.chunkItems('user').some((i) => i.content.includes('QHX-BNU') && i.id === 1));
  ok('global/self → preference.md', m.chunkItems('preference').some((i) => i.content.includes('中文') && i.id === 2));
  ok('画像条目强制 global', m.chunkItems('user').every((i) => i.scope === 'global'));
  ok('workspace/session 条目留在 memory.json', JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')).map((i) => i.id).join(',') === '3,4');
  ok('迁移有记录（可审计）', stats.migrated.length === 2, JSON.stringify(stats.migrated.map((x) => `#${x.id}→${x.to}`)));
  ok('byChunk 统计正确', stats.byChunk.user === 1 && stats.byChunk.preference === 1 && stats.byChunk.json === 2, JSON.stringify(stats.byChunk));

  const text = fs.readFileSync(path.join(dir, 'user.md'), 'utf8');
  ok('md 文件头写明用途', text.includes('# user.md') && /一行一条/.test(text));
  ok('md 行带元数据注释', /- .+ <!-- id=1 scope=global category=anchor importance=0\.90/.test(text));
  ok('第二次加载不重复迁移', new MemoryStore({ dir }).stats().migrated.length === 0);
}

section('[2] 写：chunk / auto / none');
{
  const m = new MemoryStore({ dir });
  const u = m.add({ content: '常用模型：deepseek / qwen', chunk: 'user' });
  ok('显式 chunk=user 落进 user.md', u.chunk === 'user' && fs.readFileSync(path.join(dir, 'user.md'), 'utf8').includes('deepseek'));
  const s = m.add({ content: '说话直接，别客套', scope: 'global', category: 'self', chunk: 'soul' });
  ok('chunk=soul 落进 soul.md', s.chunk === 'soul' && fs.readFileSync(path.join(dir, 'soul.md'), 'utf8').includes('别客套'));
  const auto = m.add({ content: '用户喜欢深色主题', scope: 'global', category: 'self', chunk: 'auto' });
  ok('chunk=auto 按 category 推断', auto.chunk === 'preference');
  const none = m.add({ content: '临时事实', scope: 'workspace', category: 'knowledge', chunk: 'none' });
  ok('chunk=none 只进结构化记忆', none.chunk === null && JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')).some((i) => i.id === none.id));
  ok('inferChunk 只在 global 生效', inferChunk({ scope: 'workspace', category: 'anchor' }) === null && inferChunk({ scope: 'global', category: 'anchor' }) === 'user');
  const forced = m.add({ content: '画像条目不该带工作区', scope: 'workspace', category: 'knowledge', chunk: 'preference' });
  ok('带 chunk 时强制 global（不会串工作区）', forced.scope === 'global' && forced.workspace === null);
  ok('跨行内容被压成一行', m.add({ content: '第一行\n第二行', chunk: 'soul' }).content === '第一行 第二行');
}

section('[3] 手改 md：下一轮读回来');
{
  const file = path.join(dir, 'preference.md');
  fs.appendFileSync(file, '- 配图一律 1080×1440（3:4）\n', 'utf8');
  const m = new MemoryStore({ dir });
  const items = m.chunkItems('preference');
  ok('手写的一行被读成条目', items.some((i) => i.content.includes('1080×1440')));
  const hand = items.find((i) => i.content.includes('1080×1440'));
  ok('手写行自动补 id/元数据', Number.isInteger(hand.id) && /<!-- id=\d+/.test(fs.readFileSync(file, 'utf8')));
  const again = new MemoryStore({ dir });
  ok('再加载 id 不变（已归一化写回）', again.chunkItems('preference').find((i) => i.content.includes('1080×1440')).id === hand.id);
  ok('删掉 md 里的行就等于删记忆', (() => {
    const raw = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('1080×1440')).join('\n');
    fs.writeFileSync(file, raw, 'utf8');
    return !new MemoryStore({ dir }).chunkItems('preference').some((i) => i.content.includes('1080×1440'));
  })());
}

section('[4] 整块替换（UI 编辑入口）');
{
  const m = new MemoryStore({ dir });
  const items = m.setChunkText('soul', '# 手写\n\n- 先给结论，再给理由\n- 不确定就说不确定\n- 不写空洞的鼓励\n');
  ok('整块替换后条目数正确', items.length === 3, items.map((i) => i.content).join(' / '));
  ok('整块替换后文件被重写', /先给结论/.test(fs.readFileSync(path.join(dir, 'soul.md'), 'utf8')));
  const same = m.setChunkText('soul', fs.readFileSync(path.join(dir, 'soul.md'), 'utf8'));
  ok('整块替换保留原有 id（改一行不会全库重编号）', same.map((i) => i.id).sort().join(',') === items.map((i) => i.id).sort().join(','), same.map((i) => i.id).join(','));
  ok('解析器忽略标题与注释', parseChunkMarkdown('# 标题\n<!-- 注释 -->\n- 只有这行\n').length === 1);
}

section('[5] 注入：常驻画像 vs 按需召回');
{
  const m = new MemoryStore({ dir });
  const profile = m.profile({ maxChars: 4000 });
  ok('profile 含三块标题', /user\.md/.test(profile.text) && /soul\.md/.test(profile.text) && /preference\.md/.test(profile.text));
  ok('profile 含条目内容', profile.text.includes('QHX-BNU') && profile.text.includes('先给结论'));
  const small = m.profile({ maxChars: 200 });
  // 先塞长内容，才能在 200 字符预算下验证截断
  m.add({ content: `补充背景：${'很长的一段背景描述。'.repeat(20)}`, chunk: 'user' });
  const tight = m.profile({ maxChars: 200 });
  ok(
    '超预算会截断且不越界',
    tight.truncated.length > 0 && tight.text.includes('…') && tight.text.length <= tight.maxChars,
    `${tight.text.length}<=${tight.maxChars} · 截断 ${tight.truncated.join(',')} · 空预算=${small.text.length}`,
  );
  const recall = m.recall('QHX-BNU', { sessionId: null, topK: 5 });
  ok('自动召回排除画像条目（避免重复注入）', !recall.text.includes('QHX-BNU'), JSON.stringify(recall.text.slice(0, 40)));
  const search = m.search({ query: 'QHX-BNU', topK: 5 });
  ok('显式检索能找到画像条目', search.some((h) => h.item.chunk === 'user'));
  ok('list 可按 chunk 过滤', m.list({ chunk: 'soul', limit: 10 }).every((i) => i.chunk === 'soul'));
}

section('[6] 更新 / 删除 / 移块');
{
  const m = new MemoryStore({ dir });
  const target = m.chunkItems('user')[0];
  m.update(target.id, { content: '用户在 GitHub 上是 QHX-BNU（改过）', importance: 0.95 });
  ok('更新画像条目会写回 md', fs.readFileSync(path.join(dir, 'user.md'), 'utf8').includes('（改过）'));
  ok('更新后仍常驻', m.profile().text.includes('（改过）'));
  const moved = m.update(target.id, { chunk: 'soul' });
  ok('可以把条目移到另一块画像', moved.chunk === 'soul' && /（改过）/.test(fs.readFileSync(path.join(dir, 'soul.md'), 'utf8')));
  const back = m.update(target.id, { chunk: null });
  ok('也可以移回结构化记忆', back.chunk === null && !fs.readFileSync(path.join(dir, 'soul.md'), 'utf8').includes('（改过）'));
  ok('删除画像条目同步删 md 行', (() => {
    const item = m.chunkItems('preference')[0];
    m.remove(item.id);
    return !fs.readFileSync(path.join(dir, 'preference.md'), 'utf8').includes(item.content) && !m.get(item.id);
  })());
}

section('[7] 工具层');
{
  const m = new MemoryStore({ dir: path.join(tmp, '.memory2') });
  const tools = createToolRegistry();
  const ctx = { memory: m, session: { id: 's1' }, workspaceId: 'default', config: {}, emit: () => {} };
  const add = await tools.execute('memory_add', { content: '用户在日本', scope: 'global', category: 'anchor', chunk: 'user' }, ctx);
  ok('memory_add 支持 chunk', add.ok && /user\.md/.test(add.content), add.content.slice(0, 50));
  const prof = await tools.execute('memory_profile', {}, ctx);
  ok('memory_profile 读出三块原文', prof.ok && prof.content.includes('# user.md') && prof.content.includes('日本'));
  const list = await tools.execute('memory_list', { chunk: 'user' }, ctx);
  ok('memory_list 支持 chunk 过滤', list.ok && list.content.includes('日本'));
  const search = await tools.execute('memory_search', { query: '日本' }, ctx);
  ok('memory_search 标出画像来源', search.ok && /user\.md/.test(search.content), search.content.slice(0, 40));
  const id = m.chunkItems('user')[0].id;
  const upd = await tools.execute('memory_update', { id, content: '用户在东京' }, ctx);
  ok('memory_update 改画像条目', upd.ok && m.get(id).content === '用户在东京');
  const del = await tools.execute('memory_remove', { id }, ctx);
  ok('memory_remove 删条目', del.ok && m.get(id) === null);
  ok('没有 memory 的 ctx 不会崩', (await tools.execute('memory_list', {}, { session: { id: 'x' } })).content.includes('已关闭'));
  const privateCtx = { ...ctx, config: { memoryScopeOverride: 'session' }, session: { id: 'p2p', channel: { type: 'feishu', chatType: 'p2p' } } };
  const blocked = await tools.execute('memory_add', { content: '不该进画像', scope: 'global', category: 'anchor', chunk: 'user' }, privateCtx);
  ok('私聊场景不允许写常驻画像', /不允许写入常驻画像/.test(blocked.content), blocked.content.slice(0, 40));
}

section('[8] 系统提示组装');
{
  const m = new MemoryStore({ dir });
  const prompt = buildSystemPrompt({
    workspace: tmp,
    tools: [],
    approvalMode: 'ask',
    model: 'mock-1',
    profileText: m.profile().text,
    memoryText: '- [#3 workspace/structure] 不引入第三方依赖',
    skills: [{ name: 'xhs-post', description: '发布小红书帖子', when: '要发帖时', files: 2 }],
  });
  ok('提示里有长期画像段', /## 长期画像/.test(prompt) && prompt.includes('QHX-BNU'));
  ok('提示里有相关长期记忆段', /## 相关长期记忆/.test(prompt) && prompt.includes('不引入第三方依赖'));
  ok('提示里有技能清单与用法', /## 可用技能/.test(prompt) && /skill_read\(name\)/.test(prompt) && /要发帖时/.test(prompt));
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录留给系统清 */
}
console.log(`\n${fail === 0 ? '✓' : '✗'} 记忆分块测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
