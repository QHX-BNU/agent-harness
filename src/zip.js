// 零依赖 ZIP 读写。
//
// 为什么自己写：项目对外的承诺是「下载即用、零 npm 依赖」，技能包又只需要
// 「解压别人给的 zip / 自己打的 zip」这两件事。Node 自带 zlib（inflateRawSync），
// 缺的只是 ZIP 容器本身——local header / central directory / EOCD，几十行就够。
//
// 支持：store（0）与 deflate（8）两种压缩方式；UTF-8 文件名；目录条目。
// 不支持：ZIP64（>4GB）、加密、数据描述符（带 bit3 的条目仍能读，尺寸以 central directory 为准）。
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 找到 EOCD（从尾部往前扫，正常 zip 不会超过 64KB 注释） */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 读取 zip。
 * @param {Buffer} buffer
 * @returns {Array<{name:string, data:Buffer, dir:boolean, isSymlink:boolean, crc:number}>}
 */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || total === 0xffff) throw new Error('不支持 ZIP64 格式的压缩包');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`zip central directory 在第 ${i + 1} 条记录处损坏`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'utf8');
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`zip 条目 ${name} 的 local header 损坏`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`zip 条目 ${name} 用了不支持的压缩方式 ${method}`);

    // 外部属性高 16 位是 Unix mode：0xA000 = 符号链接
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    entries.push({
      name,
      data,
      dir: name.endsWith('/'),
      isSymlink: (unixMode & 0xf000) === 0xa000,
      crc,
      size: rawSize,
      mtime: dosTimeToDate(buf.readUInt16LE(p + 12), buf.readUInt16LE(p + 14)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function dosTimeToDate(date, time) {
  try {
    const year = 1980 + ((date >> 9) & 0x7f);
    const month = ((date >> 5) & 0x0f) - 1;
    const day = date & 0x1f;
    const hours = (time >> 11) & 0x1f;
    const minutes = (time >> 5) & 0x3f;
    const seconds = (time & 0x1f) * 2;
    return new Date(year, month, day, hours, minutes, seconds).getTime();
  } catch {
    return Date.now();
  }
}

function toDos(date = new Date()) {
  const d = new Date(date);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

/**
 * 打包 zip（store，不压缩：技能包都是文本，几十 KB，省一个 deflate 依赖面）。
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @param {object} [opts]
 * @param {Date|number} [opts.mtime]
 * @returns {Buffer}
 */
export function writeZip(entries, { mtime = new Date() } = {}) {
  const { time, date } = toDos(mtime);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = String(entry.name).replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.includes('..')) throw new Error(`非法 zip 条目名：${entry.name}`);
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = entry.dir ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, raw);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.dir ? 0x41ed0010 : 0x81a40000, 38); // 目录/普通文件
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + raw.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}
