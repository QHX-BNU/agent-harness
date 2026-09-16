// 存储层：会话（含状态）、事件日志、产物（超长工具结果）三份持久化。
// 会话是「可恢复的工作状态」，事件日志是「可回放的 trace」，产物是「不塞爆上下文的大对象」。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createState, publicSession } from './state.js';
import { ensureDir } from './fsutil.js';

export class SessionStore {
  constructor({ dir, artifactsDir, trashDir }) {
    this.dir = path.resolve(dir);
    this.artifactsDir = path.resolve(artifactsDir);
    // 回收站：删除会话时移到这里而不是直接删，误删可恢复
    this.trashDir = path.resolve(trashDir || `${dir}-trash`);
    ensureDir(this.dir);
    ensureDir(this.artifactsDir);
    ensureDir(this.trashDir);
    this.cache = new Map();
    // 运行中的 turn 会在收尾时 save/appendEvent。会话被删除后必须拦住这些迟到写入，
    // 否则刚移进回收站的 JSON 会立刻被“复活”。恢复会话时会显式清除 tombstone。
    this.deleted = new Set();
  }

  #validSessionId(id) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(id || ''));
  }

  #assertSessionId(id) {
    const value = String(id || '');
    if (!this.#validSessionId(value)) throw new Error('会话 id 不合法');
    return value;
  }

  /** 只允许一个纯文件名，并二次确认解析后仍在指定目录内。 */
  #entry(dir, name, label = '文件') {
    const raw = String(name || '');
    if (!raw || raw === '.' || raw === '..' || /[\\/\0]/.test(raw) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(raw)) {
      throw new Error(`${label}名不合法`);
    }
    const root = path.resolve(dir);
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${label}越界`);
    return abs;
  }

  #file(id) {
    return this.#entry(this.dir, `${this.#assertSessionId(id)}.json`, '会话文件');
  }

  #eventsFile(id) {
    return this.#entry(this.dir, `${this.#assertSessionId(id)}.events.jsonl`, '事件文件');
  }

  #trashFile(name) {
    return this.#entry(this.trashDir, name, '回收站条目');
  }

  create({ provider, model, approvalMode, title, kind = 'chat', parentId = null, workspaceId = 'default', workspacePath = null } = {}) {
    let id;
    do {
      id = crypto.randomUUID().slice(0, 8);
    } while (this.deleted.has(id) || fs.existsSync(this.#file(id)));
    const session = {
      id,
      title: title || '',
      kind,
      parentId,
      workspaceId: workspaceId || 'default',
      workspacePath: workspacePath || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider,
      model,
      approvalMode,
      messages: [], // {role, content, toolCalls?, toolCallId?, name?, reasoning?}
      todos: [], // 模型自己维护的任务清单
      state: createState({ provider, model, approvalMode }),
    };
    this.cache.set(id, session);
    this.save(session);
    return session;
  }

  get(id) {
    if (!this.#validSessionId(id) || this.deleted.has(String(id))) return null;
    if (this.cache.has(id)) return this.cache.get(id);
    const file = this.#file(id);
    if (!fs.existsSync(file)) return null;
    try {
      const session = JSON.parse(fs.readFileSync(file, 'utf8'));
      session.state = { ...createState(), ...(session.state || {}) };
      session.todos = session.todos || [];
      this.cache.set(id, session);
      return session;
    } catch {
      return null;
    }
  }

  save(session) {
    const id = this.#assertSessionId(session?.id);
    if (this.deleted.has(id)) return session;
    session.updatedAt = Date.now();
    const file = this.#file(id);
    // 不跟随攻击者预先放在数据目录里的符号链接。
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('会话文件不能是符号链接');
    fs.writeFileSync(file, JSON.stringify(session, null, 2), 'utf8');
    return session;
  }

  append(session, message) {
    session.messages.push(message);
    // 首条用户消息自动作为标题
    if (!session.title && message.role === 'user') {
      session.title = String(message.content).replace(/\s+/g, ' ').slice(0, 40) || '未命名会话';
    }
    this.save(session);
    return session;
  }

  /**
   * 删除会话。默认「软删除」：把 .json 与 .events.jsonl 移进回收站，可恢复。
   * 只有显式 hard=true 才真的从磁盘抹掉。
   */
  remove(id, { hard = false } = {}) {
    if (!this.#validSessionId(id)) return { ok: false, trashId: null };
    id = String(id);
    const session = this.get(id);
    this.cache.delete(id);

    if (hard) {
      for (const f of [this.#file(id), this.#eventsFile(id)]) {
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
      this.deleted.add(id);
      return { ok: Boolean(session), trashId: null };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let trashId = null;
    for (const f of [this.#file(id), this.#eventsFile(id)]) {
      if (!fs.existsSync(f)) continue;
      const name = `${stamp}__${path.basename(f)}`;
      fs.renameSync(f, this.#trashFile(name));
      if (name.endsWith('.json') && !name.includes('.events.')) trashId = name;
    }
    this.deleted.add(id);
    return { ok: Boolean(trashId || session), trashId };
  }

  /** 回收站里的会话（按删除时间倒序） */
  listTrash() {
    if (!fs.existsSync(this.trashDir)) return [];
    return fs
      .readdirSync(this.trashDir)
      .filter((f) => f.endsWith('.json') && !f.includes('.events.'))
      .map((f) => {
        const [stamp, orig] = f.includes('__') ? f.split('__') : ['', f];
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.trashDir, f), 'utf8'));
          return {
            trashId: f,
            id: s.id || orig.replace(/\.json$/, ''),
            title: s.title || '未命名会话',
            provider: s.provider,
            model: s.model,
            messages: (s.messages || []).length,
            deletedAt: stamp || fs.statSync(path.join(this.trashDir, f)).mtime.toISOString(),
          };
        } catch {
          return { trashId: f, id: orig.replace(/\.json$/, ''), title: '(文件损坏)', messages: 0, deletedAt: stamp };
        }
      })
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }

  /** 从回收站恢复一个会话 */
  restore(trashId) {
    const src = this.#trashFile(trashId);
    if (!fs.existsSync(src)) throw new Error('回收站里没有这个条目');
    const orig = trashId.includes('__') ? trashId.split('__').slice(1).join('__') : trashId;
    const id = orig.replace(/\.json$/, '');
    this.#assertSessionId(id);
    if (!orig.endsWith('.json') || orig.endsWith('.events.json')) throw new Error('这不是可恢复的会话文件');
    const target = this.#file(id);
    if (fs.existsSync(target)) throw new Error(`已有同 id 的会话（${id}），无法恢复`);

    fs.renameSync(src, target);
    // events 文件在回收站里带同样的时间戳前缀，按 trashId 推导而不是用去前缀的名字
    const evName = trashId.replace(/\.json$/, '.events.jsonl');
    const evSrc = this.#trashFile(evName);
    if (fs.existsSync(evSrc)) fs.renameSync(evSrc, this.#eventsFile(id));
    this.deleted.delete(id);
    return this.get(id);
  }

  /** 彻底删除回收站里的条目（trashId 省略时清空回收站） */
  purge(trashId) {
    if (!fs.existsSync(this.trashDir)) return 0;
    const targets = trashId ? [trashId] : fs.readdirSync(this.trashDir);
    let n = 0;
    for (const t of targets) {
      let f;
      try {
        f = this.#trashFile(t);
      } catch {
        continue;
      }
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        fs.rmSync(f, { force: true });
        n++;
      }
    }
    return n;
  }

  /** 全部会话打包成一个 JSON（备份用） */
  exportAll() {
    const sessions = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
          return { ...s, events: this.readEvents(s.id, 100000) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return {
      exportedAt: new Date().toISOString(),
      harness: 'mini-harness',
      count: sessions.length,
      sessions,
    };
  }

  list({ includeChildren = false, workspaceId = null } = {}) {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const s = this.get(path.basename(f, '.json'));
        return s ? publicSession(s) : null;
      })
      .filter(Boolean)
      .filter((s) => includeChildren || s.kind !== 'subagent')
      .filter((s) => !workspaceId || s.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 每个工作区下的会话数（含子代理，用于侧栏计数） */
  countByWorkspace() {
    const out = {};
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith('.json'))) {
      const s = this.get(path.basename(f, '.json'));
      if (!s) continue;
      const w = s.workspaceId || 'default';
      out[w] = (out[w] || 0) + 1;
    }
    return out;
  }

  // ---- 事件日志（trace） ----
  appendEvent(id, ev) {
    if (!this.#validSessionId(id) || this.deleted.has(String(id))) return;
    try {
      fs.appendFileSync(this.#eventsFile(id), JSON.stringify(ev) + '\n', 'utf8');
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  readEvents(id, limit = 500) {
    if (!this.#validSessionId(id) || this.deleted.has(String(id))) return [];
    const f = this.#eventsFile(id);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  // ---- 产物：超长内容落盘，上下文里只留路径 ----
  artifact(sessionId, name, content) {
    const id = this.#assertSessionId(sessionId);
    if (this.deleted.has(id)) throw new Error('会话已删除，不再写入产物');
    const safe = String(name).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'artifact';
    const file = this.#entry(this.artifactsDir, `${id}-${Date.now().toString(36)}-${safe}`, '产物文件');
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('产物文件不能是符号链接');
    fs.writeFileSync(file, String(content), 'utf8');
    return file;
  }

  readArtifact(file) {
    const abs = path.resolve(file);
    const root = path.resolve(this.artifactsDir);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('只能读取产物目录内的文件');
    // 读现有文件时再校验一次真实路径，防止目录内的符号链接指向外部。
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(abs);
    const realRel = path.relative(realRoot, real);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error('只能读取产物目录内的文件');
    return fs.readFileSync(real, 'utf8');
  }

  listArtifacts(sessionId) {
    return fs
      .readdirSync(this.artifactsDir)
      .filter((f) => !sessionId || f.startsWith(sessionId))
      .map((f) => {
        const st = fs.statSync(path.join(this.artifactsDir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
}
