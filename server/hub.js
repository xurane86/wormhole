// Agent 连接表 + 隧道复用。
// 一个 agent 用一条 WebSocket 连入，后续所有 HTTP 请求 / WebSocket 隧道
// 都通过这条连接按 id 多路复用。
import { PassThrough } from 'node:stream';
import { T, encode, decode, jsonPayload, newId } from '../shared/protocol.js';

const HEAD_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 300_000;

export class RelayError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export class AgentHub {
  constructor({ log = () => {} } = {}) {
    this.agents = new Map(); // name -> Set<conn>
    this.pending = new Map(); // id -> state
    this.rr = new Map(); // name -> 轮询计数
    this.log = log;
  }

  register(name, ws) {
    const conn = { name, ws, ids: new Set(), closed: false };
    if (!this.agents.has(name)) this.agents.set(name, new Set());
    this.agents.get(name).add(conn);
    return conn;
  }

  unregister(conn) {
    if (conn.closed) return;
    conn.closed = true;
    const set = this.agents.get(conn.name);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.agents.delete(conn.name);
    }
    for (const id of [...conn.ids]) {
      const state = this.pending.get(id);
      if (state) this._fail(state, new RelayError('agent 连接已断开', 'AGENT_OFFLINE'));
    }
  }

  isOnline(name) {
    const set = this.agents.get(name);
    return !!(set && set.size);
  }

  onlineNames() {
    return [...this.agents.keys()];
  }

  _pick(name) {
    const set = this.agents.get(name);
    if (!set || !set.size) return null;
    const list = [...set].filter((c) => c.ws.readyState === 1);
    if (!list.length) return null;
    const n = (this.rr.get(name) || 0) + 1;
    this.rr.set(name, n);
    return list[n % list.length];
  }

  _deferred(state) {
    state.response = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    state.response.catch(() => {});
  }

  /** 发起一次 HTTP 转发。返回 { response, write, end, pause, resume, abort, stats } */
  begin(name, { method, url, headers, bytesIn = 0 }) {
    const state = {
      id: newId(),
      kind: 'http',
      conn: null,
      head: null,
      body: new PassThrough(),
      settled: false,
      paused: false,
      bytesIn,
      bytesOut: 0,
      timer: null,
    };
    state.body.on('error', () => {}); // 由 response 的 reject / 消费方处理
    this._deferred(state);

    const conn = this._pick(name);
    if (!conn) {
      state.settled = true;
      state.reject(new RelayError(`规则 "${name}" 的 agent 不在线`, 'AGENT_OFFLINE'));
      return this._httpFacade(state);
    }
    state.conn = conn;
    conn.ids.add(state.id);
    this.pending.set(state.id, state);
    this._armTimer(state, HEAD_TIMEOUT_MS);

    state.body.on('drain', () => {
      if (!state.settled && state.paused) {
        state.paused = false;
        this._send(state, T.REQ_RESUME);
      }
    });

    this._send(state, T.REQ_HEAD, { method, url, headers, target: name });
    return this._httpFacade(state);
  }

  _httpFacade(state) {
    const hub = this;
    return {
      response: state.response,
      write(chunk) {
        if (state.settled) return false;
        hub._send(state, T.REQ_BODY, chunk);
        return true;
      },
      end() {
        if (state.settled) return;
        hub._send(state, T.REQ_END);
      },
      pause() {
        if (state.settled || state.paused) return;
        state.paused = true;
        hub._send(state, T.REQ_PAUSE);
      },
      resume() {
        if (state.settled || !state.paused) return;
        state.paused = false;
        hub._send(state, T.REQ_RESUME);
      },
      abort() {
        if (state.settled) return;
        hub._send(state, T.REQ_CANCEL);
        hub._fail(state, new RelayError('客户端已取消请求', 'CANCELLED'));
      },
      get stats() {
        return { bytesIn: state.bytesIn, bytesOut: state.bytesOut };
      },
    };
  }

  _send(state, type, payload) {
    const conn = state.conn;
    if (!conn || conn.closed || conn.ws.readyState !== 1) return;
    try {
      conn.ws.send(encode(type, state.id, payload));
    } catch {
      /* 连接已断，由 close 事件统一收尾 */
    }
  }

  _armTimer(state, ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this._send(state, T.REQ_CANCEL);
      this._fail(state, new RelayError('agent 响应超时', 'AGENT_TIMEOUT'));
    }, ms);
    state.timer.unref?.();
  }

  _fail(state, err) {
    if (state.settled) return;
    state.settled = true;
    clearTimeout(state.timer);
    this.pending.delete(state.id);
    state.conn?.ids.delete(state.id);
    state.reject(err);
    // WS 隧道状态没有 body，这里必须判空，否则浏览器侧 WS 失败会直接崩掉 relay 进程
    if (state.body && !state.body.destroyed) state.body.destroy(err);
    if (state.kind === 'ws') state.onClose?.(err);
  }

  /** agent -> server 的帧入口 */
  onFrame(conn, data) {
    const frame = decode(data);
    if (!frame) return;
    const state = this.pending.get(frame.id);
    if (!state || state.conn !== conn) return;

    switch (frame.type) {
      case T.RESP_HEAD: {
        const head = jsonPayload(frame) || {};
        state.head = {
          status: head.status || 502,
          statusText: head.statusText || '',
          headers: head.headers || {},
          targetOrigin: head.targetOrigin || '',
          body: state.body,
        };
        this._armTimer(state, IDLE_TIMEOUT_MS);
        state.resolve(state.head);
        break;
      }
      case T.RESP_BODY: {
        state.bytesOut += frame.payload.length;
        if (!state.body.write(frame.payload) && !state.paused) {
          state.paused = true;
          this._send(state, T.REQ_PAUSE);
        }
        this._armTimer(state, IDLE_TIMEOUT_MS);
        break;
      }
      case T.RESP_END: {
        clearTimeout(state.timer);
        this.pending.delete(state.id);
        conn.ids.delete(state.id);
        if (!state.head) {
          this._fail(state, new RelayError('agent 未返回响应头', 'AGENT_PROTOCOL_ERROR'));
        } else {
          state.settled = true;
          state.body.end();
          state.onDone?.(state);
        }
        break;
      }
      case T.RESP_ERROR: {
        const msg = jsonPayload(frame) || {};
        this._fail(state, new RelayError(msg.message || 'agent 转发失败', msg.code || 'AGENT_ERROR'));
        break;
      }
      case T.WS_OPEN_OK: {
        const msg = jsonPayload(frame) || {};
        clearTimeout(state.timer);
        state.opened = true;
        state.protocol = msg.protocol || '';
        state.resolve({ protocol: state.protocol });
        break;
      }
      case T.WS_OPEN_ERR: {
        const msg = jsonPayload(frame) || {};
        this._fail(state, new RelayError(msg.message || 'agent 无法连接目标 WebSocket', 'WS_TARGET_FAILED'));
        break;
      }
      case T.WS_DATA: {
        if (!state.opened) break;
        const isBinary = frame.payload.length > 0 && frame.payload[0] === 1;
        state.onData?.(frame.payload.subarray(1), isBinary);
        break;
      }
      case T.WS_CLOSE: {
        const msg = jsonPayload(frame) || {};
        if (state.opened) {
          state.onClose?.({ code: msg.code || 1000, reason: msg.reason || '' });
        } else {
          this._fail(state, new RelayError(msg.reason || '目标 WebSocket 已关闭', 'WS_TARGET_CLOSED'));
        }
        this._cleanup(state);
        break;
      }
    }
  }

  /** 打开一条 WebSocket 隧道：{ ready, send, close, onData, onClose } */
  openWebSocket(name, { url, headers, protocols = [] }) {
    const hub = this;
    const state = {
      id: newId(),
      kind: 'ws',
      conn: null,
      settled: false,
      opened: false,
      timer: null,
      onData: null,
      onClose: null,
    };
    this._deferred(state);

    const conn = this._pick(name);
    if (!conn) {
      state.settled = true;
      state.reject(new RelayError(`规则 "${name}" 的 agent 不在线`, 'AGENT_OFFLINE'));
    } else {
      state.conn = conn;
      conn.ids.add(state.id);
      this.pending.set(state.id, state);
      this._armTimer(state, HEAD_TIMEOUT_MS);
      this._send(state, T.WS_OPEN, { url, headers, protocols });
    }

    return {
      ready: state.response,
      send(data, isBinary) {
        if (state.settled) return;
        const flag = Buffer.from([isBinary ? 1 : 0]);
        hub._send(state, T.WS_DATA, Buffer.concat([flag, Buffer.isBuffer(data) ? data : Buffer.from(data)]));
      },
      close(code = 1000, reason = '') {
        if (state.settled) return;
        hub._send(state, T.WS_CLOSE, { code, reason: String(reason).slice(0, 120) });
        hub._cleanup(state);
      },
      set onData(fn) {
        state.onData = fn;
      },
      set onClose(fn) {
        state.onClose = fn;
      },
      get stats() {
        return { bytesIn: 0, bytesOut: 0, kind: 'ws' };
      },
    };
  }

  _cleanup(state) {
    if (state.settled) return;
    state.settled = true;
    clearTimeout(state.timer);
    this.pending.delete(state.id);
    state.conn?.ids.delete(state.id);
  }
}
