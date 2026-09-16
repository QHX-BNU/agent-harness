// 技能专项：zip 读写 / 安装校验（zip-slip、符号链接、体积）/ 自己生成 / 导出重装 / 工具层。
// 用法: node scripts/skills-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { readZip, writeZip, crc32 } from '../src/zip.js';
import { SkillStore, sanitizeSkillName, parseSkillMarkdown } from '../src/skills.js';
import { createToolRegistry } from '../src/tools/index.js';
import { buildSystemPrompt } from '../src/context.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (err) {
    return err.message;
  }
};

/** 造一个「不经过写入口校验」的 zip：用 store 写好后按等长替换名字 / 改外部属性 */
function evilZip(name) {
  const placeholder = 'x'.repeat(Buffer.byteLength(name));
  const buf = writeZip([{ name: placeholder, data: 'boom' }]);
  return Buffer.from(buf.toString('latin1').split(placeholder).join(name), 'latin1');
}

/** 造一个 deflate(8) 压缩的 zip（验证读取侧支持真实世界的压缩包） */
function deflateZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
const dir = path.join(tmp, '.skills');

console.log('技能测试\n');

section('[1] zip 读写');
{
  const buf = writeZip([
    { name: 'SKILL.md', data: '# hi\n中文内容\n' },
    { name: 'scripts/', data: '', dir: true },
    { name: 'scripts/run.py', data: 'print(1)\n' },
  ]);
  const entries = readZip(buf);
  ok('写出的 zip 能读回来', entries.length === 3 && entries[0].name === 'SKILL.md');
  ok('中文内容原样还原', entries[0].data.toString('utf8') === '# hi\n中文内容\n');
  ok('目录条目被标记', entries[1].dir === true);
  ok('crc32 正确', crc32(Buffer.from('abc')) === 0x352441c2);
  const inflated = readZip(deflateZip([{ name: 'SKILL.md', data: '# deflate\n' }]));
  ok('能读 deflate 压缩的 zip（真实压缩包常见）', inflated[0].data.toString('utf8') === '# deflate\n');
  ok('写入口拒绝 .. 路径', /非法 zip 条目名/.test(throws(() => writeZip([{ name: '../x', data: 'x' }]))));
}

section('[2] 安装 zip');
{
  const store = new SkillStore({ dir });
  const zip = writeZip([
    { name: 'xhs-post/SKILL.md', data: '---\nname: xhs-post\ndescription: 发布小红书帖子\nwhen: 用户要发帖\nversion: 1.2.0\n---\n\n# 步骤\n1. 生成图\n2. xhs post\n' },
    { name: 'xhs-post/scripts/post.py', data: 'print("post")\n' },
  ]);
  const meta = store.installZip(zip, { source: 'test.zip' });
  ok('外层目录被剥掉、技能名来自 front matter', meta.name === 'xhs-post' && meta.files.length === 2, meta.files.map((f) => f.path).join(','));
  ok('元数据被解析', meta.description === '发布小红书帖子' && meta.when === '用户要发帖' && meta.version === '1.2.0');
  ok('记录了来源与 hash', meta.source === 'test.zip' && /^[0-9a-f]{16}$/.test(meta.hash), meta.hash);
  ok('SKILL.md 能读回', store.read('xhs-post').text.includes('xhs post'));
  ok('附件也能读', store.read('xhs-post', 'scripts/post.py').text.includes('print'));
  ok('list 带路径与文件数', store.list()[0].path.endsWith('xhs-post') && store.list()[0].files.length === 2);
  ok('同名再装会被拦住', /已存在/.test(throws(() => store.installZip(zip, { source: 'again' }))));
  ok('force 可以覆盖', store.installZip(zip, { source: 'again', force: true }).name === 'xhs-post');
  ok('summary 给提示词用（不含正文）', JSON.stringify(store.summary()).length < 300 && /发布小红书帖子/.test(store.summary()[0].description));
  ok('目录里没有 index.json 之外的杂物', fs.readdirSync(dir).sort().join(',') === 'index.json,xhs-post');
}

