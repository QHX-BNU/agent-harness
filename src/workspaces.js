// 工作区：harness 可以同时服务多个目录，每个工作区下有自己的一组会话。
// 工作区决定了：文件工具的根目录、沙箱「仅工作区」的实际范围、workspace 级记忆的归属。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_WORKSPACE_ID = 'default';

export class WorkspaceStore {
  constructor({ file, defaultPath, defaultName = '默认工作区' }) {
    this.file = file;
    this.defaultPath = path.resolve(defaultPath);
    this.defaultName = defaultName;
    this.items = this.#load();
    this.#ensureDefault();
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return [];
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.workspaces) ? data.workspaces : [];
    } catch {
      return [];
    }
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, workspaces: this.items }, null, 2), 'utf8');
  }

  #ensureDefault() {
    if (this.items.some((w) => w.id === DEFAULT_WORKSPACE_ID)) return;
    this.items.unshift({
      id: DEFAULT_WORKSPACE_ID,
      name: this.defaultName,
      path: this.defaultPath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    this.#persist();
  }

  list() {
    return this.items
      .slice()
      .sort((a, b) => (a.id === DEFAULT_WORKSPACE_ID ? -1 : b.lastUsedAt - a.lastUsedAt));
  }

  get(id) {
    return this.items.find((w) => w.id === id || w.path === id) || null;
  }

  /** 校验目录：必须存在且是目录（不存在就报明确错误，不替用户乱建） */
  static validatePath(p) {
    const abs = path.resolve(String(p || '').trim());
    if (!abs) throw new Error('路径不能为空');
    if (!fs.existsSync(abs)) throw new Error(`目录不存在：${abs}`);
    if (!fs.statSync(abs).isDirectory()) throw new Error(`不是目录：${abs}`);
    return abs;
  }

  create({ name, path: p }) {
    const abs = WorkspaceStore.validatePath(p);
    if (this.items.some((w) => w.path === abs)) {
      throw new Error(`这个目录已经是工作区了：${this.get(abs)?.name || abs}`);
    }
    const w = {
      id: crypto.randomUUID().slice(0, 8),
      name: String(name || '').trim() || path.basename(abs) || abs,
      path: abs,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.items.push(w);
    this.#persist();
    return w;
  }

  update(id, patch = {}) {
    const w = this.get(id);
    if (!w) throw new Error('工作区不存在');
    if (patch.name !== undefined) w.name = String(patch.name).trim() || w.name;
    if (patch.path !== undefined) {
      const abs = WorkspaceStore.validatePath(patch.path);
      if (this.items.some((x) => x.path === abs && x.id !== w.id)) throw new Error('这个目录已经是别的工作区了');
      w.path = abs;
    }
    this.#persist();
    return w;
  }

  remove(id) {
    const i = this.items.findIndex((w) => w.id === id);
    if (i < 0) throw new Error('工作区不存在');
    if (this.items[i].id === DEFAULT_WORKSPACE_ID) throw new Error('默认工作区不能删除');
    const [removed] = this.items.splice(i, 1);
    this.#persist();
    return removed;
  }

  touch(id) {
    const w = this.get(id);
    if (w) {
      w.lastUsedAt = Date.now();
      this.#persist();
    }
    return w;
  }

  /** 给 UI 用：带上会话数 */
  describe(countByWorkspace = {}) {
    return this.list().map((w) => ({
      ...w,
      exists: fs.existsSync(w.path),
      sessions: countByWorkspace[w.id] || 0,
    }));
  }
}
