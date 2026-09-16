// 技能层：技能包 = 一个目录 + 里面的 SKILL.md（可带 scripts/ 等附件）。
//
// 为什么这么放：
//   1. 技能是「控制器要读进提示词的东西」，所以默认落在 APP_ROOT/.skills，
//      而不是工作区里 —— 工作区是模型能写的，技能可写就等于把控制器的输入交出去了。
//   2. 安装走 zip（见 zip.js）：解压前先做路径/大小/符号链接校验，防 zip-slip。
//   3. 载入用「渐进披露」：系统提示里只列名字+描述+何时用，真要用时 skill_read 读全文。
//      这样装 20 个技能也不会把上下文吃光。
//   4. 技能可以被「自己生成」：skill_create 直接写目录，和 zip 安装进同一套结构。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './fsutil.js';
import { readZip, writeZip } from './zip.js';

export const SKILL_FILE = 'SKILL.md';

const LIMITS = {
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxNameChars: 64,
  maxPathDepth: 8,
  maxDescriptionChars: 300,
  maxReadChars: 200 * 1024,
};

/** 名字要能安全地当目录名：允许中英文、数字、点、下划线、减号 */
export function sanitizeSkillName(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[\u0000-\u001f<>:"|?*]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!cleaned) return '';
  return cleaned.slice(0, LIMITS.maxNameChars);
}

/** 解析 SKILL.md：极简 front matter（--- 包起来的 key: value）+ 正文 */
export function parseSkillMarkdown(text) {
  const src = String(text ?? '');
  const meta = {};
  let body = src;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '').trim();
      if (key && value) meta[key] = value;
    }
    body = src.slice(fm[0].length);
  }
  if (!meta.description) {
    const para = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('<!--'));
    if (para) meta.description = para.slice(0, LIMITS.maxDescriptionChars);
  }
  return { meta, body: body.replace(/^\s*\n/, '') };
}

export function renderSkillMarkdown(meta = {}, body = '') {
  const head = [
    '---',
    `name: ${meta.name || ''}`,
    `description: ${(meta.description || '').replace(/\r?\n/g, ' ')}`,
    ...(meta.when ? [`when: ${String(meta.when).replace(/\r?\n/g, ' ')}`] : []),
    ...(meta.version ? [`version: ${meta.version}`] : []),
    '---',
    '',
  ].join('\n');
  return `${head}${String(body || '').trim()}\n`;
}

/** zip 里的路径检查：返回 null 表示要跳过 */
function safeEntryName(raw) {
  let name = String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!name || name.endsWith('/')) return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  if (parts.length > LIMITS.maxPathDepth) return null;
  return parts.join('/');
}

export class SkillStore {
  constructor({ dir, limits = {} } = {}) {
    if (!dir) throw new Error('技能目录不能为空');
    this.dir = path.resolve(dir);
    this.limits = { ...LIMITS, ...limits };
    this.indexFile = path.join(this.dir, 'index.json');
    ensureDir(this.dir);
    this.#load();
  }

