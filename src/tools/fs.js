// 文件类工具：读、写、改、找。所有路径都必须在工作区内——这是 harness 的第一道边界。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../fsutil.js';
import { config } from '../config.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.sessions', '.artifacts', '.memory', 'dist', 'build', '.next']);

export function safeResolve(p, root = config.workspace) {
  const abs = path.resolve(root, p || '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界：${p} 不在工作区 ${root} 内`);
  }
  return abs;
}

/** 工具的工作区根目录：优先用本次调用的 ctx（便于测试与多工作区），否则回落到全局配置 */
export const rootOf = (ctx) => ctx?.sandbox?.roots?.[0] || ctx?.config?.workspace || config.workspace;
const relOf = (abs, root) => path.relative(root, abs).split(path.sep).join('/') || '.';

/**
 * 统一的路径入口：有沙箱就走沙箱（作用区域 + 只读），否则退回旧的「工作区内」检查。
 * @param {string} p
 * @param {{sandbox?:object, config?:object, forWrite?:boolean, cwd?:string, tool?:string}} ctx
 */
export function resolveInSandbox(p, ctx = {}) {
  if (ctx.sandbox) {
    return ctx.sandbox.resolve(p, { forWrite: Boolean(ctx.forWrite), cwd: ctx.cwd, tool: ctx.tool });
  }
  const root = rootOf(ctx);
  const abs = safeResolve(p, root);
  return abs;
}

/** 递归遍历（跳过依赖/缓存目录），支持 glob 通配 */
function walk(root, { maxFiles = 5000 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

/** 极简 glob：支持 ** / * / ? ，够 agent 用 */
function globToRegExp(pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`, 'i');
}

export const listDir = {
  name: 'list_dir',
  description: '列出工作区内某个目录的条目（名称/类型/大小）。',
  category: 'fs',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对工作区的目录路径，默认 "."' } },
  },
  async run({ path: p = '.' }, ctx) {
    const root = rootOf(ctx);
    const abs = resolveInSandbox(p, { ...ctx, tool: 'list_dir' });
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const lines = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 300)
      .map((e) => {
        if (e.isDirectory()) return `d  ${e.name}/`;
        try {
          return `f  ${e.name}  (${fs.statSync(path.join(abs, e.name)).size} B)`;
        } catch {
          return `f  ${e.name}`;
        }
      });
    return `目录 ${relOf(abs, root)} 共 ${entries.length} 项：\n${lines.join('\n')}`;
  },
};

export const readFile = {
  name: 'read_file',
  description: '读取工作区内一个文本文件，返回带行号的内容。',
  category: 'fs',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区的文件路径' },
      offset: { type: 'integer', description: '起始行（1-based），默认 1' },
      limit: { type: 'integer', description: '最多返回多少行，默认 200' },
    },
    required: ['path'],
  },
  async run({ path: p, offset = 1, limit = 200 }, ctx) {
    const root = rootOf(ctx);
    const abs = resolveInSandbox(p, { ...ctx, tool: 'read_file' });
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error(`${p} 是目录，请用 list_dir`);
    if (stat.size > 2_000_000) throw new Error(`文件过大（${stat.size} B），请用 grep 定位或用 run_shell 分段查看`);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const start = Math.max(1, Number(offset) || 1);
    const slice = lines.slice(start - 1, start - 1 + (Number(limit) || 200));
    const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
    return `文件 ${relOf(abs, root)}（共 ${lines.length} 行，显示 ${start}~${start + slice.length - 1}）：\n${body}`;
  },
};

export const writeFile = {
  name: 'write_file',
  description: '写入（新建或整体覆盖）工作区内的一个文本文件，父目录会自动创建。',
  category: 'fs',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区的文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  async run({ path: p, content }, ctx) {
    const root = rootOf(ctx);
    const abs = resolveInSandbox(p, { ...ctx, tool: 'write_file', forWrite: true });
    const existed = fs.existsSync(abs);
    const before = existed ? fs.statSync(abs).size : 0;
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, String(content ?? ''), 'utf8');
    const after = fs.statSync(abs).size;
    return `${existed ? '已覆盖' : '已创建'} ${relOf(abs, root)}：${before} B → ${after} B`;
  },
};

export const editFile = {
  name: 'edit_file',
  description: '对文件做精确字符串替换（old_string 必须唯一出现，除非 replace_all=true）。比整体重写安全。',
  category: 'fs',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区的文件路径' },
      old_string: { type: 'string', description: '要被替换的原文（必须精确匹配，含缩进）' },
      new_string: { type: 'string', description: '替换后的内容；传空串表示删除' },
      replace_all: { type: 'boolean', description: '是否替换全部匹配，默认 false' },
    },
    required: ['path', 'old_string'],
  },
  async run({ path: p, old_string, new_string = '', replace_all = false }, ctx) {
    const root = rootOf(ctx);
    const abs = resolveInSandbox(p, { ...ctx, tool: 'edit_file', forWrite: true });
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${p}`);
    const text = fs.readFileSync(abs, 'utf8');
    const occurrences = text.split(old_string).length - 1;
    if (occurrences === 0) throw new Error('old_string 在文件中找不到（注意缩进与换行必须完全一致）');
    if (occurrences > 1 && !replace_all) {
      throw new Error(`old_string 出现了 ${occurrences} 次，请提供更长的上下文，或设置 replace_all=true`);
    }
    const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
    fs.writeFileSync(abs, next, 'utf8');
    return `已修改 ${relOf(abs, root)}：替换 ${replace_all ? occurrences : 1} 处，${text.length} → ${next.length} 字符`;
  },
};

