// 技能工具：装（zip）、自己生成、读、列、删。
//
// 技能不是「工具」：它是一段给模型看的流程/规范，装完只出现在系统提示的技能清单里，
// 真要用时由模型自己 skill_read 读全文（渐进披露）。技能里的 scripts/ 只是文件，
// 要跑就跑 run_shell —— 沙箱策略照旧管着它。
import fs from 'node:fs';

const noStore = (ctx) => !ctx.skills;

const fmt = (s) => `- ${s.name}${s.version ? `@${s.version}` : ''}: ${s.description}${s.when ? `（何时用：${s.when}）` : ''} [${(s.files || []).length} 个文件 · ${s.source || 'unknown'}]`;

export const skillList = {
  name: 'skill_list',
  description: '列出已安装的技能（名称 / 描述 / 何时用 / 文件数 / 来源）。技能全文用 skill_read 读。',
  category: 'skill',
  readOnly: true,
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    if (noStore(ctx)) return '技能功能已关闭（SKILLS_ENABLED=0）';
    const items = ctx.skills.list();
    if (!items.length) return '还没有安装任何技能（可用 skill_install 装 zip 包，或 skill_create 自己写一个）';
    return items.map(fmt).join('\n');
  },
};

export const skillRead = {
  name: 'skill_read',
  description: '读取一个技能的正文（默认 SKILL.md）。要用某个技能前先读它，按里面的步骤做。',
  category: 'skill',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（skill_list 里的那个）' },
      file: { type: 'string', description: '技能内的相对路径，默认 SKILL.md；也可以读 scripts/ 里的脚本' },
    },
    required: ['name'],
  },
  async run({ name, file }, ctx) {
    if (noStore(ctx)) return '技能功能已关闭（SKILLS_ENABLED=0）';
    const result = ctx.skills.read(String(name || '').trim(), file || 'SKILL.md');
    return `${name} / ${result.file}${result.truncated ? '（已截断）' : ''}\n\n${result.text}`;
  },
};

export const skillInstall = {
  name: 'skill_install',
  description:
    '安装一个技能包（zip）。优先用 zipPath（本机上的 zip 文件）；也可以给 zipBase64（前端上传的包）或 url（http/https 直链）。' +
    '包里必须有根目录的 SKILL.md（含 name/description 的 front matter）。装完技能会出现在「可用技能」清单里，用 skill_read 读全文。',
  category: 'skill',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      zipPath: { type: 'string', description: '本机 zip 文件路径（控制器读盘，不是沙箱里）' },
      zipBase64: { type: 'string', description: 'zip 内容的 base64（界面里上传文件走这条）' },
      url: { type: 'string', description: 'http(s) 直链，控制器代下载' },
      name: { type: 'string', description: '显式指定技能名（覆盖 SKILL.md 里的 name）' },
      force: { type: 'boolean', description: '同名技能已存在时覆盖，默认 false' },
    },
  },
  async run(args, ctx) {
    if (noStore(ctx)) return '技能功能已关闭（SKILLS_ENABLED=0）';
    const { zipPath, zipBase64, url, name, force } = args || {};
    const sources = [zipPath, zipBase64, url].filter(Boolean);
    if (sources.length !== 1) return '请只给一个来源：zipPath / zipBase64 / url';
    let buffer;
    let source;
    if (zipPath) {
      const abs = String(zipPath);
      if (!fs.existsSync(abs)) return `找不到 zip 文件：${abs}`;
      buffer = fs.readFileSync(abs);
      source = abs;
    } else if (zipBase64) {
      buffer = Buffer.from(String(zipBase64).replace(/^data:[^,]*,/, ''), 'base64');
      source = 'base64-upload';
    } else {
      const link = String(url);
      if (!/^https?:\/\//i.test(link)) return 'url 只支持 http/https';
      const res = await fetch(link, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (!res.ok) return `下载失败：HTTP ${res.status}`;
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 8 * 1024 * 1024) return '压缩包太大（>8MB）';
      buffer = Buffer.from(await res.arrayBuffer());
      source = link;
    }
    try {
      const meta = ctx.skills.installZip(buffer, { source, name, force });
      ctx.emit?.({ type: 'skill', action: 'install', name: meta.name, description: meta.description, files: meta.files.length });
      return `已安装技能 ${meta.name}（${meta.description}）· ${meta.files.length} 个文件${meta.when ? ` · 何时用：${meta.when}` : ''}`;
    } catch (err) {
      return `安装失败：${err.message}`;
    }
  },
};

export const skillCreate = {
  name: 'skill_create',
  description:
    '自己写一个技能（不用 zip）：给 name / description / 正文 content，可附 files 附件。' +
    '适合把「刚跑通的一套流程」沉淀成技能；装完立刻出现在「可用技能」清单里，之后每次对话都能用。',
  category: 'skill',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（中英文、数字、._-）' },
      description: { type: 'string', description: '一句话说明这个技能干什么（模型靠它判断何时用）' },
      content: { type: 'string', description: 'SKILL.md 正文：步骤、注意事项、示例命令' },
      when: { type: 'string', description: '什么时候该用这个技能' },
      version: { type: 'string', description: '版本号，可选' },
      files: {
        type: 'array',
        description: '附加文件（脚本/模板），相对路径 + 内容',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path'],
        },
      },
      force: { type: 'boolean', description: '同名技能已存在时覆盖，默认 false' },
    },
    required: ['name', 'description', 'content'],
  },
  async run(args, ctx) {
    if (noStore(ctx)) return '技能功能已关闭（SKILLS_ENABLED=0）';
    const { name, description, content, when, version, files, force } = args || {};
    try {
      const meta = ctx.skills.create({ name, description, content, when, version, files, force });
      ctx.emit?.({ type: 'skill', action: 'create', name: meta.name, description: meta.description, files: meta.files.length });
      return `已创建技能 ${meta.name}（${meta.description}）· ${meta.files.length} 个文件`;
    } catch (err) {
      return `创建失败：${err.message}`;
    }
  },
};

export const skillRemove = {
  name: 'skill_remove',
  description: '删除一个技能（连同它的目录）。',
  category: 'skill',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能名' } },
    required: ['name'],
  },
  async run({ name }, ctx) {
    if (noStore(ctx)) return '技能功能已关闭（SKILLS_ENABLED=0）';
    const meta = ctx.skills.get(String(name || '').trim());
    if (!meta) return `没有这个技能：${name}`;
    ctx.skills.remove(meta.name);
    ctx.emit?.({ type: 'skill', action: 'remove', name: meta.name });
    return `已删除技能 ${meta.name}`;
  },
};

export const skillTools = [skillList, skillRead, skillInstall, skillCreate, skillRemove];
