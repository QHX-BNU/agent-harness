// 记忆层：分层长期记忆（global / workspace / session），带检索与自动召回。
// 设计要点（对齐 DSH 的实践）：
//   1. 分层作用域：全局事实 vs 工作区约定 vs 会话上下文，召回时按当前上下文过滤
//   2. 检索不靠 embedding：词元重叠（中英混合）+ 重要度 + 时效，够用且零依赖
//   3. 自动召回有预算：每轮只注入 top-K，且长记忆先截断，避免挤爆上下文
//   4. 会话级记忆不自动注入，只在显式检索时出现（避免上一轮对话污染下一轮）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CATEGORIES = ['anchor', 'structure', 'knowledge', 'situation', 'self'];
export const SCOPES = ['global', 'workspace', 'session'];

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

export class MemoryStore {
  constructor({ dir, workspaceId = 'default' }) {
    this.file = path.join(dir, 'memory.json');
    this.workspaceId = workspaceId;
    fs.mkdirSync(dir, { recursive: true });
    this.items = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    this.loadLog = [];
  }

  #persist() {
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2), 'utf8');
  }

  add({ content, scope = 'session', category = 'knowledge', importance = 0.6, tags = [], sessionId = null }) {
    if (!content || !String(content).trim()) throw new Error('记忆内容不能为空');
    if (!SCOPES.includes(scope)) throw new Error(`scope 必须是 ${SCOPES.join(' / ')}`);
    if (!CATEGORIES.includes(category)) throw new Error(`category 必须是 ${CATEGORIES.join(' / ')}`);
    const item = {
      id: (this.items.at(-1)?.id || 0) + 1,
      content: String(content).trim(),
      scope,
      category,
      importance: Math.max(0, Math.min(1, Number(importance) || 0.6)),
      tags: Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/).filter(Boolean),
      workspace: scope === 'workspace' ? this.workspaceId : null,
      sessionId: scope === 'session' ? sessionId : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      loads: 0,
      lastLoadedAt: null,
    };
    this.items.push(item);
    this.#persist();
    return item;
  }

  get(id) {
    return this.items.find((m) => m.id === Number(id)) || null;
  }

  update(id, patch = {}) {
    const item = this.get(id);
    if (!item) return null;
    for (const k of ['content', 'scope', 'category', 'importance', 'tags']) {
      if (patch[k] !== undefined) item[k] = patch[k];
    }
    item.importance = Math.max(0, Math.min(1, Number(item.importance) || 0.6));
    item.updatedAt = Date.now();
    this.#persist();
    return item;
  }

  remove(id) {
    const i = this.items.findIndex((m) => m.id === Number(id));
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.#persist();
    return true;
  }

  /** 当前会话可见的记忆 */
  visible({ sessionId = null, includeSession = true } = {}) {
    return this.items.filter((m) => {
      if (m.scope === 'global') return true;
      if (m.scope === 'workspace') return m.workspace === this.workspaceId;
      if (!includeSession) return false;
      return m.sessionId === sessionId;
    });
  }

  /**
   * 检索：词元重叠 + 重要度 + 时效
   * @returns {Array<{item:object, score:number}>}
   */
  search({ query = '', topK = 5, sessionId = null, includeSession = true, scope, category, tag, recordLoad = false }) {
    const q = tokenize(query);
    let pool = this.visible({ sessionId, includeSession });
    if (scope) pool = pool.filter((m) => m.scope === scope);
    if (category) pool = pool.filter((m) => m.category === category);
    if (tag) pool = pool.filter((m) => (m.tags || []).includes(tag));

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
      this.#persist();
    }
    return scored;
  }

  list({ sessionId = null, includeSession = true, scope, category, tag, keyword, limit = 50, offset = 0 } = {}) {
    let pool = this.visible({ sessionId, includeSession });
    if (scope) pool = pool.filter((m) => m.scope === scope);
    if (category) pool = pool.filter((m) => m.category === category);
    if (tag) pool = pool.filter((m) => (m.tags || []).includes(tag));
    if (keyword) {
      const q = tokenize(keyword);
      pool = pool.filter((m) => overlap(q, tokenize(m.content)) > 0);
    }
    return pool.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(offset, offset + limit);
  }

  /** 给系统提示用的召回文本（带预算截断） */
  recall(query, { sessionId = null, topK = 5, maxChars = 2400 } = {}) {
    const hits = this.search({ query, topK, sessionId, includeSession: false, recordLoad: true });
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
    return {
      total: this.items.length,
      byScope: by('scope'),
      byCategory: by('category'),
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
