// 记忆层：分层长期记忆 + 三块「画像文件」。
//
// 两层结构（各管一件事，别混着用）：
//   1. 画像层（profile）：.memory/user.md / soul.md / preference.md
//      一行一条，人和模型都能直接编辑；常驻注入系统提示，所以必须小。
//      md 文件是这几类记忆的**权威存储**：手改一行，下一轮就生效。
//   2. 结构化层：.memory/memory.json
//      scope/category/importance/tags，按相关度召回 top-K，不常驻。
//
// 迁移：老的「全局 anchor」条目搬进 user.md、「全局 self」搬进 preference.md；
// 其余（workspace/session 级）原地不动，避免把有作用域的东西塞进常驻画像。
//
// 设计原则沿用原来的：检索不靠 embedding（词元重叠 + 重要度 + 时效），
// 自动召回有预算，会话级记忆不自动注入。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './fsutil.js';

export const CATEGORIES = ['anchor', 'structure', 'knowledge', 'situation', 'self'];
export const SCOPES = ['global', 'workspace', 'session'];

/**
 * 三块画像文件。key 就是文件名（user.md / soul.md / preference.md）。
 * hint 会写进 md 文件头，告诉手改的人这里该放什么。
 */
export const CHUNKS = {
  user: {
    file: 'user.md',
    title: 'user.md · 关于用户',
    label: '用户',
    hint: '用户是谁、在什么环境里干活：身份、账号、机器/项目、长期约束。',
    defaultCategory: 'anchor',
  },
  soul: {
    file: 'soul.md',
    title: 'soul.md · 助手人格',
    label: '人格',
    hint: '助手自己的人格与工作原则：说话方式、取舍标准、边界感。',
    defaultCategory: 'self',
  },
  preference: {
    file: 'preference.md',
    title: 'preference.md · 用户偏好',
    label: '偏好',
    hint: '用户明确表达过的偏好：语言、格式、流程、工具选择、雷区。',
    defaultCategory: 'self',
  },
};
export const CHUNK_NAMES = Object.keys(CHUNKS);

/** 中英混合分词：中文按字 + 二元组，英文/数字按词 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const w of s.match(/[a-z0-9_]+/g) || []) tokens.add(w);
  const cjk = s.match(/[\u4e00-\u9fa5]/g) || [];
  for (const c of cjk) tokens.add(c);
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk[i] + cjk[i + 1]);
  return tokens;
}

const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.sqrt(a.size * b.size); // 余弦式归一化
};

const recency = (ts, halfLifeDays = 30) => {
  const days = (Date.now() - (ts || 0)) / 86400000;
  return Math.pow(0.5, days / halfLifeDays);
};

/** md 里的一行：`- 内容 <!-- id=1 scope=global ... -->` */
const LINE_RE = /^\s*[-*]\s+(.+?)\s*$/;
const META_RE = /<!--\s*(.*?)\s*-->\s*$/;

/** 把内容压成单行、去掉会破坏 md 结构的字符 */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const metaClean = (value) => String(value ?? '').replace(/\s+/g, '_').replace(/[;<>]/g, '');

export function parseChunkMarkdown(text) {
  const entries = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    let line = m[1];
    const meta = {};
    const c = META_RE.exec(line);
    if (c) {
      for (const part of c[1].split(/\s+/)) {
        const i = part.indexOf('=');
        if (i > 0) meta[part.slice(0, i)] = part.slice(i + 1);
      }
      line = line.slice(0, c.index).trim();
    }
    const content = line.replace(/^[-*]\s+/, '').trim();
    if (content) entries.push({ content, meta });
  }
  return entries;
}

