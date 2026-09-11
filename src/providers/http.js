// 共享 HTTP 层：所有适配器都走这里，保证超时/重试/错误格式一致。
// 这是「端口」能稳定工作的地基——不同厂商的 429/5xx/网络抖动都要在这里被吸收掉。

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

export class ModelError extends Error {
  constructor(message, { status = 0, retryable = false, body = '', provider = '', model = '' } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
    this.provider = provider;
    this.model = model;
  }

  /** 给用户看的人话建议 */
  get hint() {
    if (this.status === 401 || this.status === 403) return 'API key 无效或没有该模型的权限，检查环境变量里的 key';
    if (this.status === 404) return '端点或模型名不存在，检查 BASE_URL 和 MODEL';
    if (this.status === 402) return '账户余额不足';
    if (this.status === 429) return '触发限流，已重试仍然失败，稍后再试或换模型';
    if (this.status >= 500) return '对方服务异常，稍后重试';
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(this.message)) {
      return '连不上端点：检查 BASE_URL、网络或代理设置';
    }
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把两个 signal 合成一个（用户取消 + 超时） */
function combineSignals(userSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
}

/**
 * POST 一个 JSON 请求，带指数退避重试。
 * 只在「还没开始读流」时重试，保证不会重复消费半截输出。
 * @returns {Promise<Response>}
 */
export async function postJSON(url, { headers, body, signal, timeoutMs = 120000, retries = 2, onRetry, provider = '', model = '' }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.random() * 250;
      onRetry?.({ attempt, waitMs: Math.round(wait), reason: lastErr?.message || 'unknown' });
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combineSignals(signal, timeoutMs),
      });
      if (res.ok) return res;

      const text = (await res.text()).slice(0, 800);
      const retryable = RETRYABLE_STATUS.has(res.status);
      const retryAfter = Number(res.headers.get('retry-after'));
      lastErr = new ModelError(`${provider} 返回 ${res.status}: ${text}`, {
        status: res.status,
        retryable,
        body: text,
        provider,
        model,
      });
      if (!retryable || attempt === retries) throw lastErr;
      if (retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 15000));
    } catch (err) {
      if (err instanceof ModelError) {
        if (!err.retryable || attempt === retries) throw err;
        continue;
      }
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        // 用户主动取消 → 直接抛出；超时 → 可重试
        if (signal?.aborted) throw err;
        lastErr = new ModelError(`请求超时（${timeoutMs}ms）`, { retryable: true, provider, model });
        if (attempt === retries) throw lastErr;
        continue;
      }
      lastErr = new ModelError(`网络错误: ${err.message}`, { retryable: true, provider, model });
      if (attempt === retries) throw lastErr;
    }
  }
  throw lastErr;
}

/**
 * 逐行产出 SSE 数据行（自动处理 `data:` / `event:` 前缀与跨 chunk 的半行）。
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
export async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventName = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);

        if (line === '') {
          eventName = '';
          continue;
        }
        if (line.startsWith(':')) continue; // 心跳注释
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          yield { event: eventName, data: line.slice(5).trim() };
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
