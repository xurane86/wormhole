// wormhole agent：跑在内网，主动连接 relay，把下发的请求/WS 隧道转发给内网目标。
// 支持多规则：一条配置里可定义多个 {规则名 → 内网目标}，每条规则一条 WS 连接，互不影响。
// 自带本地 Web UI（默认 http://127.0.0.1:7810），配置保存在 agent-config.json，界面改动即时生效。
//
// 用法:
//   node agent/index.js                          # 纯 UI 模式，浏览器打开 http://127.0.0.1:7810 配置
//   node agent/index.js --relay http://relay:7800 --secret xx --name wiki --target http://10.0.0.2:8090
//                                                # CLI 传参作为第一条规则的初始配置，仍可用 UI 增加/修改
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { T, encode, decode, jsonPayload } from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function arg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}

const UI_PORT = parseInt(arg('--ui-port', '7810'), 10);
const CONFIG_FILE = path.resolve(arg('--config', path.join(__dirname, 'agent-config.json')));
const RECONNECT_MS = 3000;

// ---------- 配置 ----------
// 结构: { relay, autoStart, source, rules: [{ name, target, authMode, secret, token }] }
function loadConfig() {
  const cli = {
    relay: (arg('--relay', process.env.RELAY_URL || '') || '').replace(/\/+$/, ''),
    name: arg('--name', process.env.RELAY_NAME || ''),
    secret: arg('--secret', process.env.RELAY_SECRET || ''),
    token: arg('--token', process.env.RELAY_TOKEN || ''),
    target: arg('--target', process.env.RELAY_TARGET || ''),
  };
  const cliRule = cli.relay && cli.name && cli.target && (cli.secret || cli.token)
    ? [{ name: cli.name, target: cli.target, authMode: cli.token ? 'token' : 'secret', secret: cli.secret, token: cli.token }]
    : [];

  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cliRule.length && saved.source === 'ui') {
      // UI 保存过的配置优先于重复的 CLI 参数（便于 systemd 里固定传参的场景）
      return normalize(saved);
    }
    if (cliRule.length) return normalize({ relay: cli.relay, autoStart: true, source: 'cli', rules: cliRule });
    return normalize(saved);
  } catch {
    if (cliRule.length) return normalize({ relay: cli.relay, autoStart: true, source: 'cli', rules: cliRule });
    return normalize({ relay: '', autoStart: true, source: 'ui', rules: [] });
  }
}

function normalizeRule(r) {
  return {
    name: String(r?.name || '').trim(),
    target: String(r?.target || ''),
    authMode: r?.authMode === 'token' ? 'token' : 'secret',
    secret: String(r?.secret || ''),
    token: String(r?.token || ''),
  };
}

function normalize(c) {
  // 旧版单规则配置（顶层 name/target/...）自动迁移为 rules[0]
  let rules = Array.isArray(c.rules) ? c.rules.map(normalizeRule) : [];
  if (!rules.length && c.name && c.target) {
    rules = [normalizeRule({ name: c.name, target: c.target, authMode: c.authMode, secret: c.secret, token: c.token })];
  }
  return {
    relay: String(c.relay || '').replace(/\/+$/, ''),
    autoStart: c.autoStart !== false,
    source: c.source === 'cli' ? 'cli' : 'ui',
    rules,
  };
}

let cfg = loadConfig();

function validateRule(r) {
  const errors = [];
  if (!r.name) errors.push('规则名不能为空');
  else if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(r.name)) errors.push(`规则名 "${r.name}" 只能包含字母、数字、连字符`);
  if (r.authMode === 'token' && !r.token) errors.push(`规则 "${r.name}" 缺少规则 token`);
  if (r.authMode === 'secret' && !r.secret) errors.push(`规则 "${r.name}" 缺少共享密钥`);
  if (!r.target) errors.push(`规则 "${r.name}" 缺少目标网站地址`);
  else if (!/^https?:\/\//.test(r.target)) errors.push(`规则 "${r.name}" 的目标地址需以 http:// 或 https:// 开头`);
  return errors;
}

