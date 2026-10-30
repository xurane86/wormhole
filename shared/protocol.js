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
