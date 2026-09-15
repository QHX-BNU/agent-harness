// 工具注册表：把「模型看到的 schema」「真正执行的函数」「策略判定」绑在一起。
// 想加工具：写一个 {name, description, category, readOnly, parameters, run(args, ctx)}，
// 然后加进 BUILTIN（或在运行时用 register() 注册自定义工具）。
import { fsTools } from './fs.js';
import { shellTools } from './shell.js';
import { memoryTools } from './memory.js';
import { planTools } from './plan.js';
import { agentTools } from './agent.js';
import { workflowTools } from './workflow.js';
import { artifactTools } from './artifact.js';
import { digestTools } from './digest.js';

export const BUILTIN = [
  ...fsTools,
  ...shellTools,
  ...memoryTools,
  ...planTools,
  ...digestTools,
  ...agentTools,
  ...workflowTools,
  ...artifactTools,
];

export function createToolRegistry({ tools = BUILTIN, disabled = [] } = {}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const disabledSet = new Set(disabled);

  return {
    /** 发给模型的 tools 参数（只含启用的） */
    get specs() {
      return this.enabled.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    },

    get all() {
      return [...byName.values()];
    },

    get enabled() {
      return [...byName.values()].filter((t) => !disabledSet.has(t.name));
    },

    get(name) {
      const t = byName.get(name);
      return t && !disabledSet.has(name) ? t : null;
    },

    isEnabled(name) {
      return byName.has(name) && !disabledSet.has(name);
    },

    setEnabled(name, enabled) {
      if (!byName.has(name)) throw new Error(`未知工具：${name}`);
      enabled ? disabledSet.delete(name) : disabledSet.add(name);
      return this.isEnabled(name);
    },

    register(tool) {
      if (!tool?.name || typeof tool.run !== 'function') throw new Error('工具必须包含 name 与 run()');
      byName.set(tool.name, { category: 'custom', readOnly: false, ...tool });
      return tool.name;
    },

    /** 给 UI 用的清单 */
    describe() {
      return [...byName.values()].map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category || 'other',
        readOnly: Boolean(t.readOnly),
        enabled: !disabledSet.has(t.name),
        params: Object.keys(t.parameters?.properties || {}),
      }));
    },

    byCategory() {
      return this.describe().reduce((acc, t) => {
        (acc[t.category] = acc[t.category] || []).push(t);
        return acc;
      }, {});
    },

    /**
     * 统一入口：执行 + 错误归一化（永远返回 {ok, content}，不抛给上层）
     * @param {string} name
     * @param {object} args
     * @param {object} ctx { session, store, memory, agents, workflows, emit, signal, config, depth }
     */
    async execute(name, args, ctx = {}) {
      const tool = byName.get(name);
      if (!tool) return { ok: false, content: `未知工具：${name}` };
      if (disabledSet.has(name)) return { ok: false, content: `工具 ${name} 已被禁用` };
      try {
        const content = await tool.run(args ?? {}, ctx);
        return { ok: true, content: String(content) };
      } catch (err) {
        return { ok: false, content: `工具执行失败：${err.message}` };
      }
    },
  };
}
