// 产物工具：超长工具结果会被落盘，模型可以按需分段读回来。
export const readArtifact = {
  name: 'read_artifact',
  description: '读取一个被落盘的产物文件（超长工具输出会自动落盘并给出路径）。',
  category: 'artifact',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '产物文件路径（由工具结果里给出）' },
      offset: { type: 'integer', description: '起始行，默认 1' },
      limit: { type: 'integer', description: '最多行数，默认 200' },
    },
    required: ['file'],
  },
  async run({ file, offset = 1, limit = 200 }, ctx) {
    const text = ctx.store.readArtifact(file);
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Number(offset) || 1);
    const slice = lines.slice(start - 1, start - 1 + (Number(limit) || 200));
    return (
      `产物 ${file}（共 ${lines.length} 行，显示 ${start}~${start + slice.length - 1}）：\n` +
      slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n')
    );
  },
};

export const artifactTools = [readArtifact];
