// relay server <-> agent 的隧道帧协议。
//
// 帧格式（WebSocket 二进制帧）：
//   byte 0      : type
//   byte 1..8   : 8 位 ASCII 请求 id（十六进制）
//   byte 9..    : payload
//
// 每条 HTTP 请求 / WebSocket 隧道占用一个 id，同一连接上并发多路复用。

export const T = {
  REQ_HEAD: 1, // JSON { method, url, headers, target }
  REQ_BODY: 2, // 二进制请求体分片
  REQ_END: 3, // 请求体结束
  REQ_PAUSE: 4, // 浏览器侧写不动了，暂停目标响应
  REQ_RESUME: 5,
  REQ_CANCEL: 6, // 浏览器断开或超时，中止目标请求

  RESP_HEAD: 10, // JSON { status, statusText, headers, targetOrigin }
  RESP_BODY: 11,
  RESP_END: 12,
  RESP_ERROR: 13, // JSON { message, code }

  WS_OPEN: 20, // JSON { url, headers, protocols }
  WS_OPEN_OK: 21, // JSON { protocol }
  WS_OPEN_ERR: 22, // JSON { message }
  WS_DATA: 23, // 双向数据
  WS_CLOSE: 24, // JSON { code, reason }
};

const HEADER_LEN = 9;

export function newId() {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

export function encode(type, id, payload) {
  const body = payload === undefined || payload === null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const buf = Buffer.allocUnsafe(HEADER_LEN + body.length);
  buf.writeUInt8(type, 0);
  buf.write(id.slice(0, 8).padEnd(8, '0'), 1, 8, 'ascii');
  body.copy(buf, HEADER_LEN);
  return buf;
}

export function decode(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < HEADER_LEN) return null;
  return {
    type: buf.readUInt8(0),
    id: buf.toString('ascii', 1, 9),
    payload: buf.subarray(HEADER_LEN),
  };
}

export function jsonPayload(frame) {
  try {
    return JSON.parse(frame.payload.toString('utf8'));
  } catch {
    return null;
  }
}

// ---------- WS close 帧合法性 ----------
// close 帧只能携带 1000-4999 的状态码，且 1005/1006/1015 是保留码、不允许出现在线上。
// 浏览器/目标站关闭连接时经常不带状态码（对端看到的就是 1005），如果原样转发，
// 收到的一端（ws 库）会直接抛 "invalid status code" 错误。
export function sanitizeCloseCode(code) {
  const n = Number(code);
  if (!Number.isInteger(n)) return 1000;
  if (n === 1005 || n === 1006 || n === 1015) return 1000;
  if (n < 1000 || n > 4999) return 1000;
  return n;
}

// close 帧 payload 上限 125 字节（含 2 字节状态码），reason 超过就会让发送方抛异常
export function sanitizeCloseReason(reason, maxBytes = 123) {
  const s = typeof reason === 'string' ? reason : '';
  if (Buffer.byteLength(s) <= maxBytes) return s;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}