export const globFiles = {
  name: 'glob',
  description: '按通配符查找文件（支持 ** / * / ?），例如 "src/**/*.js"。',
  category: 'fs',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，例如 "**/*.json"' },
      path: { type: 'string', description: '搜索根目录（相对工作区），默认 "."' },
      limit: { type: 'integer', description: '最多返回多少个文件，默认 100' },
    },
    required: ['pattern'],
  },
  async run({ pattern, path: p = '.', limit = 100 }, ctx) {
    const root = rootOf(ctx);
    const base = resolveInSandbox(p, { ...ctx, tool: 'glob' });
    const re = globToRegExp(pattern);
    const files = walk(base)
      .map((abs) => relOf(abs, root))
      .filter((r) => re.test(r) || re.test(path.basename(r)))
      .slice(0, Number(limit) || 100);
    return files.length ? `匹配 ${files.length} 个文件：\n${files.join('\n')}` : `没有匹配 "${pattern}" 的文件`;
  },
};

export const grepFiles = {
  name: 'grep',
  description: '在文件内容里按正则搜索，返回 文件:行号:内容。',
  category: 'fs',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索根目录（相对工作区），默认 "."' },
      include: { type: 'string', description: '只搜匹配这个 glob 的文件，例如 "*.js"' },
      limit: { type: 'integer', description: '最多返回多少条命中，默认 60' },
      ignore_case: { type: 'boolean', description: '是否忽略大小写' },
    },
    required: ['pattern'],
  },
  async run({ pattern, path: p = '.', include, limit = 60, ignore_case = false }, ctx) {
    const root = rootOf(ctx);
    const base = resolveInSandbox(p, { ...ctx, tool: 'grep' });
    const re = new RegExp(pattern, ignore_case ? 'i' : '');
    const includeRe = include ? globToRegExp(include) : null;
    const hits = [];
    for (const abs of walk(base)) {
      const r = relOf(abs, root);
      if (includeRe && !includeRe.test(r) && !includeRe.test(path.basename(r))) continue;
      let text;
      try {
        if (fs.statSync(abs).size > 1_000_000) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // 跳过二进制
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${r}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= (Number(limit) || 60)) break;
        }
      }
      if (hits.length >= (Number(limit) || 60)) break;
    }
    return hits.length ? `命中 ${hits.length} 条：\n${hits.join('\n')}` : `没有命中 "${pattern}"`;
  },
};

export const fsTools = [listDir, readFile, writeFile, editFile, globFiles, grepFiles];
