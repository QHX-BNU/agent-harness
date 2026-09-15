// 运行时模型配置：把网页设置里的供应商/模型/key 交给服务端进程使用。
//
// 为什么需要它：飞书机器人之类没有浏览器的入口（channel）拿不到用户在前端填的 key。
// 默认**只存内存**——进程重启就没了，和「key 不写服务端文件」的约定一致。
// 想让它活过重启：用 RUNTIME_MODEL_PERSIST=1 启动，会落到 .runtime-model.json（已在 .gitignore）。
import fs from 'node:fs';
import path from 'node:path';

const PERSIST = process.env.RUNTIME_MODEL_PERSIST === '1';
const FILE = path.resolve(process.env.RUNTIME_MODEL_FILE || '.runtime-model.json');

let runtime = null;

function load() {
  if (runtime || !PERSIST || !fs.existsSync(FILE)) return runtime;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data && (data.provider || data.apiKey)) {
      runtime = { ...data, restored: true };
      console.log(`  运行时模型 = 已从 ${FILE} 恢复（${runtime.provider || '?'} · ${runtime.model || '?'}）`);
    }
  } catch {
    /* 坏文件忽略 */
  }
  return runtime;
}

function persistTo(file) {
  if (!PERSIST) return;
  try {
    if (!runtime) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.writeFileSync(file, JSON.stringify(runtime, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

export function setRuntimeModel(cfg) {
  if (!cfg) {
    runtime = null;
    persistTo(FILE);
    return null;
  }
  runtime = {
    provider: cfg.provider || undefined,
    model: cfg.model || undefined,
    baseUrl: cfg.baseUrl || undefined,
    apiKey: cfg.apiKey || undefined,
    updatedAt: Date.now(),
  };
  persistTo(FILE);
  return runtime;
}

export function getRuntimeModel() {
  return load();
}

/** 给接口返回用：不泄露 key */
export function describeRuntimeModel() {
  const r = load();
  if (!r) return { set: false, persist: PERSIST };
  return {
    set: true,
    provider: r.provider,
    model: r.model,
    baseUrl: r.baseUrl,
    hasApiKey: Boolean(r.apiKey),
    updatedAt: r.updatedAt,
    restored: Boolean(r.restored),
    persist: PERSIST,
  };
}