function validateConfig(c) {
  const errors = [];
  if (!c.relay) errors.push('relay 地址不能为空');
  if (c.relay && !/^https?:\/\//.test(c.relay)) errors.push('relay 地址需以 http:// 或 https:// 开头');
  if (!c.rules.length) errors.push('至少需要一条规则');
  const seen = new Set();
  for (const r of c.rules) {
    if (seen.has(r.name)) errors.push(`规则名 "${r.name}" 重复`);
    seen.add(r.name);
    errors.push(...validateRule(r));
  }
  return errors;
}

// ---------- 隧道状态（每条规则一个） ----------
// tunnels: name -> { ws, state, lastError, connectedAt, reconnectTimer, wantConnected, pendingBodyHandlers, wsTunnels, hbTimer }
const tunnels = new Map();

function getTunnel(name) {
  let t = tunnels.get(name);
  if (!t) {
    t = {
      name,
      ws: null,
      state: 'stopped',
      lastError: '',
      connectedAt: null,
      reconnectTimer: null,
      wantConnected: false,
      pendingBodyHandlers: new Map(),
      wsTunnels: new Map(),
      hbTimer: null,
    };
    tunnels.set(name, t);
  }
  return t;
}

function authToken(rule) {
  if (rule.authMode === 'token') return rule.token;
  return crypto.createHash('sha256').update(`${rule.name}::${rule.secret}`).digest('hex');
}

function cleanupTunnel(t) {
  t.pendingBodyHandlers.clear();
  for (const [, s] of t.wsTunnels) { try { s.destroy(); } catch { } }
  t.wsTunnels.clear();
}

function connectRule(rule) {
  if (!cfg.relay) return;
  const t = getTunnel(rule.name);
  if (t.ws) { try { t.ws.terminate(); } catch { } t.ws = null; }
  clearTimeout(t.reconnectTimer);
  t.wantConnected = true;
  t.state = 'connecting';
  t.lastError = '';

  const url = `${cfg.relay}/agent/ws?name=${encodeURIComponent(rule.name)}&token=${encodeURIComponent(authToken(rule))}`;
  const sock = new WebSocket(url);
  t.ws = sock;
  let alive = true;

  sock.on('open', () => {
    if (t.ws !== sock) return;
    t.state = 'connected';
    t.connectedAt = Date.now();
    console.log(`[${new Date().toISOString()}] [${rule.name}] 已连接 relay ${cfg.relay}（目标: ${rule.target}）`);
  });

  sock.on('message', (data, isBinary) => {
    if (t.ws !== sock || !isBinary) return;
    const frame = decode(data);
    if (!frame) return;
    try {
      if (frame.type === T.REQ_HEAD) handleHttp(rule, t, frame, jsonPayload(frame));
      else if (frame.type === T.WS_OPEN) handleWsOpen(rule, t, frame, jsonPayload(frame));
      else routeFrame(t, frame);
    } catch (e) {
      console.error(`[${rule.name}] [frame] 处理失败:`, e.message);
    }
  });

  sock.on('pong', () => { alive = true; });
  sock.on('close', () => {
    if (t.ws !== sock) return;
    t.ws = null;
    clearInterval(t.hbTimer);
    cleanupTunnel(t);
    if (t.wantConnected) {
      t.state = 'connecting';
      t.lastError = '连接断开，等待重连…';
      t.reconnectTimer = setTimeout(() => connectRule(rule), RECONNECT_MS);
    } else {
      t.state = 'stopped';
    }
    console.log(`[${new Date().toISOString()}] [${rule.name}] 与 relay 断开`);
  });
  sock.on('error', (e) => {
    if (t.ws !== sock) return;
    t.lastError = e.message;
    console.error(`[${rule.name}] [ws] 连接错误: ${e.message}`);
  });

  t.hbTimer = setInterval(() => {
    if (t.ws !== sock || sock.readyState !== WebSocket.OPEN) { clearInterval(t.hbTimer); return; }
    alive = false;
    sock.ping();
    setTimeout(() => {
      if (t.ws === sock && !alive) sock.terminate();
    }, 10000);
  }, 30000);
}

function disconnectRule(name) {
  const t = tunnels.get(name);
  if (!t) return;
  t.wantConnected = false;
  clearTimeout(t.reconnectTimer);
  if (t.ws) { try { t.ws.close(); } catch { } }
  t.ws = null;
  clearInterval(t.hbTimer);
  cleanupTunnel(t);
  t.state = 'stopped';
  t.lastError = '';
}

function connectAll() {
  for (const rule of cfg.rules) connectRule(rule);
}

function disconnectAll() {
  for (const name of [...tunnels.keys()]) disconnectRule(name);
}

function send(t, type, id, payload) {
  if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(encode(type, id, payload));
}

// ---------- HTTP 转发（流式） ----------
const targetUrls = new Map(); // name -> URL | null
function targetOrigin(rule) {
  if (!targetUrls.has(rule.name)) {
    try { targetUrls.set(rule.name, new URL(rule.target)); } catch { targetUrls.set(rule.name, null); }
  }
  return targetUrls.get(rule.name);
}

function handleHttp(rule, t, headFrame, head) {
  if (!head) return;
  const { id } = headFrame;
  const tu = targetOrigin(rule);
  if (!tu) {
    send(t, T.RESP_ERROR, id, { message: '目标地址无效', code: 'TARGET_FAILED' });
    return;
  }
  const targetHeaders = { ...head.headers };
  targetHeaders.host = tu.host;
  if (tu.username || tu.password) {
    const auth = Buffer.from(`${decodeURIComponent(tu.username)}:${decodeURIComponent(tu.password)}`).toString('base64');
    targetHeaders.authorization = `Basic ${auth}`;
  }

  const upstream = http.request(
    {
      protocol: tu.protocol,
      hostname: tu.hostname,
      port: tu.port || (tu.protocol === 'https:' ? 443 : 80),
      method: head.method,
      path: head.url,
      headers: targetHeaders,
    },
    (res) => {
      send(t, T.RESP_HEAD, id, {
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: res.headers,
        targetOrigin: tu.origin,
      });
      res.on('data', (c) => send(t, T.RESP_BODY, id, c));
      res.on('end', () => send(t, T.RESP_END, id));
      res.on('error', () => send(t, T.RESP_END, id));
    }
  );

  upstream.on('error', (e) => {
    send(t, T.RESP_ERROR, id, { message: `访问内网目标失败: ${e.message}`, code: 'TARGET_FAILED' });
  });

  t.pendingBodyHandlers.set(id, (type, payload) => {
    if (type === T.REQ_BODY) upstream.write(payload);
    else if (type === T.REQ_END) { upstream.end(); t.pendingBodyHandlers.delete(id); }
    else if (type === T.REQ_CANCEL) { upstream.destroy(); t.pendingBodyHandlers.delete(id); }
    // PAUSE/RESUME：server 侧 PassThrough 已缓冲，这里无需处理
  });
}

// ---------- WebSocket 隧道 ----------
function handleWsOpen(rule, t, frame, msg) {
  if (!msg) return;
  const { id } = frame;
  const tu = targetOrigin(rule);
  if (!tu) { send(t, T.WS_OPEN_ERR, id, { message: '目标地址无效' }); return; }
  let target;
  try { target = new URL(msg.url, tu.origin); } catch { send(t, T.WS_OPEN_ERR, id, { message: '无效的 WS 路径' }); return; }
  const isTLS = target.protocol === 'wss:' || tu.protocol === 'https:';
  const key = crypto.randomBytes(16).toString('base64');

  const headers = { ...msg.headers, host: target.host };
  for (const h of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'upgrade', 'connection']) delete headers[h];

  const req = http.request({
    protocol: isTLS ? 'https:' : 'http:',
    hostname: target.hostname,
    port: target.port || (isTLS ? 443 : 80),
    path: target.pathname + target.search,
    headers: {
      ...headers,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
      ...(msg.protocols?.length ? { 'sec-websocket-protocol': msg.protocols.join(', ') } : {}),
    },
  });
  req.on('upgrade', (res, socket, head) => {
    send(t, T.WS_OPEN_OK, id, { protocol: res.headers['sec-websocket-protocol'] || '' });
    // socket 是升级后的底层传输；两个方向都需按 RFC6455 封帧/解帧（见 encodeWsFrame / createWsFrameDecoder）
    t.wsTunnels.set(id, socket);
    if (head?.length) send(t, T.WS_DATA, id, Buffer.concat([Buffer.from([1]), head]));
    const decode = createWsFrameDecoder((payload, opcode) => {
      if (opcode === 0x8) {
        // 从 close 帧提取真实 code/reason 回传 relay（RFC6455：前2字节 code，余下 reason）
        let code = 1000, reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString();
        }
        send(t, T.WS_CLOSE, id, { code, reason });
        socket.end();
        t.wsTunnels.delete(id);
        return;
      }
      if (opcode === 0x9 || opcode === 0xA) return; // ping/pong 忽略
      if (opcode === 0x1 || opcode === 0x2) {
        send(t, T.WS_DATA, id, Buffer.concat([Buffer.from([opcode === 0x2 ? 1 : 0]), payload]));
      }
    });
    socket.on('data', (c) => decode(c));
    socket.on('close', () => send(t, T.WS_CLOSE, id, { code: 1000, reason: '' }));
    socket.on('error', () => send(t, T.WS_CLOSE, id, { code: 1011, reason: 'target socket error' }));
  });
  req.on('response', (res) => {
    send(t, T.WS_OPEN_ERR, id, { message: `目标未升级为 WebSocket (HTTP ${res.statusCode})` });
  });
  req.on('error', (e) => {
    send(t, T.WS_OPEN_ERR, id, { message: `连接目标失败: ${e.message}` });
  });
  req.end();
}

