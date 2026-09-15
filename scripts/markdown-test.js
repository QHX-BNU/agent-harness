// Markdown 渲染测试：逐条语法断言 + 一张全特性截图。
// 用法: node scripts/markdown-test.js [baseUrl]
import { openPage } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:5175';

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

const page = await openPage(BASE, { port: 9343, outDir: 'docs', freshProfile: true, width: 1200, height: 1400 });
const { cdp, sessionId, evalJs, waitFor, shot, sleep } = page;

/** 在页面里调用 MD.render 并取回 HTML */
const md = (src) =>
  evalJs(`(function(){ try { return MD.render(${JSON.stringify(src)}); } catch (e) { return 'ERR: ' + e.message; } })()`);

await waitFor(`document.body.dataset.ready === '1' && typeof MD === 'object'`, '前端与 MD 就绪');
console.log(`Markdown 渲染测试: ${BASE}\n`);

// ================= 块级 =================
console.log('[1] 块级语法');
{
  const h = await md('# 一级标题\n## 二级标题\n### 三级\n#### 四级\n##### 五级\n###### 六级');
  ok('标题 h1~h6', ['<h1', '<h2', '<h3', '<h4', '<h5', '<h6'].every((t) => h.includes(t)));
  ok('标题带锚点 id', /<h1 id="一级标题">/.test(h), h.match(/<h1[^>]*>/)?.[0]);

  const setext = await md('一级\n===\n\n二级\n---');
  ok('setext 标题（=== / ---）', setext.includes('<h1 id="一级">一级</h1>') && setext.includes('<h2 id="二级">二级</h2>'), setext.replace(/\n/g, ' ').slice(0, 60));

  const setextVsHr = await md('文字\n\n---\n\n文字');
  ok('独立 --- 仍是分隔线', (setextVsHr.match(/<hr>/g) || []).length === 1 && !setextVsHr.includes('<h2'));

  const hr = await md('---\n\n***\n\n___');
  ok('三种分隔线', (hr.match(/<hr>/g) || []).length === 3, `${(hr.match(/<hr>/g) || []).length} 条`);

  const p = await md('第一段\n还是第一段\n\n第二段');
  ok('空行分段', (p.match(/<p>/g) || []).length === 2 && p.includes('第一段\n还是第一段'));

  const br = await md('第一行  \n第二行');
  ok('行尾两个空格 → <br>', br.includes('<br>'),
  );
}

console.log('\n[2] 代码');
{
  const fence = await md('```js\nconst a = 1 < 2 && "x";\n```');
  ok('围栏代码块带语言', fence.includes('<code class="language-js">') && fence.includes('<span class="lang">js</span>'));
  ok('代码内容被转义', fence.includes('1 &lt; 2 &amp;&amp; &quot;x&quot;'));
  ok('代码块带复制按钮', fence.includes('class="copy"'));

  const inside = await md('```\n# 这不是标题\n**不加粗**\n```');
  ok('代码块内不解析 markdown', inside.includes('# 这不是标题') && !inside.includes('<h1') && !inside.includes('<strong>'));

  const tilde = await md('~~~python\nprint(1)\n~~~');
  ok('波浪号围栏', tilde.includes('language-python') && tilde.includes('print(1)'));

  const inline = await md('用 `npm run dev` 启动，变量 `a_b_c` 不要加粗');
  ok('行内代码', inline.includes('<code class="inline">npm run dev</code>'));
  ok('行内代码里的下划线不被当强调', inline.includes('a_b_c</code>'));

  const dbl = await md('`` `反引号` ``');
  ok('双反引号包裹', dbl.includes('<code class="inline">`反引号`</code>'), dbl.slice(0, 60));
}

console.log('\n[3] 列表');
{
  const ul = await md('- 甲\n- 乙\n- 丙');
  ok('无序列表', (ul.match(/<li>/g) || []).length === 3 && ul.startsWith('<ul>'));

  const marks = await md('* 星号\n+ 加号\n- 减号');
  ok('三种无序标记都识别', (marks.match(/<li>/g) || []).length === 3);

  const ol = await md('1. 一\n2. 二\n3. 三');
  ok('有序列表', ol.startsWith('<ol>') && (ol.match(/<li>/g) || []).length === 3);
  const olStart = await md('3. 从三开始');
  ok('有序列表带 start', olStart.includes('<ol start="3">'));

  const nested = await md('- 外层\n  - 内层 A\n  - 内层 B\n- 第二个外层');
  ok('嵌套无序列表', (nested.match(/<ul>/g) || []).length === 2 && nested.includes('内层 A'));

  const deep = await md('- 一层\n  - 二层\n    - 三层');
  ok('三层嵌套', (deep.match(/<ul>/g) || []).length === 3, `${(deep.match(/<ul>/g) || []).length} 层`);

  const mixed = await md('1. 一\n   - 子项\n2. 二');
  ok('有序套无序', mixed.includes('<ol>') && mixed.includes('<ul>') && mixed.includes('子项'));

  const task = await md('- [x] 已完成\n- [ ] 待办');
  ok('任务列表', task.includes('type="checkbox"') && task.includes('checked') && (task.match(/li class="task"/g) || []).length === 2);

  const multi = await md('- 第一行\n  第二行仍属于这一项\n- 下一项');
  ok('列表项内多行', (multi.match(/<li>/g) || []).length === 2 && multi.includes('第二行仍属于这一项'));

  const liCode = await md('- 步骤：\n\n  ```bash\n  npm i\n  ```');
  ok('列表项里放代码块', liCode.includes('<li>') && liCode.includes('language-bash'));
}

