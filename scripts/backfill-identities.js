// 把真实姓名/群名回填进身份缓存：历史会话里存的是 open_id，靠这个补成真名。
// 用法: node scripts/backfill-identities.js [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { config } from '../src/config.js';
import { IdentityStore } from '../src/identities.js';
import { SessionStore } from '../src/store.js';

const ENTRY = config.feishu.cliPrefix[0];
const identities = new IdentityStore({ file: path.join(config.sessionsDir, '..', '.channels', 'identities.json') });
const store = new SessionStore({
  dir: config.sessionsDir,
  artifactsDir: config.artifactsDir,
  trashDir: config.trashDir,
});

const run = (args) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, out, err }));
  });

// 1) 收集所有会话里出现过的 chat_id / open_id
const chats = new Map();
const users = new Map(); // id -> 出现次数
for (const s of store.list({ includeChildren: true })) {
  const full = store.get(s.id);
  if (full?.channel?.chatId) chats.set(full.channel.chatId, full.title);
  for (const m of full?.messages || []) {
    if (m.sender?.id) users.set(m.sender.id, (users.get(m.sender.id) || 0) + 1);
    const hit = /\((ou_[A-Za-z0-9]+)\)\]/.exec(String(m.content || ''));
    if (hit) users.set(hit[1], (users.get(hit[1]) || 0) + 1);
  }
}
console.log(`发现 ${chats.size} 个群、${users.size} 个说话人`);

// 2) 逐群拉成员列表 → 显示名；再用通讯录换成组织真名（localized_name）
let resolved = 0;
const allIds = new Set();
for (const chatId of chats.keys()) {
  for (const identity of ['user', 'bot']) {
    const r = await run(['im', '+chat-members-list', '--chat-id', chatId, '--as', identity]);
    if (!r.ok && r.code !== 0) continue;
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
      const map = {};
      for (const u of j?.data?.users || []) if (u.member_id && u.name) map[u.member_id] = u.name;
      for (const b of j?.data?.bots || []) if (b.member_id && b.name) map[b.member_id] = b.name;
      if (Object.keys(map).length) {
        resolved += identities.setUsers(map);
        for (const id of Object.keys(map)) allIds.add(id);
        console.log(`  ${chatId} → ${Object.values(map).join(', ')}`);
        break;
      }
    } catch {
      /* 换下一个身份 */
    }
  }
}

// 2b) 通讯录真名：群成员列表给的是「群内显示名」，组织里的名字才准
if (allIds.size) {
  const ids = [...allIds].filter((id) => id.startsWith('ou_'));
  const r = await run(['contact', '+search-user', '--user-ids', ids.join(','), '--as', 'user']);
  if (r.code === 0 && r.out.trim()) {
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
      let n = 0;
      for (const u of j?.data?.users || []) {
        const name = u.localized_name || u.name;
        if (u.open_id && name) {
          identities.setOrgName(u.open_id, name);
          n++;
          console.log(`  组织真名: ${u.open_id} → ${name}`);
        }
      }
      console.log(`  通讯录换了 ${n} 个真名`);
    } catch {
      /* 忽略 */
    }
  } else {
    console.log('  通讯录查询失败（需要 user 身份授权 contact 权限），沿用群内显示名');
  }
}

// 3) 群名也补上
for (const chatId of chats.keys()) {
  const r = await run(['im', 'chats', 'get', '--chat-id', chatId, '--as', 'bot']);
  try {
    const j = JSON.parse(r.out);
    const name = j?.data?.chat?.name || j?.data?.name;
    if (name) {
      identities.setChat(chatId, name);
      console.log(`  群名: ${chatId} → ${name}`);
    }
  } catch {
    /* 忽略 */
  }
}

const { users: u, chats: c } = identities.list();
console.log(`\n身份缓存已更新：${u.length} 个人、${c.length} 个群（本次新解析 ${resolved} 个姓名）`);
console.log(`文件: ${identities.file}`);
for (const x of u) console.log(`  ${x.name}${x.alias ? `（别名 ${x.alias}）` : ''}${x.org ? `（组织名 ${x.org}）` : ''}  ${x.id}`);
for (const x of c) console.log(`  群「${x.name}」  ${x.id}`);
