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
    this.data = { users: {}, chats: {} };
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data.users = raw.users || {};
        this.data.chats = raw.chats || {};
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

  /** 查姓名：查不到或存的是 id 就返回 null（调用方自己决定回退） */
  name(openId) {
    const hit = this.data.users[openId];
    const n = typeof hit === 'string' ? hit : hit?.name;
    return n && !looksLikeId(n) ? n : null;
  }

  setUser(openId, name) {
    if (!openId || !name || looksLikeId(name)) return null;
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
    return {
      users: Object.entries(this.data.users).map(([id, v]) => ({ id, name: typeof v === 'string' ? v : v.name })),
      chats: Object.entries(this.data.chats).map(([id, v]) => ({ id, name: typeof v === 'string' ? v : v.name })),
    };
  }
}

/** 从任意路径推导身份缓存文件（默认和通道状态放一起） */
export function defaultIdentityFile(sessionsDir = '.sessions') {
  return path.resolve(sessionsDir, '..', '.channels', 'identities.json');
}