export function renderChunkMarkdown(name, items) {
  const spec = CHUNKS[name];
  const head = [
    `# ${spec.title}`,
    '',
    `<!-- ${spec.hint}`,
    '     一行一条；下面这些行可以直接手改 / 增删，下一轮会按行读回来。',
    '     行尾 <!-- ... --> 是元数据（id/重要度/标签），删掉会自动补一条新的。 -->',
    '',
  ].join('\n');
  const body = (items || [])
    .map((it) => {
      const tags = (it.tags || []).map(metaClean).filter(Boolean).join(',');
      const meta =
        `id=${it.id} scope=${it.scope || 'global'} category=${it.category || spec.defaultCategory} ` +
        `importance=${Number(it.importance ?? 0.6).toFixed(2)} tags=${tags} ts=${it.createdAt || Date.now()}`;
      return `- ${oneLine(it.content)} <!-- ${meta} -->`;
    })
    .join('\n');
  return `${head}${body}${body ? '\n' : ''}`;
}

/** 结构化条目默认去哪个画像文件（只在 global 级、且是身份/偏好时才自动归块） */
export function inferChunk({ scope = 'session', category = 'knowledge' } = {}) {
  if (scope !== 'global') return null;
  if (category === 'anchor') return 'user';
  if (category === 'self') return 'preference';
  return null;
}

