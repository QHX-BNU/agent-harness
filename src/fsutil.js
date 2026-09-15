// 文件系统小工具。
//
// ensureDir 存在的理由（实测踩到的坑）：
// Node 权限模型（--permission）下，对**已存在**的目录调用 mkdirSync(recursive:true)
// 在某些白名单组合里会被判成越权 —— 哪怕那个目录就在写白名单里，往里写文件明明也可以。
// 目录已经存在时根本不需要 mkdir，跳过它既能绕开这个判定，也少一次系统调用。
import fs from 'node:fs';

export function ensureDir(dir) {
  try {
    if (fs.existsSync(dir)) return dir;
  } catch {
    /* 连 existsSync 都被拒时会抛 ERR_ACCESS_DENIED，交给下面处理 */
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code === 'EEXIST') return dir;
    // 权限模型判定越权，但目录其实已经存在 —— 能用就行
    if (err.code === 'ERR_ACCESS_DENIED') {
      try {
        if (fs.existsSync(dir)) return dir;
      } catch {
        /* 忽略 */
      }
    }
    throw err;
  }
  return dir;
}
