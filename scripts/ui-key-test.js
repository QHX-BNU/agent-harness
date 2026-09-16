// 专项测试：在界面上填真实的 API key / Base URL / 模型，点「测试连接」并真的发一轮对话。
// 用假厂商服务当"真实模型"（它强制校验 key，没带 key 直接 401），因此这条链路是真验证。
//
// 用法: node scripts/ui-key-test.js
// 前置: node scripts/fake-llm.js 5199   （另开一个窗口）
//       node server.js                   （harness 本体）
import { openPage } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:5175';
const FAKE = process.argv[3] || 'http://127.0.0.1:5199/v1';
const KEY = 'sk-ui-test-key';

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

const page = await openPage(BASE, { port: 9334, outDir: 'docs', freshProfile: true });
const { evalJs, waitFor, shot } = page;
console.log(`界面: ${BASE}\n假厂商: ${FAKE}\n`);

try {
  // 供应商下拉是 /api/providers 回来之后才填的：只等按钮存在会在慢机器上抢跑
  // （select 里还没有 custom，赋值会被丢掉）。
  await waitFor(`document.body.dataset.ready === '1'`, '前端就绪');
  await waitFor(`!!document.getElementById('openSettings')`, '页面加载完成');

  // ---- 1. 打开设置，填入 key / 端点 / 模型 ----
  await evalJs(`document.getElementById('openSettings').click(); true`);
  await waitFor(`!document.getElementById('settingsModal').hidden`, '设置弹窗打开');

  await evalJs(`
    (() => {
      const set = (id, v) => { const n = document.getElementById(id); n.value = v; n.dispatchEvent(new Event('change')); };
      set('setProvider', 'custom');
      set('setModel', 'fake-1');
      set('setBaseUrl', ${JSON.stringify(FAKE)});
      set('setApiKey', ${JSON.stringify(KEY)});
      return true;
    })()
  `);
  const formState = JSON.parse(
    await evalJs(
      `JSON.stringify({p: document.getElementById('setProvider').value, m: document.getElementById('setModel').value, u: document.getElementById('setBaseUrl').value, k: document.getElementById('setApiKey').value.length})`,
    ),
  );
  ok(
    '表单接受 provider/model/baseUrl/key',
    formState.p === 'custom' && formState.m === 'fake-1' && formState.u === FAKE && formState.k === KEY.length,
    JSON.stringify(formState),
  );

  // ---- 2. 测试连接（真打 /api/probe，假厂商会校验 key）----
  await evalJs(`document.getElementById('testConn').click(); true`);
  await waitFor(`document.getElementById('testResult').textContent.length > 0`, '探测返回', 30000);
  const testResult = await evalJs(`document.getElementById('testResult').textContent`);
  ok('填了 key 后测试连接成功', testResult.startsWith('✓'), testResult.slice(0, 100));
  ok('探测结果显示真实模型名与延迟', /fake-1/.test(testResult) && /ms/.test(testResult));

  // ---- 3. 保存后：设置要落到输入框上方的选择器 ----
  await evalJs(`document.getElementById('saveSettings').click(); true`);
  await waitFor(`document.getElementById('settingsModal').hidden`, '设置弹窗关闭');
  const composer = JSON.parse(
    await evalJs(
      `JSON.stringify({p: document.getElementById('provider').value, m: document.getElementById('model').value, badge: document.getElementById('keyBadge').hidden})`,
    ),
  );
  ok('保存后输入框上方的供应商切换为 custom', composer.p === 'custom', composer.p);
  ok('保存后输入框上方的模型同步', composer.m === 'fake-1', composer.m);
  ok('已有 key 时不再提示未配置', composer.badge === true);
  const savedShot = await shot('ui-key-saved.png');

  // ---- 4. 真的发一轮：key 必须被带到后端，否则假厂商返回 401 ----
  await evalJs(`
    const i = document.getElementById('input');
    i.value = '列一下工作区';
    document.getElementById('send').click();
    true;
  `);
  await waitFor(`document.getElementById('stop').hidden === true && document.querySelectorAll('.msg.assistant').length > 0`, '本轮结束', 40000);
  const chat = JSON.parse(
    await evalJs(
      `JSON.stringify({
        assistant: [...document.querySelectorAll('.msg.assistant .bubble')].map(n => n.textContent),
        error: [...document.querySelectorAll('.msg.error .bubble')].map(n => n.textContent),
        meta: document.getElementById('meta').textContent,
        tools: document.querySelectorAll('.tool').length,
      })`,
    ),
  );
  ok('带 key 的对话拿到模型回复', chat.assistant.length > 0 && chat.error.length === 0, chat.assistant.at(-1)?.slice(0, 40));
  ok('回复来自真实端点（openai 协议）', /openai/.test(chat.meta), chat.meta);
  ok('工具调用在界面上渲染出来', chat.tools > 0, `${chat.tools} 张工具卡`);
  const chatShot = await shot('ui-key-chat.png');

  // ---- 5. 换成需要 key 的云端供应商、且不填 key → 应该提示未配置 ----
  await evalJs(`document.getElementById('openSettings').click(); true`);
  await waitFor(`!document.getElementById('settingsModal').hidden`, '再次打开设置');
  await evalJs(`
    (() => {
      const set = (id, v) => { const n = document.getElementById(id); n.value = v; n.dispatchEvent(new Event('change')); };
      set('setProvider', 'deepseek');
      document.getElementById('setApiKey').value = '';
      document.getElementById('saveSettings').click();
      return true;
    })()
  `);
  await waitFor(`!document.getElementById('keyBadge').hidden`, '未配置 key 提示', 10000);
  const badgeText = await evalJs(`document.getElementById('keyBadge').textContent`);
  ok('切到需 key 的供应商且未填 → 提示未配置', /未配置/.test(badgeText), badgeText);

  console.log(`\n  截图: ${savedShot}`);
  console.log(`  截图: ${chatShot}`);
} finally {
  page.close();
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 界面填 key 专项测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
