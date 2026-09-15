// 假的 OpenAI / Anthropic 兼容服务 —— 用来在没有 API key 的情况下真实验证「模型接入端口」。
// 它按真实厂商的 SSE 格式逐块吐数据（含跨 chunk 拆开的 tool_calls JSON、429 限流），
// 因此适配器的解析、增量拼装、重试、错误归一化都能被真刀真枪地测到。
//
// 直接跑: node scripts/fake-llm.js [port]
// 作为模块: const fake = await startFakeLLM();
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(res, event, data) {
  res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

export function startFakeLLM({ port = 0, host = '127.0.0.1' } = {}) {
  const state = { requests: 0, throttled: 0, lastBody: null };

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    state.requests++;
    state.lastBody = body;
    const model = String(body.model || '');

    // ---- 鉴权（用来验证 401 的错误归一化与提示）----
    const isAnthropic = req.url.startsWith('/v1/messages');
    const auth = isAnthropic ? req.headers['x-api-key'] : (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'missing api key' } }));
    }

    // ---- 模型列表 ----
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fake-1' }, { id: 'fake-2' }, { id: 'fake-reasoner' }] }));
    }

    // ---- 限流场景：前两次 429，第三次成功（验证指数退避重试）----
    if (model.includes('fail-twice') && state.throttled < 2) {
      state.throttled++;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }

    // 已经拿到工具结果了 → 这一轮只输出文本（模拟模型的第二轮总结），避免无限调用
    // 两种协议的工具结果位置不同：OpenAI 是 role:'tool'，Anthropic 是 user 消息里的 tool_result block
    const hasToolResult = (body.messages || []).some(
      (m) => m.role === 'tool' || (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')),
    );
    const wantsTools =
      Array.isArray(body.tools) && body.tools.length > 0 && !model.includes('no-tools') && !hasToolResult;

    // 根据用户消息挑一个工具，让假模型也能驱动写文件/执行命令（触发审批流程）
    const lastUser = (body.messages || []).filter((m) => m.role === 'user').at(-1);
    const userText =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : (lastUser?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const fileMatch = userText.match(/([\w./-]+\.[a-zA-Z0-9]+)/);
    let toolName = 'list_dir';
    let toolArgs = { path: './src' };
    if (/(委派|子任务|subagent|\btask\b)/i.test(userText)) {
      // 触发子代理链路：假模型调用 task 工具，子代理再走一轮
      toolName = 'task';
      toolArgs = { description: '探查', prompt: '读一下 package.json 并总结' };
    } else if (/(写|创建|write|新建)/i.test(userText)) {
      toolName = 'write_file';
      toolArgs = { path: fileMatch ? fileMatch[1] : 'fake/out.txt', content: '由假模型写入\n' };
    } else if (/(运行|执行|命令|shell|run)/i.test(userText)) {
      toolName = 'run_shell';
      toolArgs = { command: 'node -v' };
    }

    // ================= Anthropic Messages API =================
    if (isAnthropic) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, 'message_start', {
        type: 'message_start',
        message: { model, usage: { input_tokens: 11, output_tokens: 0 } },
      });
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } });
      for (const piece of ['你好', '，我是', '假 Claude。']) {
        await sleep(10);
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: piece },
        });
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });

      if (wantsTools) {
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: toolName },
        });
        // input_json_delta 分片，验证跨 chunk 拼装
        const json = JSON.stringify(toolArgs);
        const cut = Math.ceil(json.length / 3);
        for (const piece of [json.slice(0, cut), json.slice(cut, cut * 2), json.slice(cut * 2)]) {
          if (!piece) continue;
          await sleep(10);
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: piece },
          });
        }
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 });
      }

      sse(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: wantsTools ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 23 },
      });
      sse(res, 'message_stop', { type: 'message_stop' });
      return res.end();
    }

    // ================= OpenAI Chat Completions =================
    const wantsStream = body.stream !== false;
    if (!wantsStream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          model,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'pong',
                ...(wantsTools
                  ? { tool_calls: [{ id: 'call_ping', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }
                  : {}),
              },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
      );
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model };
    const chunk = (delta, finish = null) =>
      sse(res, null, { ...base, choices: [{ index: 0, delta, finish_reason: finish }] });

    // 思维链（deepseek-reasoner 风格）
    if (model.includes('reasoner')) {
      for (const piece of ['让我想', '一下…']) {
        await sleep(10);
        chunk({ reasoning_content: piece });
      }
    }

    for (const piece of ['这是', '一段', '流式文本。']) {
      await sleep(10);
      chunk({ content: piece });
    }

    if (wantsTools) {
      // tool_calls 的 JSON 被拆到两个 chunk 里 —— 最容易写错的地方
      const json = JSON.stringify(toolArgs);
      const cut = Math.ceil(json.length / 2);
      chunk({
        tool_calls: [
          { index: 0, id: 'call_abc', type: 'function', function: { name: toolName, arguments: json.slice(0, cut) } },
        ],
      });
      await sleep(10);
      chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(cut) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({}, 'stop');
    }

    sse(res, null, { ...base, choices: [], usage: { prompt_tokens: 7, completion_tokens: 12 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        state,
        baseUrl: `http://${host}:${actual}/v1`,
        root: `http://${host}:${actual}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// CLI 模式
if (process.argv[1] && process.argv[1].endsWith('fake-llm.js')) {
  const fake = await startFakeLLM({ port: Number(process.argv[2] || 5199) });
  console.log(`假模型服务已启动: ${fake.root}`);
  console.log('  OpenAI 兼容 : POST /v1/chat/completions');
  console.log('  Anthropic   : POST /v1/messages');
  console.log('  模型列表    : GET  /v1/models');
  console.log('  任意 key 都行（但要带一个），模型名含 fail-twice 会先返回两次 429');
  console.log(`\n接上它:  $env:PROVIDER="custom"; $env:BASE_URL="${fake.baseUrl}"; $env:MODEL="fake-1"; $env:API_KEY="x"; node server.js`);
}
