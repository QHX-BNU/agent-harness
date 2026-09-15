// 用 Chrome DevTools Protocol 真实驱动前端（驱动逻辑在 scripts/cdp.js，无第三方依赖）：
// 打开设置 → 测试连接 → 等审批卡片 → 点「允许执行」→ 等本轮结束 → 截图 + DOM 断言 + 布局体检。
// 用法: node scripts/ui-check.js [baseUrl] [message]
// 前置: 先 node server.js（或设置 BASE 指向已启动的服务）
import path from 'node:path';
import fs from 'node:fs';
import { openPage } from './cdp.js';

const BASE = process.argv[2] || 'http://127.0.0.1:5175';
const SAY = process.argv[3] || '帮我创建 ui-check/hello.txt 测试审批按钮';
const PORT = Number(process.env.CDP_PORT || 9333);
const OUT = path.join(process.cwd(), 'docs');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const page = await openPage(`${BASE}/?say=${encodeURIComponent(SAY)}`, { port: PORT, outDir: OUT });
const { cdp, sessionId, evalJs, waitFor, shot } = page;

try {
  const okCheck = (name, cond, extra = '') => {
    if (cond) console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
    else {
      console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
      failed = true;
    }
  };

  await waitFor(`!!document.querySelector('.msg.user')`, '用户消息渲染');

  // 设置弹窗：点齿轮 → 检查表单 → 点「测试连接」（真打一次 /api/probe）
  await evalJs(`document.getElementById('openSettings').click(); true`);
  await waitFor(`!document.getElementById('settingsModal').hidden`, '设置弹窗打开');
  const form = JSON.parse(
    await evalJs(`(() => {
      const b = document.getElementById('openSettings').getBoundingClientRect();
      return JSON.stringify({
        providers: document.getElementById('setProvider').options.length,
        hasKeyInput: document.getElementById('setApiKey').type === 'password',
        hasBaseUrl: !!document.getElementById('setBaseUrl'),
        hasApproval: document.getElementById('setApproval').options.length,
        modelInComposer: !!document.querySelector('.composer-bar #model'),
        approvalInComposer: !!document.querySelector('.composer-bar #approvalMode'),
        topbarHasProvider: !!document.querySelector('.topbar #provider'),
        settingsInSidebarFoot: !!document.querySelector('.sidebar-foot #openSettings'),
        settingsBottomLeft: b.left < innerWidth / 2 && b.top > innerHeight / 2,
        settingsX: Math.round(b.left), settingsY: Math.round(b.top),
        vw: innerWidth, vh: innerHeight,
        panelTabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab),
      });
    })()`),
  );
  console.log(`  设置弹窗: 供应商 ${form.providers} 项 · key 输入框 ${form.hasKeyInput ? '有' : '无'} · Base URL ${form.hasBaseUrl ? '有' : '无'}`);
  okCheck('模型选择已移到输入框区域', form.modelInComposer);
  okCheck('审批选择已移到输入框区域', form.approvalInComposer);
  okCheck('顶栏不再放模型选择', !form.topbarHasProvider);
  okCheck('设置里有 API key 输入框', form.hasKeyInput);
  okCheck('设置入口在左下角（侧栏底部）', form.settingsInSidebarFoot && form.settingsBottomLeft, `x=${form.settingsX} y=${form.settingsY} / ${form.vw}x${form.vh}`);
  okCheck('右侧面板只剩 状态 + Trace', form.panelTabs.join(',') === 'status,trace', form.panelTabs.join(','));

  await evalJs(`document.getElementById('testConn').click(); true`);
  await waitFor(`document.getElementById('testResult').textContent.includes('✓')`, '设置里测试连接成功', 30000);
  const testResult = await evalJs(`document.getElementById('testResult').textContent`);
  console.log(`  测试连接: ${testResult.slice(0, 110)}`);

  // 设置里的六个分区：任务 / 记忆 / 工具 / 工作流 都住在这里
  for (const sec of ['model', 'chat', 'todos', 'memory', 'tools', 'workflows']) {
    await evalJs(`document.querySelector('.snav[data-sec="${sec}"]').click(); true`);
    await sleep(450);
    const info = JSON.parse(
      await evalJs(`JSON.stringify({
        active: document.getElementById('sec-${sec}').classList.contains('active'),
        shown: document.getElementById('sec-${sec}').offsetHeight > 0,
        text: document.getElementById('sec-${sec}').innerText.trim().length,
      })`),
    );
    console.log(`  设置分区 ${sec.padEnd(10)} 可见=${info.shown} · ${info.text} 字符`);
    if (!info.active || !info.shown || info.text < 5) {
      console.log(`  ✗ 设置分区 ${sec} 异常`);
      failed = true;
    }
  }
  await evalJs(`document.querySelector('.snav[data-sec="tools"]').click(); true`);
  await sleep(300);
  const settingsShot = await shot('ui-settings.png');
  console.log(`  ✓ 设置弹窗截图 → ${settingsShot}`);
  await evalJs(`document.getElementById('closeSettings').click(); true`);
  await waitFor(`document.getElementById('settingsModal').hidden`, '设置弹窗关闭');

  await waitFor(`!!document.querySelector('.approval button.ok')`, '审批卡片出现');
  const approvalShot = await shot('ui-approval.png');
  console.log(`✓ 审批卡片已出现 → ${approvalShot}`);

  await evalJs(`document.querySelector('.approval button.ok').click(); true`);
  await waitFor(`document.getElementById('stop').hidden === true`, '本轮结束', 30000);
  const doneShot = await shot('ui-done.png');

  // 关键 DOM 在跑完一轮后必须还活着（曾经被 panels 的 textContent 整块替换掉过）
  const alive = JSON.parse(
    await evalJs(`JSON.stringify({
      statusText: document.getElementById('statusText')?.textContent ?? null,
      pillClass: document.getElementById('statusPill')?.className ?? null,
      sessionTitle: document.getElementById('sessionTitle')?.textContent ?? null,
      composer: !!document.querySelector('.composer-input textarea'),
      send: !!document.getElementById('send'),
      traceTab: !!document.querySelector('.tab[data-tab="trace"]'),
    })`),
  );
  okCheck('状态胶囊跑完一轮后仍完好', alive.statusText === 'idle' && /^pill /.test(alive.pillClass || ''), `${alive.statusText} / ${alive.pillClass}`);
  okCheck('顶栏与会话标题未被破坏', Boolean(alive.sessionTitle) && alive.sessionTitle !== '新会话', alive.sessionTitle);
  okCheck('输入区与 Trace 标签都在', alive.composer && alive.send && alive.traceTab);

  // 布局体检：不靠肉眼，直接量 bounding box，抓溢出/重叠/塌陷
  const layout = JSON.parse(
    await evalJs(`(() => {
      const box = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const vw = innerWidth, vh = innerHeight;
      const overflowing = [...document.querySelectorAll('.msg .bubble, .tool, .topbar, .composer, button')]
        .filter((n) => n.getBoundingClientRect().right > vw + 1 || n.getBoundingClientRect().left < -1)
        .map((n) => n.className + ':' + Math.round(n.getBoundingClientRect().right));
      return JSON.stringify({
        vw, vh,
        topbar: box('.topbar'), composer: box('.composer'), messages: box('.messages'),
        tool: box('.tool'), approvalBtn: box('.approval button.ok'),
        overflowing,
        scrollW: document.documentElement.scrollWidth,
      });
    })()`),
  );
  console.log(`  布局: 视口 ${layout.vw}x${layout.vh} / 顶栏 h=${layout.topbar?.h} / 输入区 bottom=${layout.composer?.bottom} / 工具卡 ${layout.tool?.w}x${layout.tool?.h}`);
  const layoutIssues = [];
  if (!layout.topbar || layout.topbar.h < 20) layoutIssues.push('顶栏塌陷');
  if (!layout.composer || layout.composer.bottom > layout.vh + 1) layoutIssues.push('输入区跑出视口');
  if (!layout.messages || layout.messages.h < 100) layoutIssues.push('消息区高度异常');
  if (!layout.tool || layout.tool.w < 200) layoutIssues.push('工具卡片宽度异常');
  if (layout.overflowing.length) layoutIssues.push(`水平溢出: ${layout.overflowing.join(', ')}`);
  if (layout.scrollW > layout.vw + 1) layoutIssues.push(`页面出现横向滚动 (${layout.scrollW} > ${layout.vw})`);
  if (layoutIssues.length) {
    console.log(`  ✗ 布局问题: ${layoutIssues.join(' | ')}`);
    failed = true;
  } else {
    console.log('  ✓ 布局体检通过：无横向溢出 / 无塌陷');
  }

  // 右侧面板：只剩 状态 + Trace，两个都要有内容
  for (const tab of ['status', 'trace']) {
    await evalJs(`document.querySelector('.tab[data-tab="${tab}"]').click(); true`);
    await sleep(600);
    const text = await evalJs(`document.querySelector('#pane-${tab}').innerText.trim()`);
    const line = text.split('\n').filter(Boolean)[0] || '';
    console.log(`  面板 ${tab.padEnd(8)} ${text.length} 字符 · ${line.slice(0, 46)}`);
    if (text.length < 5) {
      console.log(`  ✗ 面板 ${tab} 是空的`);
      failed = true;
    }
  }
  await evalJs(`document.querySelector('.tab[data-tab="trace"]').click(); true`);
  await sleep(400);
  const panelShot = await shot('ui-panel-trace.png');
  console.log(`  ✓ 面板截图 → ${panelShot}`);

  // 深色主题单独验一遍（CSS 有两套配色，必须都看）
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId);
  await sleep(300);
  const darkShot = await shot('ui-done-dark.png');
  const theme = JSON.parse(
    await evalJs(`JSON.stringify({
      body: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      bubble: getComputedStyle(document.querySelector('.msg.assistant .bubble')).backgroundColor,
    })`),
  );
  const lum = (rgb) => {
    const [r, g, b] = (rgb.match(/\d+/g) || [255, 255, 255]).slice(0, 3).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const diff = Math.abs(lum(theme.body) - lum(theme.text));
  console.log(`  深色主题: body=${theme.body} text=${theme.text} → ${darkShot}`);
  if (lum(theme.body) > 128) {
    console.log('  ✗ 深色主题未生效（body 仍是浅色）');
    failed = true;
  } else if (diff < 100) {
    console.log(`  ✗ 深色主题对比度不足（亮度差 ${Math.round(diff)}）`);
    failed = true;
  } else {
    console.log(`  ✓ 深色主题生效，文字/背景亮度差 ${Math.round(diff)}`);
  }

  const report = await evalJs(`JSON.stringify({
    meta: document.getElementById('meta').textContent,
    user: [...document.querySelectorAll('.msg.user .bubble')].map(n => n.textContent),
    assistant: [...document.querySelectorAll('.msg.assistant .bubble')].map(n => n.textContent),
    tools: [...document.querySelectorAll('.tool')].map(n => ({
      name: n.querySelector('.tool-name')?.textContent,
      cls: n.className,
      result: n.querySelector('details summary')?.textContent,
    })),
    error: [...document.querySelectorAll('.msg.error .bubble')].map(n => n.textContent),
  })`);
  const r = JSON.parse(report);

  console.log(`✓ 本轮结束 → ${doneShot}`);
  console.log(`  meta      : ${r.meta}`);
  console.log(`  用户消息  : ${r.user.length} 条`);
  console.log(`  助手回复  : ${r.assistant.length} 条，最后一条 ${r.assistant.at(-1)?.length ?? 0} 字符`);
  console.log(`  工具卡片  : ${JSON.stringify(r.tools)}`);
  if (r.error.length) {
    console.log(`  ✗ 页面错误: ${r.error.join(' | ')}`);
    failed = true;
  }
  if (r.assistant.length === 0) {
    console.log('  ✗ 没有渲染出助手回复');
    failed = true;
  }
  if (r.tools.length === 0) {
    console.log('  ✗ 没有渲染出工具卡片');
    failed = true;
  }
} catch (err) {
  console.error(`✗ ui-check 失败: ${err.message}`);
  failed = true;
} finally {
  page.close();
}

console.log(failed ? '\n✗ UI 检查未通过' : '\n✓ UI 检查通过：流式渲染 + 工具卡片 + 审批按钮 全链路正常');
process.exit(failed ? 1 : 0);