console.log('\n[4] 引用 / 表格');
{
  const q = await md('> 引用一行\n> 引用第二行');
  ok('引用块', q.startsWith('<blockquote>') && q.includes('引用第二行'));

  const nestedQ = await md('> 外层\n> > 内层');
  ok('嵌套引用', (nestedQ.match(/<blockquote>/g) || []).length === 2);

  const qList = await md('> 注意：\n> - 甲\n> - 乙');
  ok('引用里的列表', qList.includes('<blockquote>') && qList.includes('<li>甲</li>'));

  const table = await md('| 名称 | 值 | 说明 |\n|:-----|:--:|-----:|\n| a | 1 | 左对齐说明 |\n| b | 2 | 第二行 |');
  ok('表格渲染', table.includes('<table>') && table.includes('<thead>') && (table.match(/<tr>/g) || []).length === 3);
  ok('表格对齐（左/中/右）', table.includes('text-align:left') && table.includes('text-align:center') && table.includes('text-align:right'));
  ok('表格有横向滚动容器', table.includes('class="table-wrap"'));

  const tableInline = await md('| 项 | 说明 |\n|---|---|\n| **粗** | `code` |');
  ok('表格单元格里的行内语法', tableInline.includes('<strong>粗</strong>') && tableInline.includes('<code class="inline">code</code>'));
}

console.log('\n[5] 行内语法');
{
  const em = await md('**粗体** 和 *斜体* 和 ***又粗又斜*** 和 ~~删除~~');
  ok('粗体', em.includes('<strong>粗体</strong>'));
  ok('斜体', em.includes('<em>斜体</em>'));
  ok('粗+斜', em.includes('<strong><em>又粗又斜</em></strong>'));
  ok('删除线', em.includes('<del>删除</del>'));

  const under = await md('__粗__ 和 _斜_');
  ok('下划线强调', under.includes('<strong>粗</strong>') && under.includes('<em>斜</em>'));

  const snake = await md('变量 some_var_name 和 _私有 与 前导_ 不应该变斜体');
  ok('snake_case 不被误伤', snake.includes('some_var_name') && !snake.includes('<em>var</em>'));

  const link = await md('[DeepSeek](https://deepseek.com "官网")');
  ok('链接带 title', link.includes('href="https://deepseek.com"') && link.includes('title="官网"') && link.includes('>DeepSeek</a>'));

  const auto = await md('访问 <https://example.com/a?b=1> 看看');
  ok('尖括号自动链接', auto.includes('<a href="https://example.com/a?b=1"') && auto.includes('>https://example.com/a?b=1</a>'));

  const bare = await md('裸链接 https://example.com/x 也要认');
  ok('裸链接自动识别', bare.includes('<a href="https://example.com/x"'));

  const img = await md('![架构图](docs/ui-empty-dark.png "架构")');
  ok('图片', img.includes('<img src="docs/ui-empty-dark.png"') && img.includes('alt="架构图"') && img.includes('loading="lazy"'));

  const esc = await md('字面量 \\*不是斜体\\* 和 \\`不是代码\\`');
  ok('反斜杠转义', esc.includes('*不是斜体*') && !esc.includes('<em>不是斜体</em>'));
}

