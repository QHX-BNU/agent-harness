// 存储层：会话（含状态）、事件日志、产物（超长工具结果）三份持久化。
// 会话是「可恢复的工作状态」，事件日志是「可回放的 trace」，产物是「不塞爆上下文的大对象」。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createState, publicSession } from './state.js';

export class SessionStore {
  constructor({ dir, artifactsDir, trashDir }) {
    this.dir = dir;
    this.artifactsDir = artifactsDir;
    // 回收站：删除会话时移到这里而不是直接删，误删可恢复
    this.trashDir = trashDir || `${dir}-trash`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    fs.mkdirSync(this.trashDir, { recursive: true });
    this.cache = new Map();
  }

  #file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  #eventsFile(id) {
    return path.join(this.dir, `${id}.events.jsonl`);
  }

  create({ provider, model, approvalMode, title, kind = 'chat', parentId = null } = {}) {
    const id = crypto.randomUUID().slice(0, 8);
    const session = {
      id,
      title: title || '',
      kind,
      parentId,
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
    session.updatedAt = Date.now();
    fs.writeFileSync(this.#file(session.id), JSON.stringify(session, null, 2), 'utf8');
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
    const session = this.get(id);
    this.cache.delete(id);

    if (hard) {
      for (const f of [this.#file(id), this.#eventsFile(id)]) {
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
      return { ok: Boolean(session), trashId: null };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let trashId = null;
    for (const f of [this.#file(id), this.#eventsFile(id)]) {
      if (!fs.existsSync(f)) continue;
      const name = `${stamp}__${path.basename(f)}`;
      fs.renameSync(f, path.join(this.trashDir, name));
      if (name.endsWith('.json') && !name.includes('.events.')) trashId = name;
    }
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
    const src = path.join(this.trashDir, trashId);
    if (!fs.existsSync(src)) throw new Error('回收站里没有这个条目');
    const orig = trashId.includes('__') ? trashId.split('__').slice(1).join('__') : trashId;
    const id = orig.replace(/\.json$/, '');
    const target = this.#file(id);
    if (fs.existsSync(target)) throw new Error(`已有同 id 的会话（${id}），无法恢复`);

    fs.renameSync(src, target);
    // events 文件在回收站里带同样的时间戳前缀，按 trashId 推导而不是用去前缀的名字
    const evName = trashId.replace(/\.json$/, '.events.jsonl');
    const evSrc = path.join(this.trashDir, evName);
    if (fs.existsSync(evSrc)) fs.renameSync(evSrc, this.#eventsFile(id));
    return this.get(id);
  }

  /** 彻底删除回收站里的条目（trashId 省略时清空回收站） */
  purge(trashId) {
    if (!fs.existsSync(this.trashDir)) return 0;
    const targets = trashId ? [trashId] : fs.readdirSync(this.trashDir);
    let n = 0;
    for (const t of targets) {
      const f = path.join(this.trashDir, t);
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

  list({ includeChildren = false } = {}) {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const s = this.get(path.basename(f, '.json'));
        return s ? publicSession(s) : null;
      })
      .filter(Boolean)
      .filter((s) => includeChildren || s.kind !== 'subagent')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---- 事件日志（trace） ----
  appendEvent(id, ev) {
    try {
      fs.appendFileSync(this.#eventsFile(id), JSON.stringify(ev) + '\n', 'utf8');
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  readEvents(id, limit = 500) {
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
    const safe = String(name).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'artifact';
    const file = path.join(this.artifactsDir, `${sessionId}-${Date.now().toString(36)}-${safe}`);
    fs.writeFileSync(file, String(content), 'utf8');
    return file;
  }

  readArtifact(file) {
    const abs = path.resolve(file);
    if (!abs.startsWith(path.resolve(this.artifactsDir))) throw new Error('只能读取产物目录内的文件');
    return fs.readFileSync(abs, 'utf8');
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
