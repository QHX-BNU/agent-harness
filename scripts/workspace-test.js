// 多工作区专项测试：数据层 / 文件工具按工作区隔离 / 会话归属 / 记忆隔离 / 界面分组。
// 用法: node scripts/workspace-test.js [baseUrl]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceStore, DEFAULT_WORKSPACE_ID } from '../src/workspaces.js';
import { openPage } from './cdp.js';

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
const j = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  return { status: r.status, data: await r.json().catch(() => null) };
};
const post = (p, body) =>
  j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

/** 清掉测试留下的工作区（只认临时目录下的，绝不动用户的） */
async function cleanupTestWorkspaces() {
  const all = (await j('/api/workspaces')).data?.items || [];
  let removed = 0;
  for (const w of all) {
    if (w.id === 'default') continue;
    if (!w.path.startsWith(os.tmpdir())) continue;
    for (const s of (await j(`/api/sessions?workspaceId=${w.id}&children=1`)).data || []) {
      await fetch(`${BASE}/api/sessions/${s.id}?hard=1`, { method: 'DELETE' });
    }
    await fetch(`${BASE}/api/workspaces/${w.id}`, { method: 'DELETE' });
    removed++;
  }
  return removed;
}

// 开跑前先清干净，避免上次失败残留把断言搞乱
const cleaned = await cleanupTestWorkspaces();

// 两个临时目录当工作区
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'wsA-'));
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'wsB-'));
fs.writeFileSync(path.join(tmpA, 'only-in-A.txt'), 'AAA\n');
fs.writeFileSync(path.join(tmpB, 'only-in-B.txt'), 'BBB\n');

// ================= 1. WorkspaceStore =================
section('[1] 工作区存储');
{
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsstore-')), '.workspaces.json');
  const ws = new WorkspaceStore({ file, defaultPath: tmpA });
  ok('自动创建默认工作区', ws.list().length === 1 && ws.list()[0].id === DEFAULT_WORKSPACE_ID, ws.list()[0]?.path);
  ok('默认工作区指向给定目录', ws.get(DEFAULT_WORKSPACE_ID).path === path.resolve(tmpA));

  const b = ws.create({ name: 'B 工作区', path: tmpB });
  ok('可以创建新工作区', ws.list().length === 2 && b.path === path.resolve(tmpB), b.id);
  ok('同名目录不能重复添加', (() => { try { ws.create({ path: tmpB }); return false; } catch { return true; } })());
  ok('不存在的目录被拒绝', (() => { try { ws.create({ path: path.join(tmpA, '不存在') }); return false; } catch (e) { return /不存在/.test(e.message); } })());
  ok('文件（非目录）被拒绝', (() => { try { ws.create({ path: path.join(tmpA, 'only-in-A.txt') }); return false; } catch (e) { return /不是目录/.test(e.message); } })());

  ws.update(b.id, { name: 'B 改名' });
  ok('可以重命名', ws.get(b.id).name === 'B 改名');
  ok('默认工作区不能删', (() => { try { ws.remove(DEFAULT_WORKSPACE_ID); return false; } catch (e) { return /不能删除/.test(e.message); } })());
  ws.remove(b.id);
  ok('可以删除非默认工作区', ws.list().length === 1);
  ok('描述里带会话数与会话存在性', (() => { const d = ws.describe({ [DEFAULT_WORKSPACE_ID]: 3 })[0]; return d.sessions === 3 && d.exists === true; })());
  ok('配置持久化到磁盘', JSON.parse(fs.readFileSync(file, 'utf8')).workspaces.length === 1);
}