console.log('\n[6] 安全');
{
  const xss = await md('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  ok('HTML 标签被转义', xss.includes('&lt;script&gt;') && !xss.includes('<script>'));
  ok('事件属性被转义', !xss.includes('onerror=alert') || xss.includes('&lt;img'));

  const js = await md('[点我](javascript:alert(1))');
  ok('javascript: 链接被拦', !js.includes('href="javascript:') && js.includes('点我'));

  const data = await md('[x](data:text/html;base64,AAA)');
  ok('data: 链接被拦', !data.includes('href="data:'));

  const quoted = await md('[x](https://a.com/"><script>alert(1)</script>)');
  ok('URL 里的引号被编码', !quoted.includes('"><script>'), quoted.slice(0, 70));
}

console.log('\n[7] 边界');
{
  ok('空输入返回空串', (await md('')) === '');
  ok('纯文本包成段落', (await md('就是一句话')) === '<p>就是一句话</p>');
  const unclosed = await md('```js\n没有闭合的代码块');
  ok('未闭合代码块不崩', unclosed.includes('<pre>') && unclosed.includes('没有闭合的代码块'));
  const emptyList = await md('- \n- ');
  ok('空列表项不崩', typeof emptyList === 'string' && !emptyList.startsWith('ERR'));
  const mixedEnd = await md('文字\n```\ncode\n```\n- 列表\n# 标题');
  ok('块级混排顺序正确', mixedEnd.indexOf('<p>') < mixedEnd.indexOf('<pre>') && mixedEnd.indexOf('<ul>') < mixedEnd.indexOf('<h1'));
}

// ================= 界面渲染 =================
console.log('\n[8] 界面渲染（真实气泡 + 截图）');
{
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId);

  const fixture = [
    '# 渲染自查报告',
    '',
    '这段是 **粗体**、*斜体*、***粗斜***、~~删除线~~、`行内代码`，还有 [一个链接](https://github.com/QHX-BNU/agent-harness)。',
    '',
    '## 表格',
    '',
    '| 语法 | 支持 | 备注 |',
    '|:-----|:----:|-----:|',
    '| 标题 | ✓ | h1~h6 |',
    '| 表格 | ✓ | 含对齐 |',
    '| 任务列表 | ✓ | 可勾选 |',
    '',
    '## 列表',
    '',
    '1. 第一步：装依赖',
    '2. 第二步：跑测试',
    '   - 单元测试',
    '   - 端到端测试',
    '3. 第三步：部署',
    '',
    '- [x] 写完解析器',
    '- [x] 加安全过滤',
    '- [ ] 补边界用例',
    '',
    '## 引用与代码',
    '',
    '> **注意**：代码块里的内容不会被解析。',
    '> > 嵌套引用也要能渲染。',
    '',
    '```js',
    'const md = require("./markdown");',
    'console.log(md.render("# hi"));   // <h1 id="hi">hi</h1>',
    '```',
    '',
    '---',
    '',
    '结尾段落，用来确认 `hr` 之后的间距。',
  ].join('\n');

  await evalJs(`(function(){ Chat.addBubble('assistant', ${JSON.stringify(fixture)}); return true; })()`);
  await sleep(500);
  await evalJs(`document.getElementById('messages').scrollTop = 0; true`);
  await sleep(200);

  const dom = JSON.parse(
    await evalJs(`JSON.stringify({
      h1: !!document.querySelector('.msg.assistant .bubble h1'),
      tables: document.querySelectorAll('.msg.assistant .bubble table').length,
      ths: document.querySelectorAll('.msg.assistant .bubble th').length,
      uls: document.querySelectorAll('.msg.assistant .bubble ul').length,
      ols: document.querySelectorAll('.msg.assistant .bubble ol').length,
      lis: document.querySelectorAll('.msg.assistant .bubble li').length,
      tasks: document.querySelectorAll('.msg.assistant .bubble li.task').length,
      checked: document.querySelectorAll('.msg.assistant .bubble li.task input:checked').length,
      quotes: document.querySelectorAll('.msg.assistant .bubble blockquote').length,
      code: document.querySelectorAll('.msg.assistant .bubble .codeblock pre code').length,
      hr: document.querySelectorAll('.msg.assistant .bubble hr').length,
      links: document.querySelectorAll('.msg.assistant .bubble a').length,
      copyBtn: !!document.querySelector('.msg.assistant .bubble .copy'),
      whiteSpace: getComputedStyle(document.querySelector('.msg.assistant .bubble')).whiteSpace,
      tableWidth: document.querySelector('.msg.assistant .bubble table')?.getBoundingClientRect().width || 0,
      bubbleWidth: document.querySelector('.msg.assistant .bubble').getBoundingClientRect().width,
      overflow: [...document.querySelectorAll('.msg.assistant .bubble *')].filter(n => n.getBoundingClientRect().right > innerWidth + 1).length,
    })`),
  );

  ok('标题渲染进气泡', dom.h1);
  ok('表格进入 DOM', dom.tables === 1 && dom.ths === 3, `${dom.tables} 表 / ${dom.ths} 表头`);
  ok('列表与嵌套', dom.uls >= 2 && dom.ols === 1 && dom.lis >= 8, `ul=${dom.uls} ol=${dom.ols} li=${dom.lis}`);
  ok('任务列表可勾选', dom.tasks === 3 && dom.checked === 2, `${dom.tasks} 项，${dom.checked} 项已勾选`);
  ok('嵌套引用', dom.quotes === 2);
  ok('代码块', dom.code === 1);
  ok('分隔线', dom.hr === 1);
  ok('链接可点击', dom.links >= 1);
  ok('复制按钮存在', dom.copyBtn);
  ok('markdown 气泡关闭 pre-wrap', dom.whiteSpace === 'normal', dom.whiteSpace);
  ok('表格不撑破气泡', dom.tableWidth <= dom.bubbleWidth + 1, `${Math.round(dom.tableWidth)} <= ${Math.round(dom.bubbleWidth)}`);
  ok('没有元素横向溢出视口', dom.overflow === 0, `${dom.overflow} 个溢出`);

  const file = await shot('ui-markdown.png');
  console.log(`  ✓ 全特性截图 → ${file}`);
}

page.close();
console.log(`\n${fail === 0 ? '✓' : '✗'} Markdown 渲染测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