// RFC6455 客户端帧封装（必须掩码）。opcode: 0x1 文本 / 0x2 binary / 0x8 close
// RFC6455 帧流解析器（服务端视角：帧不带掩码；支持分片/跨包）。回调 (payload, opcode)
function createWsFrameDecoder(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const mask = masked ? 4 : 0;
      if (buf.length < off + mask + len) return;
      let payload = buf.subarray(off + mask, off + mask + len);
      if (masked) {
        const mk = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
      }
      buf = buf.subarray(off + mask + len);
      onFrame(payload, opcode);
    }
  };
}

function encodeWsFrame(data, opcode) {
  const len = data.length;
  let header;
  let maskLen = 4;
  if (len < 126) {
    header = Buffer.allocUnsafe(2 + maskLen);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len; // mask 位
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4 + maskLen);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10 + maskLen);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const maskOffset = header.length - maskLen;
  const mask = crypto.randomBytes(maskLen);
  mask.copy(header, maskOffset);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, body]);
}

function routeFrame(t, frame) {
  const handler = t.pendingBodyHandlers.get(frame.id);
  if (handler) return handler(frame.type, frame.payload);
  const tunnel = t.wsTunnels.get(frame.id);
  if (tunnel) {
    if (frame.type === T.WS_DATA) {
      // tunnel 是升级后的底层 socket：裸写应用数据没有 WS 帧封装，对端会解析出非法帧。
      // 服务端→客户端方向作为 client（无需掩码），按 RFC6455 手动封帧（文本/binary，不分片）。
      const appData = frame.payload.subarray(1);
      const isBinary = frame.payload[0] === 1;
      tunnel.write(encodeWsFrame(appData, isBinary ? 0x2 : 0x1));
    } else if (frame.type === T.WS_CLOSE) {
      // 携带 close code/reason 封成 close 帧（JSON payload），让对端拿到真实关闭码
      let code = 1000, reason = '';
      try { const m = JSON.parse(frame.payload.toString() || '{}'); code = m.code || 1000; reason = m.reason || ''; } catch { }
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      tunnel.write(encodeWsFrame(body, 0x8));
      tunnel.end();
      t.wsTunnels.delete(frame.id);
    }
  }
}