section('[3] 危险包全被拦住');
{
  const store = new SkillStore({ dir: path.join(tmp, 'evil-skills') });
  ok('zip-slip（../）被拒', /不安全的路径/.test(throws(() => store.installZip(evilZip('../evil.txt'), { source: 'evil' }))));
  ok('绝对路径被拒', /不安全的路径/.test(throws(() => store.installZip(evilZip('C:/Windows/evil.txt'), { source: 'evil' }))));
  ok('没有 SKILL.md 的包被拒', /没有根目录的 SKILL.md/.test(throws(() => store.installZip(writeZip([{ name: 'readme.txt', data: 'x' }]), { source: 'x' }))));
  ok('空包被拒', /不是有效的 zip|空的|没有可用文件|没有根目录/.test(throws(() => store.installZip(writeZip([{ name: 'SKILL.md', data: '# x\n' }]).subarray(0, 0), { source: 'empty' }))));
  // 符号链接：改 central directory 的外部属性高 16 位
  const sym = writeZip([{ name: 'SKILL.md', data: '# x\n' }]);
  const centralAt = sym.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  sym.writeUInt32LE(0xa1ff0000, centralAt + 38);
  ok('符号链接被拒', /符号链接/.test(throws(() => store.installZip(sym, { source: 'sym' }))));
  const big = writeZip([{ name: 'SKILL.md', data: `# x\n${'a'.repeat(600 * 1024)}` }]);
  ok('超大文件被拒', /太大/.test(throws(() => store.installZip(big, { source: 'big' }))));
  const many = writeZip([{ name: 'SKILL.md', data: '# x\n' }, ...Array.from({ length: 220 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }))]);
  ok('文件数超限被拒', /文件数超限/.test(throws(() => store.installZip(many, { source: 'many' }))));
  ok('坏技能名会被净化', sanitizeSkillName('../../etc/passwd') === 'etc-passwd', sanitizeSkillName('../../etc/passwd'));
  ok('解析器容错：没有 front matter 用第一段当描述', parseSkillMarkdown('# 标题\n\n这是描述\n').meta.description === '这是描述');
}

section('[4] 自己生成 / 导出 / 手放目录');
{
  const store = new SkillStore({ dir });
  const made = store.create({
    name: 'daily-report',
    description: '汇总今天做了什么，写成日报',
    when: '用户说「写日报」',
    content: '# 步骤\n1. 看 trace\n2. 汇总\n',
    files: [{ path: 'template.md', content: '# 日报模板' }],
  });
  ok('自己生成的技能落盘', made.source === 'generated' && fs.existsSync(path.join(dir, 'daily-report', 'SKILL.md')));
  ok('生成的文件可读', store.read('daily-report', 'template.md').text.includes('日报模板'));
  ok('front matter 自动写全', parseSkillMarkdown(store.read('daily-report').text).meta.when === '用户说「写日报」');
  ok('同名生成默认拦住', /已存在/.test(throws(() => store.create({ name: 'daily-report', description: 'x', content: 'y' }))));
  ok('force 覆盖', store.create({ name: 'daily-report', description: '改过', content: '# 新', force: true }).description === '改过');
  ok('覆盖会清掉上一版的附件（不留残骸）', !fs.existsSync(path.join(dir, 'daily-report', 'template.md')));
  store.create({
    name: 'daily-report',
    description: '改过',
    content: '# 步骤\n1. 看 trace\n',
    files: [{ path: 'template.md', content: '# 日报模板 v2' }],
    force: true,
  });
  ok('重新生成回附件', store.read('daily-report', 'template.md').text.includes('v2'));
  ok('没写描述时会从正文推断', store.create({ name: 'guess-desc', description: '', content: '这个技能用来推断描述\n' }).description === '这个技能用来推断描述');
  ok('正文里也找不到描述才拒绝', /描述不能为空/.test(throws(() => store.create({ name: 'no-desc', description: '', content: '# 只有标题\n' }))));

  const zip = store.exportZip('daily-report');
  ok('导出的是合法 zip', readZip(zip).some((e) => e.name === 'daily-report/SKILL.md'));
  store.remove('daily-report');
  const again = store.installZip(zip, { source: 'exported.zip' });
  ok('导出再装回（分享闭环）', again.name === 'daily-report' && again.files.some((f) => f.path === 'template.md'));
  ok('删除不存在返回 false', store.remove('nope') === false);

  fs.mkdirSync(path.join(dir, 'hand-made'));
  fs.writeFileSync(path.join(dir, 'hand-made', 'SKILL.md'), '# 手写的\n放在目录里也能用\n');
  const store2 = new SkillStore({ dir });
  ok('手放进目录的技能也被识别', store2.list().some((s) => s.name === 'hand-made' && s.source === 'disk'));
}

