// 执行类工具：能跑任意命令，所以它是沙箱与策略层重点盯的对象。
// 沙箱在这里做三件事：cwd 必须在作用区域内、命令里不能出现区域外路径、环境变量被清洗。
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { safeResolve, rootOf } from './fs.js';
import { utf8Prelude } from '../sandbox.js';

const isWin = process.platform === 'win32';

/**
 * 解码子进程输出：优先 UTF-8；出现替换字符说明其实是本地代码页（中文 Windows = GBK），再退回 GBK。
 * Node 官方构建带 full-icu，所以 TextDecoder('gbk') 可用。
 */
function decodeChunk(buf) {
  const asUtf8 = buf.toString('utf8');
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return asUtf8;
  }
}

export const runShell = {
  name: 'run_shell',
  description: '在工作区内执行一条 shell 命令，返回 exit code 与 stdout/stderr。',
  category: 'shell',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      workdir: { type: 'string', description: '相对工作区的执行目录，默认 "."' },
    },
    required: ['command'],
  },
  async run({ command, workdir = '.' }, ctx) {
    const sandbox = ctx?.sandbox;

    // 1) 工作目录必须在作用区域内
    const cwd = sandbox
      ? sandbox.resolve(workdir, { tool: 'run_shell' })
      : safeResolve(workdir, rootOf(ctx));

    // 2) 命令扫描：拦住「用命令绕出作用区域」，以及网络策略不允许的联网命令
    if (sandbox) {
      const check = sandbox.checkCommand(command, { cwd, tool: 'run_shell' });
      if (!check.ok) return `沙箱拒绝执行：${check.reason}`;
      // 网络策略要走本地代理，等它绑定端口（非 all 模式才有）
      await sandbox.ready?.();
    }

    // 3) 构造真正要跑的东西（本地 / docker / wsl），并带上清洗过的环境变量
    const spec = sandbox
      ? sandbox.buildExec(command, { cwd, tool: 'run_shell' })
      : isWin
        ? {
            file: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-Command', utf8Prelude(command)],
            cwd,
            env: process.env,
            backend: 'none',
          }
        : { file: '/bin/sh', args: ['-c', command], cwd, env: process.env, backend: 'none' };

    const started = Date.now();
    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn(spec.file, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        // Node 权限模型（真隔离模式）会直接拒绝派生进程
        if (err.code === 'ERR_ACCESS_DENIED') {
          return resolve(
            '沙箱拒绝执行：当前运行在真隔离模式（Node 权限模型），**不允许派生进程**，shell 工具被运行时禁用。\n' +
              '  要跑命令：用 --allow-shell 启动 jail（注意子进程不受权限模型约束、隔离会降级），' +
              '或改用 docker / wsl 沙箱后端；文件读写仍然受权限模型强制约束。',
          );
        }
        return resolve(`命令启动失败：${err.message}`);
      }

      let stdout = '';
      let stderr = '';
      const cap = 200_000;
      child.stdout.on('data', (d) => {
        if (stdout.length < cap) stdout += decodeChunk(d);
      });
      child.stderr.on('data', (d) => {
        if (stderr.length < cap) stderr += decodeChunk(d);
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        stderr += `\n[超时 ${config.shellTimeoutMs}ms，进程已终止]`;
      }, config.shellTimeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        if (err.code === 'ERR_ACCESS_DENIED' || /permission/i.test(err.message)) {
          return resolve('沙箱拒绝执行：真隔离模式（Node 权限模型）不允许派生进程。用 --allow-shell 启动 jail，或改用 docker / wsl 后端。');
        }
        resolve(`命令启动失败：${err.message}`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        resolve(
          [
            `exit code: ${code}  (${ms}ms${spec.backend !== 'local' ? `, 沙箱后端 ${spec.backend}` : ''})`,
            stdout.trim() ? `--- stdout ---\n${stdout.trim()}` : '',
            stderr.trim() ? `--- stderr ---\n${stderr.trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      });
    });
  },
};

export const shellTools = [runShell];
