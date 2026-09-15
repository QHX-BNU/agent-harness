// 身份缓存：open_id → 真实姓名，chat_id → 真实群名。
//
// 为什么需要单独一份：飞书的事件里只有 open_id，不给名字。姓名要靠「群成员列表」查一次，
// 查完得存下来——通道、digest 工具、历史会话回填都要用同一份，
// 否则就会出现「消息里显示 ou_xxx 而不是真名」这种问题。
import fs from 'node:fs';
import path from 'node:path';

export const looksLikeId = (s) => /^(ou_|on_|oc_|om_|cli_)/i.test(String(s || ''));

export class IdentityStore {
  constructor({ file }) {
    this.file = file;
    this.data = { users: {}, chats: {}, aliases: {}, orgNames: {} };
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data.users = raw.users || {};
        this.data.chats = raw.chats || {};
        this.data.aliases = raw.aliases || {};
        this.data.orgNames = raw.orgNames || {};
      } catch {
        /* 坏文件当空 */
      }
    }
  }

  #persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }

  /**
   * 查姓名，优先级：人工别名 > 组织通讯录真名 > 群内显示名。
   * 群内显示名经常是「用户138576」这种没设过名字的占位，而通讯录里是真名，
   * 所以一旦拿到组织名，就不该被后来的群成员列表覆盖。
   */
  name(openId) {
    const alias = this.data.aliases?.[openId];
    if (alias) return alias;
    const org = this.data.orgNames?.[openId]?.name;
    if (org) return org;
    const hit = this.data.users[openId];
    const n = typeof hit === 'string' ? hit : hit?.name;
    return n && !looksLikeId(n) ? n : null;
  }

  /**
   * 人工别名：优先级最高。
   * 飞书返回的可能是「用户138576」这种没设过名字的显示名，而组织通讯录里是真名——
   * 组织名靠 contact 接口拿，拿不到的可以在这里钉死。
   */
  setAlias(openId, name) {
    if (!openId) return null;
    this.data.aliases = this.data.aliases || {};
    if (!name) {
      delete this.data.aliases[openId];
    } else {
      this.data.aliases[openId] = String(name).trim();
    }
    this.#persist();
    return this.data.aliases[openId] || null;
  }

  /** 组织真名（来源：通讯录），与「群内显示名」区分开 */
  setOrgName(openId, name) {
    if (!openId || !name) return null;
    this.data.orgNames = this.data.orgNames || {};
    this.data.orgNames[openId] = { name: String(name).trim(), at: Date.now() };
    // 组织名优先于群显示名
    this.data.users[openId] = { name: String(name).trim(), at: Date.now() };
    this.#persist();
    return name;
  }

  /** 群内显示名：只在没有组织真名时生效，别把真名冲掉 */
  setUser(openId, name) {
    if (!openId || !name || looksLikeId(name)) return null;
    if (this.data.aliases?.[openId] || this.data.orgNames?.[openId]) {
      this.data.users[openId] = this.data.users[openId] || { name, at: Date.now() };
      this.#persist();
      return this.name(openId);
    }
    this.data.users[openId] = { name, at: Date.now() };
    this.#persist();
    return name;
  }

  setUsers(map) {
    let n = 0;
    for (const [id, name] of Object.entries(map || {})) if (this.setUser(id, name)) n++;
    if (n) this.#persist();
    return n;
  }

  chatName(chatId) {
    const hit = this.data.chats[chatId];
    return (typeof hit === 'string' ? hit : hit?.name) || null;
  }

  setChat(chatId, name) {
    if (!chatId || !name) return null;
    this.data.chats[chatId] = { name, at: Date.now() };
    this.#persist();
    return name;
  }

  list() {
    const ids = new Set([...Object.keys(this.data.users), ...Object.keys(this.data.aliases || {}), ...Object.keys(this.data.orgNames || {})]);
    return {
      users: [...ids].map((id) => ({
        id,
        name: this.name(id), // 生效的名字
        display: (typeof this.data.users[id] === 'string' ? this.data.users[id] : this.data.users[id]?.name) || null,
        alias: this.data.aliases?.[id] || null,
        org: this.data.orgNames?.[id]?.name || null,
      })),
      chats: Object.entries(this.data.chats).map(([id, v]) => ({ id, name: typeof v === 'string' ? v : v.name })),
    };
  }
}

/** 从任意路径推导身份缓存文件（默认和通道状态放一起） */
export function defaultIdentityFile(sessionsDir = '.sessions') {
  return path.resolve(sessionsDir, '..', '.channels', 'identities.json');
}