export class MemoryStore {
  constructor({ dir, workspaceId = 'default' }) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'memory.json');
    this.workspaceId = workspaceId;
    ensureDir(this.dir);
    /** @type {Array<object>} json 条目 + 画像条目，画像条目带 chunk 字段 */
    this.items = [];
    this.loadLog = [];
    this.migrated = [];
    this.#load();
  }

  // ---------- 加载 / 持久化 ----------

  #load() {
    let raw = [];
    try {
      const parsed = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
      raw = Array.isArray(parsed) ? parsed : [];
    } catch {
      raw = [];
    }
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      // 显式 chunk 字段优先；老数据按 scope/category 推断
      let chunk = CHUNK_NAMES.includes(item.chunk) ? item.chunk : null;
      if (!chunk) {
        const guess = inferChunk(item);
        if (guess) {
          chunk = guess;
          this.migrated.push({ id: item.id, to: guess, content: String(item.content || '').slice(0, 60) });
        }
      }
      this.items.push({
        ...item,
        content: oneLine(item.content),
        scope: chunk ? 'global' : item.scope,
        chunk,
        tags: Array.isArray(item.tags) ? item.tags : [],
      });
    }

    // 画像文件：md 是权威，读回来覆盖/补齐对应条目
    for (const name of CHUNK_NAMES) {
      const file = this.#chunkFile(name);
      let text = '';
      let missing = false;
      try {
        if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
        else missing = true;
      } catch {
        missing = true;
      }
      if (missing) continue; // 文件还不存在：等第一次 persist 时按已有条目生成
      const entries = parseChunkMarkdown(text);
      // 该 chunk 的旧条目全部作废，以文件为准
      this.items = this.items.filter((it) => it.chunk !== name);
      let normalized = false;
      for (const entry of entries) {
        const id = Number(entry.meta.id);
        const usableId = Number.isInteger(id) && id > 0 && !this.items.some((it) => it.id === id) ? id : null;
        if (!usableId) normalized = true;
        this.items.push({
          id: usableId || this.#nextId(),
          content: entry.content,
          scope: 'global',
          category: CATEGORIES.includes(entry.meta.category) ? entry.meta.category : CHUNKS[name].defaultCategory,
          importance: Number.isFinite(Number(entry.meta.importance)) ? Math.max(0, Math.min(1, Number(entry.meta.importance))) : 0.8,
          tags: String(entry.meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
          chunk: name,
          workspace: null,
          sessionId: null,
          createdAt: Number(entry.meta.ts) || Date.now(),
          updatedAt: Number(entry.meta.ts) || Date.now(),
          loads: 0,
          lastLoadedAt: null,
        });
      }
      if (normalized && entries.length) this.#persistChunk(name, { force: true });
    }

    if (this.migrated.length) this.#persistAll();
    else if (CHUNK_NAMES.some((n) => !fs.existsSync(this.#chunkFile(n)))) this.#persistAll();
  }

  #chunkFile(name) {
    return path.join(this.dir, CHUNKS[name].file);
  }

  #nextId() {
    return this.items.reduce((max, it) => Math.max(max, Number(it.id) || 0), 0) + 1;
  }

  #jsonItems() {
    return this.items.filter((it) => !it.chunk);
  }

  #persistJson() {
    fs.writeFileSync(this.file, JSON.stringify(this.#jsonItems(), null, 2), 'utf8');
  }

  #persistChunk(name, { force = false } = {}) {
    const text = renderChunkMarkdown(name, this.items.filter((it) => it.chunk === name));
    const file = this.#chunkFile(name);
    try {
      if (!force && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
    } catch {
      /* 读不到就直接写 */
    }
    fs.writeFileSync(file, text, 'utf8');
  }

  #persistAll() {
    this.#persistJson();
    for (const name of CHUNK_NAMES) this.#persistChunk(name);
  }

  // ---------- 写 ----------

  add({ content, scope = 'session', category = 'knowledge', importance = 0.6, tags = [], sessionId = null, workspaceId = null, chunk = null, source = '' }) {
    if (!content || !String(content).trim()) throw new Error('记忆内容不能为空');
    if (!SCOPES.includes(scope)) throw new Error(`scope 必须是 ${SCOPES.join(' / ')}`);
    if (!CATEGORIES.includes(category)) throw new Error(`category 必须是 ${CATEGORIES.join(' / ')}`);
    const wanted = String(chunk ?? '').trim();
    let target = CHUNK_NAMES.includes(wanted) ? wanted : null;
    if (!target && (wanted === 'auto' || wanted === '')) target = inferChunk({ scope, category });
    const cleanTags = (Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/))
      .map((t) => String(t).trim())
      .filter(Boolean);
    const item = {
      id: this.#nextId(),
      content: oneLine(content),
      // 画像文件是常驻注入的，只允许 global，否则会串工作区
      scope: target ? 'global' : scope,
      category,
      importance: Math.max(0, Math.min(1, Number(importance) || 0.6)),
      tags: cleanTags,
      workspace: target ? null : scope === 'workspace' ? workspaceId || this.workspaceId : null,
      sessionId: target ? null : scope === 'session' ? sessionId : null,
      chunk: target,
      source: String(source || '') || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      loads: 0,
      lastLoadedAt: null,
    };
    this.items.push(item);
    if (target) this.#persistChunk(target, { force: true });
    else this.#persistJson();
    return item;
  }

  get(id) {
    return this.items.find((m) => m.id === Number(id)) || null;
  }

  update(id, patch = {}) {
    const item = this.get(id);
    if (!item) return null;
    if (patch.content !== undefined) item.content = oneLine(patch.content);
    for (const k of ['scope', 'category', 'importance']) {
      if (patch[k] !== undefined) item[k] = patch[k];
    }
    if (patch.tags !== undefined) {
      item.tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，\s]+/)).map((t) => String(t).trim()).filter(Boolean);
    }
    if (patch.chunk !== undefined) {
      const next = CHUNK_NAMES.includes(String(patch.chunk)) ? String(patch.chunk) : null;
      if (next !== item.chunk) {
        const from = item.chunk;
        item.chunk = next;
        if (next) {
          item.scope = 'global';
          item.workspace = null;
          item.sessionId = null;
        } else if (from) {
          item.scope = 'workspace';
        }
      }
    }
    item.importance = Math.max(0, Math.min(1, Number(item.importance) || 0.6));
    item.updatedAt = Date.now();
    this.#persistAll();
    return item;
  }

  remove(id) {
    const i = this.items.findIndex((m) => m.id === Number(id));
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.#persistAll();
    return true;
  }

  // ---------- 画像文件 ----------

  chunkText(name) {
    if (!CHUNKS[name]) throw new Error(`未知记忆分块：${name}（可选 ${CHUNK_NAMES.join(' / ')}）`);
    return fs.existsSync(this.#chunkFile(name)) ? fs.readFileSync(this.#chunkFile(name), 'utf8') : renderChunkMarkdown(name, []);
  }

  chunkItems(name) {
    return this.items.filter((it) => it.chunk === name).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** 整块替换（UI / 工具的手改入口）：md 文本解析成条目，整块重建（原有 id 尽量保留，避免改一行全库重新编号） */
  setChunkText(name, text) {
    if (!CHUNKS[name]) throw new Error(`未知记忆分块：${name}（可选 ${CHUNK_NAMES.join(' / ')}）`);
    const entries = parseChunkMarkdown(text);
    const previous = this.chunkItems(name);
    this.items = this.items.filter((it) => it.chunk !== name);
    for (const entry of entries) {
      const wantId = Number(entry.meta.id);
      const reusable =
        Number.isInteger(wantId) && wantId > 0 && !this.items.some((it) => it.id === wantId) ? wantId : null;
      const old = reusable ? previous.find((it) => it.id === reusable) : null;
      this.items.push({
        id: reusable || this.#nextId(),
        content: entry.content,
        scope: 'global',
        category: CATEGORIES.includes(entry.meta.category) ? entry.meta.category : CHUNKS[name].defaultCategory,
        importance: Number.isFinite(Number(entry.meta.importance)) ? Math.max(0, Math.min(1, Number(entry.meta.importance))) : 0.8,
        tags: String(entry.meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
        chunk: name,
        workspace: null,
        sessionId: null,
        createdAt: Number(entry.meta.ts) || old?.createdAt || Date.now(),
        updatedAt: Date.now(),
        loads: old?.loads || 0,
        lastLoadedAt: old?.lastLoadedAt || null,
      });
    }
    this.#persistChunk(name, { force: true });
    return this.chunkItems(name);
  }

  chunksSummary() {
    return CHUNK_NAMES.map((name) => ({
      name,
      file: CHUNKS[name].file,
      title: CHUNKS[name].title,
      hint: CHUNKS[name].hint,
      count: this.chunkItems(name).length,
      path: this.#chunkFile(name),
    }));
  }

  /**
   * 常驻画像文本（系统提示用）。三个分块一起给，超预算就按块均分后截断。
   * 返回值保证 text.length <= maxChars（不然「常驻」会悄悄吃掉上下文预算）。
   * @returns {{text:string, used:number, maxChars:number, truncated:string[]}}
   */
  profile({ maxChars = 3000 } = {}) {
    const budget = Math.max(200, Number(maxChars) || 3000);
    const blocks = CHUNK_NAMES.map((name) => {
      const items = this.chunkItems(name);
      return { name, title: CHUNKS[name].title, lines: items.map((it) => `- ${it.content}`), count: items.length };
    }).filter((b) => b.lines.length);
    if (!blocks.length) return { text: '', used: 0, maxChars: budget, truncated: [] };

    const per = Math.max(40, Math.floor((budget - 16) / blocks.length));
    const truncated = new Set();
    const parts = [];
    let used = 0;
    for (const b of blocks) {
      let body = b.lines.join('\n');
      if (body.length > per) {
        body = `${body.slice(0, per - 1).trimEnd()}…`;
        truncated.add(b.name);
      }
      const head = `【${b.title}】共 ${b.count} 条\n`;
      let block = `${head}${body}`;
      if (used + block.length + (parts.length ? 2 : 0) > budget) {
        const room = budget - used - (parts.length ? 2 : 0) - head.length - 1;
        if (room < 40) {
          truncated.add(b.name);
          continue;
        }
        block = `${head}${body.slice(0, room).trimEnd()}…`;
        truncated.add(b.name);
      }
      used += block.length + (parts.length ? 2 : 0);
      parts.push(block);
    }
    return { text: parts.join('\n\n'), used, maxChars: budget, truncated: [...truncated] };
  }

  // ---------- 读 / 检索 ----------

  /** 当前会话可见的记忆 */
  visible({ sessionId = null, includeSession = true, workspaceId = null } = {}) {
    const ws = workspaceId || this.workspaceId;
    return this.items.filter((m) => {
      if (m.scope === 'global') return true;
      if (m.scope === 'workspace') return m.workspace === ws;
      if (!includeSession) return false;
      return m.sessionId === sessionId;
    });
  }

  /**
   * 检索：词元重叠 + 重要度 + 时效
   * @param {object} [opts]
   * @param {boolean} [opts.includeChunks] 画像条目要不要参与（自动召回时不要，它们已经常驻）
   * @returns {Array<{item:object, score:number}>}
   */
  search({
    query = '',
    topK = 5,
    sessionId = null,
    includeSession = true,
    scope,
    category,
    tag,
    chunk,
    includeChunks = true,
    recordLoad = false,
    workspaceId = null,
  }) {
    const q = tokenize(query);
    let pool = this.visible({ sessionId, includeSession, workspaceId });
    if (!includeChunks) pool = pool.filter((m) => !m.chunk);
    if (scope) pool = pool.filter((m) => m.scope === scope);
    if (category) pool = pool.filter((m) => m.category === category);
    if (tag) pool = pool.filter((m) => (m.tags || []).includes(tag));
    if (chunk) pool = pool.filter((m) => m.chunk === chunk);

    const scored = pool
      .map((item) => {
        const ov = q.size ? overlap(q, tokenize(item.content + ' ' + (item.tags || []).join(' '))) : 0;
        const score = 0.6 * ov + 0.28 * item.importance + 0.12 * recency(item.updatedAt);
        return { item, score: Number(score.toFixed(4)), overlap: Number(ov.toFixed(4)) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (recordLoad) {
      for (const { item } of scored) {
        item.loads = (item.loads || 0) + 1;
        item.lastLoadedAt = Date.now();
        this.loadLog.push({ id: item.id, at: Date.now(), query: String(query).slice(0, 80) });
      }
      this.loadLog = this.loadLog.slice(-200);
      this.#persistAll();
    }
    return scored;
  }

  list({ sessionId = null, includeSession = true, scope, category, tag, chunk, keyword, limit = 50, offset = 0, workspaceId = null } = {}) {
    let pool = this.visible({ sessionId, includeSession, workspaceId });
    if (scope) pool = pool.filter((m) => m.scope === scope);
    if (category) pool = pool.filter((m) => m.category === category);
    if (tag) pool = pool.filter((m) => (m.tags || []).includes(tag));
    if (chunk) pool = pool.filter((m) => m.chunk === chunk);
    if (keyword) {
      const q = tokenize(keyword);
      pool = pool.filter((m) => overlap(q, tokenize(m.content)) > 0);
    }
    return pool.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(offset, offset + limit);
  }

  /** 给系统提示用的召回文本（带预算截断）；画像条目已经常驻，不参与 */
  recall(query, { sessionId = null, topK = 5, maxChars = 2400, workspaceId = null } = {}) {
    const hits = this.search({ query, topK, sessionId, includeSession: false, includeChunks: false, recordLoad: true, workspaceId });
    if (!hits.length) return { text: '', hits };
    const lines = [];
    let used = 0;
    for (const { item, score } of hits) {
      if (score < 0.12) continue;
      const line = `- [#${item.id} ${item.scope}/${item.category} 重要度${item.importance.toFixed(2)}] ${item.content}`;
      if (used + line.length > maxChars) break;
      used += line.length;
      lines.push(line);
    }
    return { text: lines.join('\n'), hits: hits.slice(0, lines.length) };
  }

  stats() {
    const by = (k) => this.items.reduce((acc, m) => ((acc[m[k]] = (acc[m[k]] || 0) + 1), acc), {});
    const byChunk = this.items.reduce((acc, m) => {
      const key = m.chunk || 'json';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      total: this.items.length,
      byScope: by('scope'),
      byCategory: by('category'),
      byChunk,
      chunks: this.chunksSummary(),
      migrated: this.migrated.slice(-20),
      mostLoaded: this.items
        .filter((m) => m.loads)
        .sort((a, b) => b.loads - a.loads)
        .slice(0, 5)
        .map((m) => ({ id: m.id, loads: m.loads, content: m.content.slice(0, 60) })),
      recentLoads: this.loadLog.slice(-10).reverse(),
    };
  }
}

export const newMemoryId = () => crypto.randomUUID();
