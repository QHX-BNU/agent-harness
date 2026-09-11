// 策略层：每个工具调用都要先过这里。三种结果：allow / ask / deny。
// 审批是「异步等人」的，所以有一个 broker 把 HTTP 请求和挂起的工具调用接起来。
const DANGEROUS = [
  /\brm\s+-rf\s+\//i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]\b/i,
  /\bshutdown\b/i,
  /\bmkfs\b/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
];

export class ApprovalBroker {
  constructor(timeoutMs = 120000) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // id -> {resolve, timer, meta}
  }

  /** 注册一个待审批项，返回 Promise<boolean> */
  request(meta) {
    const id = meta.id;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false); // 超时视为拒绝
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer, meta });
    });
  }

  /** 前端点了允许/拒绝 */
  settle(id, approved) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(Boolean(approved));
    return true;
  }

  pendingList() {
    return [...this.pending.values()].map((p) => p.meta);
  }
}

export class Policy {
  /**
   * @param {'auto'|'ask'|'deny'} mode
   * @param {ApprovalBroker} broker
   */
  constructor(mode, broker) {
    this.mode = mode;
    this.broker = broker;
  }

  /**
   * 只做「静态判断」，不阻塞。
   * @returns {{action:'allow'|'ask'|'deny', reason:string}}
   */
  decide(tool, args) {
    // 1) 危险命令硬拦，任何模式下都不放行
    if (tool.name === 'run_shell') {
      const cmd = String(args.command || '');
      for (const re of DANGEROUS) {
        if (re.test(cmd)) return { action: 'deny', reason: `命中危险命令规则 ${re}` };
      }
    }
    // 2) 只读工具永远放行
    if (tool.readOnly) return { action: 'allow', reason: '只读工具' };
    // 3) 纯记账类（记忆 / 清单 / 读产物）没有外部副作用，放行
    if (['memory', 'plan'].includes(tool.category)) {
      return { action: 'allow', reason: '记账类工具，无外部副作用' };
    }
    // 4) 委派类（子代理 / 工作流）：审批一次「委派」本身，
    //    子代理内部按 auto 跑（它无人可问），所以这里是安全边界
    if (['agent', 'workflow'].includes(tool.category)) {
      if (this.mode === 'deny') return { action: 'deny', reason: '策略 deny：禁止委派子代理/工作流' };
      if (this.mode === 'auto') return { action: 'allow', reason: '策略 auto' };
      return { action: 'ask', reason: '委派子代理/工作流会自主执行工具，需要先确认' };
    }
    // 5) 其余（写文件 / 执行命令）按模式
    if (this.mode === 'auto') return { action: 'allow', reason: '策略 auto' };
    if (this.mode === 'deny') return { action: 'deny', reason: '策略 deny：写/执行类工具被禁用' };
    return { action: 'ask', reason: '写/执行类工具需要人工确认' };
  }

  /** 把 ask 变成一次真实的等待 */
  async requestApproval(meta) {
    return this.broker.request(meta);
  }
}
