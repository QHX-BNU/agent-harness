// 运行时模型配置：把网页设置里的供应商/模型/key 交给服务端进程使用。
//
// 为什么需要它：飞书机器人之类没有浏览器的入口（channel）拿不到用户在前端填的 key。
// 这个模块只存在内存里 —— 进程重启就没了，绝不落盘，和「key 不写服务端文件」的约定一致。
let runtime = null;

export function setRuntimeModel(cfg) {
  if (!cfg) {
    runtime = null;
    return null;
  }
  runtime = {
    provider: cfg.provider || undefined,
    model: cfg.model || undefined,
    baseUrl: cfg.baseUrl || undefined,
    apiKey: cfg.apiKey || undefined,
    updatedAt: Date.now(),
  };
  return runtime;
}

export function getRuntimeModel() {
  return runtime;
}

/** 给接口返回用：不泄露 key */
export function describeRuntimeModel() {
  if (!runtime) return { set: false };
  return {
    set: true,
    provider: runtime.provider,
    model: runtime.model,
    baseUrl: runtime.baseUrl,
    hasApiKey: Boolean(runtime.apiKey),
    updatedAt: runtime.updatedAt,
  };
}