// ================= 2. HTTP：工作区 + 会话归属 =================
section('[2] HTTP：工作区 CRUD 与会话归属');
let wsA;
let wsB;
let sessionA;
let sessionB;
{
  // 用两个 uuid 临时目录，避免污染
  const list0 = await j('/api/workspaces');
  ok('GET /api/workspaces 返回默认工作区', list0.status === 200 && list0.data.items.some((w) => w.id === 'default'));

  const mkA = await post('/api/workspaces', { name: 'A 工作区', path: tmpA });
  const mkB = await post('/api/workspaces', { name: 'B 工作区', path: tmpB });
  wsA = mkA.data;
  wsB = mkB.data;
  ok('POST /api/workspaces 建 A', mkA.status === 201 && wsA.path === path.resolve(tmpA), wsA.id);
  ok('POST /api/workspaces 建 B', mkB.status === 201 && wsB.path === path.resolve(tmpB), wsB.id);
  ok('重复目录被拒', (await post('/api/workspaces', { path: tmpA })).status === 400);
  ok('坏目录被拒并给原因', /不存在|不是目录/.test((await post('/api/workspaces', { path: path.join(tmpA, 'nope') })).data?.error || ''));

  const sA = await post('/api/sessions', { workspaceId: wsA.id, title: 'A 的会话' });
  const sB = await post('/api/sessions', { workspaceId: wsB.id, title: 'B 的会话' });
  sessionA = sA.data;
  sessionB = sB.data;
  ok('会话带上 workspaceId', sA.data.workspaceId === wsA.id && sB.data.workspaceId === wsB.id, `${sessionA.workspaceId} / ${sessionB.workspaceId}`);

  const all = await j('/api/sessions');
  ok('会话列表能按工作区过滤', (await j(`/api/sessions?workspaceId=${wsA.id}`)).data.every((s) => s.workspaceId === wsA.id));
  ok('不带过滤返回全部', all.data.some((s) => s.id === sessionA.id) && all.data.some((s) => s.id === sessionB.id));

  const detail = await j(`/api/sessions/${sessionA.id}`);
  ok('会话详情带 workspaceId', detail.data.workspaceId === wsA.id);

  const counts = (await j('/api/workspaces')).data.items;
  ok('工作区列表带会话计数', counts.find((w) => w.id === wsA.id).sessions >= 1, `A=${counts.find((w) => w.id === wsA.id).sessions}`);

  const renamed = await j(`/api/workspaces/${wsA.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'A 改名了' }),
  });
  ok('PATCH 重命名工作区', renamed.data.workspace.name === 'A 改名了');
}

// ================= 3. 文件工具按会话的工作区解析 =================
section('[3] 文件工具以「会话所属工作区」为根');
{
  // 注意：假模型「看到历史里有工具结果就只做总结」，所以每次都要用新会话
  const freshSession = async (wsId, title) => (await post('/api/sessions', { workspaceId: wsId, title })).data;

  const runChat = async (sessionId, message) => {
    const text = await (
      await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, message, approvalMode: 'auto' }),
      })
    ).text();
    return text
      .split('\n\n')
      .map((f) => f.split('\n').find((l) => l.startsWith('data:')))
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l.slice(5));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  };

  // A 工作区的会话 → 只应看到 A 的文件
  const sA1 = await freshSession(wsA.id, 'A-列目录');
  const evA = await runChat(sA1.id, '列一下工作区有什么');
  const sandboxA = evA.find((e) => e.type === 'sandbox');
  const toolA = evA.find((e) => e.type === 'tool_result');
  ok('沙箱根目录 = 会话的工作区', sandboxA?.roots?.[0] === path.resolve(tmpA), sandboxA?.roots?.[0]);
  ok('工具结果里出现 A 的文件', /only-in-A/.test(toolA?.content || ''), (toolA?.content || '').slice(0, 60).replace(/\n/g, ' '));
  ok('看不到 B 的文件', !/only-in-B/.test(toolA?.content || ''));

  // B 工作区的会话 → 看 B
  const sB1 = await freshSession(wsB.id, 'B-列目录');
  const evB = await runChat(sB1.id, '列一下工作区有什么');
  const toolB = evB.find((e) => e.type === 'tool_result');
  ok('B 会话看到的是 B 的文件', /only-in-B/.test(toolB?.content || '') && !/only-in-A\.txt/.test(toolB?.content || ''), (toolB?.content || '').slice(0, 50).replace(/\n/g, ' '));

  // 跨工作区：A 的会话用相对路径穿越到 B（新会话，保证会真的发起工具调用）
  const escapeRel = path.relative(tmpA, path.join(tmpB, 'only-in-B.txt')).split(path.sep).join('/');
  const evCross = await runChat((await freshSession(wsA.id, 'A-穿越')).id, `读一下 ${escapeRel}`);
  const crossResult = evCross.find((e) => e.type === 'tool_result');
  ok('A 的会话用相对路径穿越到 B 被拦', /沙箱拒绝|不在允许的范围/.test(crossResult?.content || ''), (crossResult?.content || '(无工具结果)').slice(0, 70));

  // 跨工作区：绝对路径（正斜杠形式，假模型能原样传给工具）
  const absForward = path.join(tmpB, 'only-in-B.txt').split(path.sep).join('/');
  const evCross2 = await runChat((await freshSession(wsA.id, 'A-绝对路径')).id, `读一下 ${absForward}`);
  const crossResult2 = evCross2.find((e) => e.type === 'tool_result');
  ok('A 的会话读 B 的绝对路径被拦', /沙箱拒绝|不在允许的范围/.test(crossResult2?.content || ''), (crossResult2?.content || '(无工具结果)').slice(0, 70));

  // 写操作同理：A 的会话不能往 B 写
  const evWrite = await runChat((await freshSession(wsA.id, 'A-越界写')).id, `创建 ${path.join(tmpB, 'x.txt').split(path.sep).join('/')} 文件`);
  const writeResult = evWrite.find((e) => e.type === 'tool_result');
  ok('A 的会话往 B 写文件被拦', /沙箱拒绝|不在允许的范围/.test(writeResult?.content || ''), (writeResult?.content || '(无工具结果)').slice(0, 70));
}

// ================= 4. 记忆按工作区隔离 =================
section('[4] workspace 级记忆按工作区分区');
{
  // 这两条是测试数据，跑完必须删掉：不然会一直堆在真实记忆库里（列表/召回都被污染）
  const memA = (await post('/api/memory', { content: '这条记忆属于 A 工作区', scope: 'workspace', workspaceId: wsA.id, importance: 0.9 })).data;
  const memB = (await post('/api/memory', { content: '这条记忆属于 B 工作区', scope: 'workspace', workspaceId: wsB.id, importance: 0.9 })).data;
  try {
    const listA = (await j(`/api/memory?workspaceId=${wsA.id}&includeSession=0`)).data.items;
    const listB = (await j(`/api/memory?workspaceId=${wsB.id}&includeSession=0`)).data.items;
    ok('A 只看到 A 的 workspace 记忆', listA.some((m) => /属于 A/.test(m.content)) && !listA.some((m) => /属于 B/.test(m.content)), `${listA.length} 条`);
    ok('B 只看到 B 的 workspace 记忆', listB.some((m) => /属于 B/.test(m.content)) && !listB.some((m) => /属于 A/.test(m.content)), `${listB.length} 条`);

    const searchA = (await post('/api/memory/search', { query: '记忆属于哪个工作区', topK: 5, workspaceId: wsA.id, includeSession: false })).data;
    ok('检索也按工作区过滤', searchA.length > 0 && searchA.every((h) => !/属于 B/.test(h.item.content)), searchA.map((h) => h.item.content).join(' | ').slice(0, 60));
  } finally {
    for (const m of [memA, memB]) {
      if (m?.id) await fetch(`${BASE}/api/memory/${m.id}`, { method: 'DELETE' }).catch(() => {});
    }
    const left = (await j(`/api/memory?workspaceId=${wsA.id}&includeSession=0`)).data.items.filter((m) => /属于 A|属于 B/.test(m.content));
    ok('测试记忆已清理（不留在真实记忆库）', left.length === 0, left.map((m) => `#${m.id}`).join(','));
  }
}