  #load() {
    let parsed = null;
    try {
      parsed = fs.existsSync(this.indexFile) ? JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) : null;
    } catch {
      parsed = null;
    }
    const list = Array.isArray(parsed?.skills) ? parsed.skills : [];
    this.skills = new Map();
    for (const meta of list) {
      if (!meta?.name) continue;
      this.skills.set(meta.name, meta);
    }
    this.#reconcile();
  }

  /** 目录里手动放进去的技能也要认出来（不要求非得走安装流程） */
  #reconcile() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      dirs = [];
    }
    let changed = false;
    if (dirs.length > LIMITS.maxFiles * 4) return;
    for (const name of dirs) {
      if (this.skills.has(name)) continue;
      const file = path.join(this.dir, name, SKILL_FILE);
      if (!fs.existsSync(file)) continue;
      try {
        const { meta } = parseSkillMarkdown(fs.readFileSync(file, 'utf8'));
        this.skills.set(name, {
          name,
          description: meta.description || '(没有描述)',
          when: meta.when || '',
          version: meta.version || '',
          source: 'disk',
          installedAt: fs.statSync(file).mtimeMs,
          files: this.#walk(name).map((f) => ({ path: f, bytes: fs.statSync(path.join(this.dir, name, f)).size })),
        });
        changed = true;
      } catch {
        /* 单个技能坏了不影响其它 */
      }
    }
    if (changed) this.#persist();
  }

  #persist() {
    fs.writeFileSync(this.indexFile, JSON.stringify({ version: 1, skills: [...this.skills.values()] }, null, 2), 'utf8');
  }

  #dirOf(name) {
    const safe = sanitizeSkillName(name);
    if (!safe) throw new Error(`技能名不合法：${name}`);
    const abs = path.resolve(this.dir, safe);
    const rel = path.relative(this.dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`技能名越界：${name}`);
    return { name: safe, dir: abs };
  }

  #walk(name, sub = '') {
    const base = path.join(this.dir, name, sub);
    const out = [];
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...this.#walk(name, rel));
      else if (entry.isFile()) out.push(rel);
    }
    return out;
  }

  list() {
    return [...this.skills.values()]
      .map((meta) => ({ ...meta, path: path.join(this.dir, meta.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 系统提示用的精简清单 */
  summary() {
    return this.list().map((s) => ({
      name: s.name,
      description: (s.description || '').slice(0, this.limits.maxDescriptionChars),
      when: (s.when || '').slice(0, this.limits.maxDescriptionChars),
      files: (s.files || []).length,
    }));
  }

  get(name) {
    const { name: safe } = this.#dirOf(name);
    const meta = this.skills.get(safe) || this.skills.get(String(name));
    if (!meta) return null;
    return { ...meta, path: path.join(this.dir, safe) };
  }

  read(name, file = SKILL_FILE) {
    const meta = this.get(name);
    if (!meta) throw new Error(`没有这个技能：${name}`);
    const rel = safeEntryName(String(file || SKILL_FILE));
    if (!rel) throw new Error(`技能内路径不合法：${file}`);
    const abs = path.resolve(meta.path, rel);
    const inDir = path.relative(path.resolve(meta.path), abs);
    if (inDir.startsWith('..') || path.isAbsolute(inDir)) throw new Error(`技能内路径越界：${file}`);
    if (!fs.existsSync(abs)) throw new Error(`技能里没有这个文件：${rel}`);
    const text = fs.readFileSync(abs, 'utf8');
    return { file: rel, text: text.slice(0, this.limits.maxReadChars), truncated: text.length > this.limits.maxReadChars };
  }

  /** 自己生成 / 手写一个技能 */
  create({ name, description = '', content = '', when = '', version = '', files = [], force = false } = {}) {
    const parsed = parseSkillMarkdown(content);
    const merged = {
      name: sanitizeSkillName(name || parsed.meta.name),
      description: description || parsed.meta.description || '',
      when: when || parsed.meta.when || '',
      version: version || parsed.meta.version || '',
    };
    if (!merged.name) throw new Error('技能名不能为空（允许中英文、数字、._-）');
    if (!merged.description) throw new Error('技能描述不能为空（模型靠它决定什么时候用这个技能）');
    if (merged.description.length > this.limits.maxDescriptionChars) merged.description = merged.description.slice(0, this.limits.maxDescriptionChars);
    const { dir } = this.#dirOf(merged.name);
    if (fs.existsSync(dir) && !force) throw new Error(`技能 ${merged.name} 已存在（要覆盖请加 force）`);
    // force = 覆盖安装：先清干净，免得上一版删掉的文件留在目录里（和 zip 安装保持一致）
    if (force) fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    const body = parsed.body || content;
    fs.writeFileSync(path.join(dir, SKILL_FILE), renderSkillMarkdown(merged, body), 'utf8');

    const written = [{ path: SKILL_FILE, bytes: Buffer.byteLength(body) }];
    let total = written[0].bytes;
    for (const f of Array.isArray(files) ? files : []) {
      const rel = safeEntryName(f?.path);
      if (!rel) throw new Error(`附加文件路径不合法：${f?.path}`);
      if (rel === SKILL_FILE) continue;
      const data = Buffer.isBuffer(f?.data) ? f.data : Buffer.from(String(f?.content ?? f?.data ?? ''), 'utf8');
      if (data.length > this.limits.maxFileBytes) throw new Error(`附加文件太大：${rel}`);
      total += data.length;
      if (total > this.limits.maxTotalBytes) throw new Error('技能总体积超限');
      const abs = path.join(dir, rel);
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, data);
      written.push({ path: rel, bytes: data.length });
    }

    const meta = {
      name: merged.name,
      description: merged.description,
      when: merged.when,
      version: merged.version,
      source: 'generated',
      installedAt: Date.now(),
      updatedAt: Date.now(),
      files: written,
      bytes: total,
    };
    this.skills.set(merged.name, meta);
    this.#persist();
    return this.get(merged.name);
  }

  /** 从 zip 安装（buffer 或文件路径都行） */
  installZip(input, { source = 'zip', name = '', force = false, hash = '' } = {}) {
    const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(String(input));
    if (buf.length > this.limits.maxTotalBytes * 3) throw new Error('技能包太大（压缩后超过上限）');
    const raw = readZip(buf);
    if (!raw.length) throw new Error('技能包是空的');

    // 1) 过滤 + 路径安全检查
    let entries = [];
    for (const e of raw) {
      if (e.isSymlink) throw new Error(`技能包里含符号链接，拒绝安装：${e.name}`);
      if (/^__MACOSX\//.test(e.name) || /(^|\/)\.DS_Store$/.test(e.name)) continue;
      const safe = safeEntryName(e.name);
      if (!safe) {
        if (e.dir) continue;
        throw new Error(`技能包里有不安全的路径：${e.name}`);
      }
      entries.push({ path: safe, data: e.data });
    }
    if (!entries.length) throw new Error('技能包里没有可用文件');

    // 2) 去掉统一的外层目录（zip 常见形态：my-skill/SKILL.md）
    const firstSegs = new Set(entries.map((e) => e.path.split('/')[0]));
    const rootHasSkill = entries.some((e) => e.path === SKILL_FILE);
    if (!rootHasSkill && firstSegs.size === 1) {
      const prefix = `${[...firstSegs][0]}/`;
      entries = entries.map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
    }

    // 3) 体积/数量限制
    if (entries.length > this.limits.maxFiles) throw new Error(`技能包文件数超限（>${this.limits.maxFiles}）`);
    let total = 0;
    for (const e of entries) {
      if (e.data.length > this.limits.maxFileBytes) throw new Error(`文件太大：${e.path}`);
      total += e.data.length;
      if (total > this.limits.maxTotalBytes) throw new Error('解压后总体积超限');
    }

    const skillFile = entries.find((e) => e.path === SKILL_FILE);
    if (!skillFile) throw new Error(`技能包里没有根目录的 ${SKILL_FILE}`);
    const { meta } = parseSkillMarkdown(skillFile.data.toString('utf8'));
    const finalName = sanitizeSkillName(name || meta.name || path.basename(String(source)).replace(/\.zip$/i, ''));
    if (!finalName) throw new Error('无法确定技能名（请在 SKILL.md 里写 name:，或安装时显式给 name）');
    if (!meta.description && !meta.when) {
      // 没描述的技能模型不知道该不该用：不阻断，但补一句
      meta.description = meta.description || '(技能包里没有 description)';
    }

    const { dir } = this.#dirOf(finalName);
    if (fs.existsSync(dir) && !force) throw new Error(`技能 ${finalName} 已存在（要覆盖请加 force）`);
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    const written = [];
    for (const e of entries) {
      const abs = path.join(dir, e.path);
      const rel = path.relative(dir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`技能包路径越界：${e.path}`);
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, e.data);
      written.push({ path: e.path, bytes: e.data.length });
    }

    const skillMeta = {
      name: finalName,
      description: String(meta.description || '').slice(0, this.limits.maxDescriptionChars),
      when: String(meta.when || '').slice(0, this.limits.maxDescriptionChars),
      version: meta.version || '',
      source: String(source || 'zip'),
      hash: hash || crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
      installedAt: Date.now(),
      updatedAt: Date.now(),
      files: written,
      bytes: total,
    };
    this.skills.set(finalName, skillMeta);
    this.#persist();
    return this.get(finalName);
  }

  remove(name) {
    const meta = this.get(name);
    if (!meta) return false;
    fs.rmSync(meta.path, { recursive: true, force: true });
    this.skills.delete(meta.name);
    this.#persist();
    return true;
  }

  /** 导出成 zip（给 UI 下载 / 分享给别人） */
  exportZip(name) {
    const meta = this.get(name);
    if (!meta) throw new Error(`没有这个技能：${name}`);
    const entries = this.#walk(meta.name).map((rel) => ({
      name: `${meta.name}/${rel}`,
      data: fs.readFileSync(path.join(meta.path, rel)),
    }));
    if (!entries.length) throw new Error(`技能 ${meta.name} 是空的`);
    return writeZip(entries);
  }

  stats() {
    const items = this.list();
    return {
      total: items.length,
      generated: items.filter((s) => s.source === 'generated').length,
      installed: items.filter((s) => s.source !== 'generated').length,
      bytes: items.reduce((sum, s) => sum + (s.bytes || 0), 0),
      dir: this.dir,
    };
  }
}
