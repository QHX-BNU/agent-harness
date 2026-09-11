// 共享的浏览器驱动（Chrome DevTools Protocol，零依赖：Node 24 自带 WebSocket）。
// 给 ui-check.js / ui-key-test.js 这类前端测试用：开页面、求值、等待、截图。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 30000);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function findChromeWs(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 未启动或没有开放 CDP 端口');
}

/**
 * 启动 headless Chrome 并打开一个页面。
 * @returns {Promise<{cdp, sessionId, evalJs, waitFor, shot, sleep, close}>}
 */
export async function openPage(url, { port = 9333, outDir = 'docs', width = 1280, height = 900, freshProfile = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const profile = path.join(os.tmpdir(), `chrome-harness-${port}${freshProfile ? `-${Date.now()}` : ''}`);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  let cdp;
  try {
    cdp = new CDP(await findChromeWs(port));
    await cdp.open();
  } catch (err) {
    chrome.kill();
    throw err;
  }

  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`页面报错: ${r.exceptionDetails.text}`);
    return r.result.value;
  };

  const waitFor = async (expr, label, timeoutMs = 20000) => {
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await evalJs(expr)) return true;
      } catch (err) {
        lastErr = err; // 页面还没加载完时求值会抛错，继续等
      }
      await sleep(150);
    }
    throw new Error(`等待超时: ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
  };

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  };

  return {
    cdp,
    sessionId,
    evalJs,
    waitFor,
    shot,
    sleep,
    close() {
      cdp.close();
      chrome.kill();
    },
  };
}
