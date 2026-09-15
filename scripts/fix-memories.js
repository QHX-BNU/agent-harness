// 记忆库维护：
// 1) 把「用路径当工作区 id」的老记忆归一到当前工作区 id（否则切到 default 后它们就看不见了）
// 2) 清掉工作区已经不存在的孤儿记忆（测试残留）
// 用法: node scripts/fix-memories.js [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { WorkspaceStore } from '../src/workspaces.js';

const DRY = process.argv.includes('--dry');
const file = path.join(config.memoryDir || '.memory', 'memory.json');
const mem = JSON.parse(fs.readFileSync(file, 'utf8'));

const workspaces = new WorkspaceStore({
  file: path.join(config.sessionsDir, '..', '.workspaces.json'),
  defaultPath: config.workspace,
});
const byId = new Map(workspaces.list().map((w) => [w.id, w]));
const byPath = new Map(workspaces.list().map((w) => [path.resolve(w.path).toLowerCase(), w]));

const normalize = (ws) => {
  if (!ws) return null;
  const hit = byId.get(ws) || byPath.get(path.resolve(ws).toLowerCase());
  return hit ? hit.id : null;
};

let renamed = 0;
let dropped = 0;
const kept = [];
for (const m of mem) {
  if (m.scope !== 'workspace') {
    kept.push(m);
    continue;
  }
  const id = normalize(m.workspace);
  if (!id) {
    console.log(`  删孤儿 #${m.id} [${m.workspace}] ${m.content.slice(0, 50)}`);
    dropped++;
    continue;
  }
  if (id !== m.workspace) {
    console.log(`  归一 #${m.id} [${m.workspace}] → [${id}] ${m.content.slice(0, 50)}`);
    m.workspace = id;
    renamed++;
  }
  kept.push(m);
}

console.log(`\n记忆 ${mem.length} → ${kept.length}（归一 ${renamed} 条，删除孤儿 ${dropped} 条）${DRY ? ' [dry-run]' : ''}`);
if (!DRY) {
  fs.writeFileSync(file, JSON.stringify(kept, null, 2), 'utf8');
  console.log('已写回', file);
}