// ---------- 本地 Web UI ----------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const uiServer = http.createServer(async (req, res) => {
  const pathName = new URL(req.url, 'http://x').pathname;

  if (req.method === 'GET' && (pathName === '/' || pathName === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'agent.html')));
  }

  if (req.method === 'GET' && (pathName === '/style.css' || pathName === '/index.css')) {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'style.css')));
  }

  if (pathName === '/api/config') {
    if (req.method === 'GET') return sendJSON(res, 200, { config: cfg });
    if (req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: '无效的 JSON' }); }
      const next = normalize({ ...cfg, ...body, source: 'ui' });
      const errors = validateConfig(next);
      if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });

      const prevRules = new Map(cfg.rules.map(r => [r.name, r]));
      const nextRules = new Map(next.rules.map(r => [r.name, r]));
      cfg = next;
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch { /* 保存失败不阻断 */ }

      // 目标地址缓存失效
      targetUrls.clear();

      // 逐条规则对比：停掉已删除的，重连变更的，新增的直接连
      for (const [name] of prevRules) {
        if (!nextRules.has(name)) disconnectRule(name);
      }
      for (const rule of next.rules) {
        const prev = prevRules.get(rule.name);
        const ruleChanged = !prev || JSON.stringify(rule) !== JSON.stringify(prev);
        if (ruleChanged) {
          if (tunnels.get(rule.name)?.wantConnected || next.autoStart) connectRule(rule);
        }
      }
      return sendJSON(res, 200, { config: cfg, restarted: true });
    }
  }

  if (pathName === '/api/tunnel' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: '无效的 JSON' }); }
    if (body.action === 'start') {
      const errors = validateConfig(cfg);
      if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });
      connectAll();
      return sendJSON(res, 200, { ok: true });
    }
    if (body.action === 'stop') {
      disconnectAll();
      return sendJSON(res, 200, { ok: true });
    }
    if (body.action === 'start-rule' && body.name) {
      const rule = cfg.rules.find(r => r.name === body.name);
      if (!rule) return sendJSON(res, 404, { error: '规则不存在' });
      const errors = validateRule(rule);
      if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });
      connectRule(rule);
      return sendJSON(res, 200, { ok: true });
    }
    if (body.action === 'stop-rule' && body.name) {
      disconnectRule(body.name);
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 400, { error: 'action 必须是 start / stop / start-rule / stop-rule' });
  }

  if (pathName === '/api/status' && req.method === 'GET') {
    const rules = cfg.rules.map(r => {
      const t = tunnels.get(r.name);
      return {
        name: r.name,
        state: t?.state || 'stopped',
        lastError: t?.lastError || '',
        connectedAt: t?.connectedAt || null,
      };
    });
    return sendJSON(res, 200, {
      rules,
      anyConnected: rules.some(r => r.state === 'connected'),
      connecting: rules.some(r => r.state === 'connecting'),
    });
  }

  // 探测目标网站是否可达（帮助排查 target 填错）
  if (pathName === '/api/test-target' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const t = body.target || '';
    let tu;
    try { tu = new URL(t); } catch { return sendJSON(res, 200, { ok: false, message: '目标地址无效' }); }
    return new Promise((resolve) => {
      const probe = http.request({ protocol: tu.protocol, hostname: tu.hostname, port: tu.port, method: 'HEAD', path: '/', timeout: 5000 }, (r) => {
        sendJSON(res, 200, { ok: true, message: `目标可达 (HTTP ${r.statusCode})` });
        resolve();
      });
      probe.on('timeout', () => { probe.destroy(); sendJSON(res, 200, { ok: false, message: '连接超时' }); resolve(); });
      probe.on('error', (e) => { sendJSON(res, 200, { ok: false, message: `不可达: ${e.message}` }); resolve(); });
      probe.end();
    });
  }

  res.writeHead(404);
  res.end();
});

uiServer.listen(UI_PORT, () => {
  console.log(`agent 管理界面: http://127.0.0.1:${UI_PORT}`);
  console.log(`配置文件: ${CONFIG_FILE}`);
  // 配置完整则自动启动所有规则
  const errors = validateConfig(cfg);
  if (cfg.autoStart && !errors.length) {
    connectAll();
  } else if (errors.length) {
    console.log('配置不完整，请在管理界面中完成配置');
  }
});
