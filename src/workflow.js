// 工作流引擎：把「多阶段 + 阶段内并行 + 结果按模板传递」编排起来。
// 工作流 = 一份 JSON 定义（workflows/*.json），每个 step 交给一个子代理执行，
// 阶段之间串行、阶段内部并行，上一步的结论用 {{steps.<label>}} 引用。
import fs from 'node:fs';
import path from 'node:path';

export function loadWorkflows(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        def.file = f;
        def.phases = def.phases || [];
        return def;
      } catch (err) {
        return { name: f.replace(/\.json$/, ''), description: `(定义解析失败: ${err.message})`, phases: [], file: f };
      }
    });
}

const render = (tpl, vars) =>
  String(tpl ?? '').replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    const v = key.split('.').reduce((o, p) => (o == null ? undefined : o[p]), vars);
    return v === undefined ? `{{${key}}}` : String(v);
  });

export function createWorkflowEngine({ dir, agents, config }) {
  return {
    list() {
      return loadWorkflows(dir).map((w) => ({
        name: w.name,
        description: w.description || '',
        phases: w.phases.map((p) => ({ title: p.title, steps: p.steps || [] })),
      }));
    },

    get(name) {
      return loadWorkflows(dir).find((w) => w.name === name || w.file === name) || null;
    },

    /**
     * 执行工作流
     * @param {string} name
     * @param {{input?:string, session:object, emit?:Function, signal?:AbortSignal,
     *          sandbox?:object, modelConfig?:object}} opts
     */
    async run(name, { input = '', session, emit, signal, sandbox = null, modelConfig = null } = {}) {
      const def = this.get(name);
      if (!def) throw new Error(`没有名为 "${name}" 的工作流（用 workflow_list 查看可用的）`);
      if (!agents) throw new Error('当前环境没有启用子代理，工作流无法运行');

      const t0 = Date.now();
      const vars = { input, prev: '', steps: {} };
      emit?.({ type: 'workflow_start', name: def.name, description: def.description, input, phases: def.phases.map((p) => p.title) });

      const phases = [];
      let totalSteps = 0;

      for (const [pi, phase] of def.phases.entries()) {
        if (signal?.aborted) throw new Error('已取消');
        const steps = phase.steps || [];
        emit?.({ type: 'workflow_phase', name: def.name, phase: phase.title, index: pi + 1, total: def.phases.length });

        // 阶段内并行
        const settled = await Promise.all(
          steps.map(async (step, si) => {
            const label = step.label || `step${pi + 1}-${si + 1}`;
            const prompt = render(step.prompt, vars);
            emit?.({ type: 'workflow_step_start', phase: phase.title, label, prompt: prompt.slice(0, 400) });
            try {
              const r = await agents.run({
                description: label,
                prompt,
                model: step.model,
                maxSteps: step.maxSteps || 6,
                parent: session,
                depth: 1,
                modelConfig,
                signal,
                emit,
                sandbox,
                onDelta: (d) => emit?.({ type: 'workflow_step_delta', label, ...d }),
              });
              emit?.({
                type: 'workflow_step_done',
                phase: phase.title,
                label,
                steps: r.steps,
                toolCalls: r.toolCalls,
                usage: r.usage,
                summary: r.summary.slice(0, 400),
              });
              return { label, ok: true, ...r };
            } catch (err) {
              emit?.({ type: 'workflow_step_done', phase: phase.title, label, ok: false, error: err.message });
              return { label, ok: false, summary: `(这一步失败: ${err.message})` };
            }
          }),
        );

        for (const r of settled) vars.steps[r.label] = r.summary;
        vars.prev = settled.map((r) => `### ${r.label}\n${r.summary}`).join('\n\n');
        totalSteps += settled.length;
        phases.push({ title: phase.title, steps: settled });
        emit?.({ type: 'workflow_phase_done', phase: phase.title });
      }

      const okCount = phases.reduce((a, p) => a + p.steps.filter((s) => s.ok).length, 0);
      const summary =
        `工作流「${def.name}」完成：${def.phases.length} 阶段 / ${okCount}/${totalSteps} 步成功，耗时 ${Date.now() - t0}ms\n\n` +
        vars.prev;

      emit?.({ type: 'workflow_done', name: def.name, phases: def.phases.length, steps: totalSteps, ok: okCount, ms: Date.now() - t0, summary: summary.slice(0, 600) });
      return { name: def.name, phases, summary };
    },
  };
}
