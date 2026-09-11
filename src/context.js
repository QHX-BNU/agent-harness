// 上下文层：每轮真正发给模型的东西在这里拼出来。
// 这是 harness 最容易被低估的部分——预算管理、记忆注入、系统提示共同决定上限。
import { config } from './config.js';

export function buildSystemPrompt({ workspace, tools, approvalMode, model, memoryText = '', todos = [], skills = [] }) {
  const byCat = tools.reduce((acc, t) => {
    (acc[t.category || 'other'] = acc[t.category || 'other'] || []).push(t);
    return acc;
  }, {});
  const toolList = Object.entries(byCat)
    .map(
      ([cat, list]) =>
        `### ${cat}\n` +
        list.map((t) => `- ${t.name}${t.readOnly ? ' (只读)' : ''}: ${t.description}`).join('\n'),
    )
    .join('\n');

  const sections = [
    `你是一个运行在 mini-harness 里的编码 agent。

## 环境
- 工作区根目录: ${workspace}
- 模型: ${model}
- 审批策略: ${approvalMode}（写文件 / 执行命令可能需要用户确认）
- 当前时间: ${new Date().toISOString()}`,

    `## 可用工具
${toolList}`,
  ];

  if (memoryText) {
    sections.push(`## 相关长期记忆（自动召回，按需使用，不要照抄）
${memoryText}`);
  }

  if (todos?.length) {
    const icon = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
    sections.push(
      `## 当前任务清单
${todos.map((t) => `${icon[t.status] || '[ ]'} ${t.content}`).join('\n')}
（用 todo_write 更新；每完成一步就更新一次）`,
    );
  }

  if (skills?.length) {
    sections.push(`## 可用技能\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`);
  }

  sections.push(`## 规则
1. 需要读取事实（文件内容、目录结构、命令输出）时必须调用工具，不要凭空猜测。
2. 所有文件路径都相对于工作区根目录；越界访问会被拒绝。
3. 一次只做能验证的一小步，拿到工具结果后再决定下一步。
4. 工具失败（exit code ≠ 0 / 报错）时先读错误信息，再决定重试还是换方案，不要原样重试。
5. 多步任务先用 todo_write 列清单，边做边更新。
6. 只把「以后还用得上的事实或偏好」写进 memory_add；流水账不要记。
7. 独立且耗时长的子任务用 task 委派给子代理；需要多阶段流程时用 run_workflow。
8. 回答用中文，简洁直接，不要复述工具输出的全部内容。`);

  return sections.join('\n\n');
}

const size = (m) => JSON.stringify(m).length;

/**
 * 按字符预算裁剪历史：从最老的完整 turn 开始丢。
 * 不破坏 assistant(tool_calls) 与 tool 结果的配对关系。
 */
export function trimHistory(messages, maxChars = config.maxHistoryChars) {
  let out = messages.slice();
  let total = out.reduce((a, m) => a + size(m), 0);
  while (total > maxChars && out.length > 1) {
    const firstUser = out.findIndex((m) => m.role === 'user');
    if (firstUser === -1) break;
    const nextUser = out.findIndex((m, i) => i > firstUser && m.role === 'user');
    if (nextUser === -1) break; // 只剩最后一个 turn，不能再丢
    total -= out.slice(0, nextUser).reduce((a, m) => a + size(m), 0);
    out = out.slice(nextUser);
  }
  return out;
}

/**
 * 工具结果超长时落盘，上下文里只留头尾 + 文件路径（真实 harness 的做法）。
 * @returns {{content:string, artifact:string|null}}
 */
export function spillToolResult({ store, sessionId, toolName, content, maxChars = config.toolResultMaxChars }) {
  const s = String(content ?? '');
  if (s.length <= maxChars) return { content: s, artifact: null };

  const head = s.slice(0, Math.floor(maxChars * 0.6));
  const tail = s.slice(-Math.floor(maxChars * 0.25));
  let artifact = null;
  try {
    artifact = store.artifact(sessionId, `${toolName}.txt`, s);
  } catch {
    /* 落盘失败就退化成纯截断 */
  }
  return {
    artifact,
    content:
      `${head}\n\n… [输出过长已截断：共 ${s.length} 字符]` +
      (artifact ? `\n完整内容已存为产物：${artifact}\n用 read_artifact(file="...") 分段读取。` : '') +
      `\n\n… [尾部片段]\n${tail}`,
  };
}
