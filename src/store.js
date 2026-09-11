// 存储层：会话（含状态）、事件日志、产物（超长工具结果）三份持久化。
// 会话是「可恢复的工作状态」，事件日志是「可回放的 trace」，产物是「不塞爆上下文的大对象」。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createState, publicSession } from './state.js';

export class SessionStore {
  constructor({ dir, artifactsDir }) {
    this.dir = dir;
    this.artifactsDir = artifactsDir;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.artifactsDir, { recursive: true });
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

  remove(id) {
    this.cache.delete(id);
    for (const f of [this.#file(id), this.#eventsFile(id)]) {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
    return true;
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