// ================= 5. 界面：分组侧栏 =================
section('[5] 界面：左栏按工作区分组');
{
  const page = await openPage(BASE, { port: 9347, outDir: 'docs', freshProfile: true, width: 1400, height: 900 });
  const { evalJs, waitFor, shot, sleep: wait } = page;
  try {
    await waitFor(`document.body.dataset.ready === '1'`, '前端就绪');
    await wait(600);
    const groups = JSON.parse(
      await evalJs(`JSON.stringify({
        groups: document.querySelectorAll('#sessionList .ws-group').length,
        names: [...document.querySelectorAll('#sessionList .ws-name')].map(n => n.textContent),
        counts: [...document.querySelectorAll('#sessionList .ws-count')].map(n => n.textContent),
        hasAddBtn: document.querySelectorAll('#sessionList .ws-btn.add').length,
        hasNewWsBtn: !!document.getElementById('newWorkspace'),
        sessionsUnderA: document.querySelectorAll('#sessionList .ws-group:nth-child(2) .session-item').length,
      })`),
    );
    ok('侧栏按工作区分组', groups.groups >= 3, `${groups.groups} 组：${groups.names.join(' / ')}`);
    ok('每组显示会话计数', groups.counts.length === groups.groups, groups.counts.join(','));
    ok('每个工作区有「新建会话」按钮', groups.hasAddBtn === groups.groups);
    ok('顶部有「新建工作区」按钮', groups.hasNewWsBtn);
    ok('会话挂在对应工作区下面', groups.sessionsUnderA >= 1, `A 组 ${groups.sessionsUnderA} 个会话`);

    // 新建工作区（走界面弹窗）
    await evalJs(`document.getElementById('newWorkspace').click(); true`);
    await waitFor(`!document.getElementById('wsModal').hidden`, '新建工作区弹窗');
    const badTry = await evalJs(`
      (() => {
        document.getElementById('wsName').value = '坏目录';
        document.getElementById('wsPath').value = 'D:\\\\不存在的目录\\\\xyz';
        document.getElementById('wsCreate').click();
        return true;
      })()
    `);
    void badTry;
    await waitFor(`document.getElementById('wsError').textContent.length > 0`, '错误提示');
    const errText = await evalJs(`document.getElementById('wsError').textContent`);
    ok('界面会拒绝不存在的目录并提示', /不存在/.test(errText), errText.slice(0, 50));

    const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'wsC-'));
    const uiWsName = `界面新建-${path.basename(tmpC).slice(-6)}`;
    await evalJs(`
      (() => {
        document.getElementById('wsName').value = ${JSON.stringify(uiWsName)};
        document.getElementById('wsPath').value = ${JSON.stringify(tmpC)};
        document.getElementById('wsCreate').click();
        return true;
      })()
    `);
    await waitFor(`[...document.querySelectorAll('#sessionList .ws-name')].some(n => n.textContent === ${JSON.stringify(uiWsName)})`, '新工作区出现在侧栏', 15000);
    ok('界面创建的工作区出现在侧栏', true, uiWsName);

    // 在指定工作区里新建会话
    await evalJs(`
      (() => {
        const names = [...document.querySelectorAll('#sessionList .ws-name')];
        const target = names.find(n => n.textContent === ${JSON.stringify(uiWsName)});
        target.closest('.ws-head').querySelector('.ws-btn.add').click();
        return true;
      })()
    `);
    await waitFor(
      `[...document.querySelectorAll('#sessionList .ws-name')].find(n => n.textContent === ${JSON.stringify(uiWsName)}).closest('.ws-group').querySelectorAll('.session-item').length === 1`,
      '新会话挂到该工作区下',
      15000,
    );
    ok('新会话挂到该工作区下', true);
    const wsOfNew = await j(`/api/sessions?workspaceId=${(await j('/api/workspaces')).data.items.find((w) => w.name === uiWsName).id}`);
    ok('新会话确实记在该工作区下', wsOfNew.data.length === 1, `${wsOfNew.data.length} 个`);

    // 折叠/展开
    const before = await evalJs(`document.querySelectorAll('#sessionList .session-item').length`);
    await evalJs(`document.querySelector('#sessionList .ws-head').click(); true`);
    await wait(400);
    const after = await evalJs(`document.querySelectorAll('#sessionList .session-item').length`);
    ok('点工作区标题可折叠', after <= before, `${before} → ${after}`);
    await evalJs(`document.querySelector('#sessionList .ws-head').click(); true`);
    await wait(400);
    ok('再点一次展开', (await evalJs(`document.querySelectorAll('#sessionList .session-item').length`)) === before);

    const f = await shot('ui-workspaces.png');
    console.log(`  ✓ 工作区分组截图 → ${f}`);
  } finally {
    page.close();
  }
}

// 清理：只清掉本次测试建的（路径在临时目录下的）工作区及其会话，不动用户的
const cleanedAtEnd = await cleanupTestWorkspaces();
for (const tmp of [tmpA, tmpB]) fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✓' : '✗'} 多工作区测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