section('[5] 工具层');
{
  const store = new SkillStore({ dir: path.join(tmp, 'tool-skills') });
  const tools = createToolRegistry();
  const ctx = { skills: store, session: { id: 's1' }, config: {}, emit: () => {} };

  const empty = await tools.execute('skill_list', {}, ctx);
  ok('skill_list 空库有引导', /还没有安装任何技能/.test(empty.content));
  const created = await tools.execute('skill_create', { name: 'xhs-post', description: '发布小红书帖子', when: '要发帖时', content: '# 步骤\n1. 用 xhs post' }, ctx);
  ok('skill_create 生成技能', created.ok && /已创建技能 xhs-post/.test(created.content));
  const listed = await tools.execute('skill_list', {}, ctx);
  ok('skill_list 列出技能', /xhs-post/.test(listed.content) && /要发帖时/.test(listed.content));
  const read = await tools.execute('skill_read', { name: 'xhs-post' }, ctx);
  ok('skill_read 读全文', read.ok && /xhs post/.test(read.content));
  const zipPath = path.join(tmp, 'from-file.zip');
  fs.writeFileSync(zipPath, writeZip([{ name: 'SKILL.md', data: '---\nname: zip-skill\ndescription: 从 zip 装\nduration: 1\n---\n\n# 内容\n' }]));
  const installed = await tools.execute('skill_install', { zipPath }, ctx);
  ok('skill_install 从路径安装', installed.ok && /已安装技能 zip-skill/.test(installed.content));
  ok('skill_install 多来源会拒绝', /只给一个来源/.test((await tools.execute('skill_install', { zipPath, url: 'https://x/y.zip' }, ctx)).content));
  ok('skill_install 坏包返回失败而不是抛异常', /安装失败/.test((await tools.execute('skill_install', { zipBase64: Buffer.from('not a zip').toString('base64') }, ctx)).content));
  const removed = await tools.execute('skill_remove', { name: 'zip-skill' }, ctx);
  ok('skill_remove 删除', removed.ok && !store.get('zip-skill'));
  ok('没有 skills 的 ctx 不会崩', (await tools.execute('skill_list', {}, {})).content.includes('已关闭'));
  ok('写类技能工具没被标成只读（要过审批）', ['skill_install', 'skill_create', 'skill_remove'].every((n) => tools.get(n).readOnly === false));
  ok('读类技能工具是只读', ['skill_list', 'skill_read'].every((n) => tools.get(n).readOnly === true));
  ok('技能工具单独一类', tools.all.filter((t) => t.category === 'skill').length === 5);
}

section('[6] 系统提示里的技能清单');
{
  const store = new SkillStore({ dir });
  const prompt = buildSystemPrompt({ workspace: tmp, tools: [], approvalMode: 'ask', model: 'mock-1', skills: store.summary() });
  ok('清单含名字/描述/何时用', /xhs-post/.test(prompt) && /发布小红书帖子/.test(prompt) && /何时用/.test(prompt));
  ok('提示模型先读全文', /skill_read/.test(prompt));
  ok('清单不塞正文', !/1\. 生成图/.test(prompt));
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录留给系统清 */
}
console.log(`\n${fail === 0 ? '✓' : '✗'} 技能测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
