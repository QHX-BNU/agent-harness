// 内部消息格式 → 各家协议格式。
// 内部格式（store 里存的就是这个）：
//   { role:'system'|'user'|'assistant'|'tool', content, toolCalls?:[{id,name,arguments}], toolCallId?, name? }
// 端口只认内部格式，厂商差异全部收敛在这个文件里。

/** OpenAI：assistant 的 tool_calls / tool 的 tool_call_id */
export function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Anthropic Messages API：
 * - system 是顶层字段，不在 messages 里
 * - assistant 的工具调用是 content block {type:'tool_use'}
 * - 工具结果必须以 user 消息里的 {type:'tool_result'} 出现，且要合并连续的 tool 消息
 */
export function toAnthropicPayload(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block); // 合并连续的多个工具结果
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      }
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }

    out.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
  }
  return { system, messages: out };
}

/** Anthropic 的工具 schema 字段叫 input_schema */
export const toAnthropicTools = (tools) =>
  tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
