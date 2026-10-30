// wormhole agent：跑在内网，主动连接 relay，把下发的请求/WS 隧道转发给内网目标。
// 自带本地 Web UI（默认 http://127.0.0.1:7810），配置保存在 agent-config.json，界面改动即时生效。
//
// 用法:
//   node agent/index.js                          # 纯 UI 模式，浏览器打开 http://127.0.0.1:7810 配置
//   node agent/index.js --relay http://relay:7800 --secret xx --name wiki --target http://10.0.0.2:8090
//                                                # CLI 传参作为初始配置，仍可用 UI 修改
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
function loadConfig() {
  // CLI 参数 → 初始配置；否则读配置文件；否则空配置等 UI 填写
  const cli = {
    relay: (arg('--relay', process.env.RELAY_URL || '') || '').replace(/\/+$/, ''),
    name: arg('--name', process.env.RELAY_NAME || ''),
    authMode: 'secret',
    secret: arg('--secret', process.env.RELAY_SECRET || ''),
    token: arg('--token', process.env.RELAY_TOKEN || '') || arg('--token', ''),
    target: arg('--target', process.env.RELAY_TARGET || ''),
    autoStart: true,
  };
  const hasCli = cli.relay && cli.name && cli.target && (cli.secret || cli.token);
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (hasCli && saved.source === 'ui') {
      // UI 保存过的配置优先于重复的 CLI 参数（便于 systemd 里固定传参的场景）
      return normalize(saved);
    }
    return normalize(hasCli ? { ...cli, source: 'cli' } : saved);
  } catch {
    return normalize(hasCli ? { ...cli, source: 'cli' } : { relay: '', name: '', authMode: 'secret', secret: '', token: '', target: '', autoStart: true, source: 'ui' });
  }
}

function normalize(c) {
  return {
    relay: String(c.relay || '').replace(/\/+$/, ''),
    name: String(c.name || '').trim(),
    authMode: c.authMode === 'token' ? 'token' : 'secret',
    secret: String(c.secret || ''),
    token: String(c.token || ''),
    target: String(c.target || ''),
    autoStart: c.autoStart !== false,
    source: c.source === 'cli' ? 'cli' : 'ui',
  };
}

let cfg = loadConfig();

// ---------- 隧道状态 ----------
let ws = null;
let tunnelState = 'stopped'; // stopped | connecting | connected
let lastError = '';
let connectedAt = null;
let reconnectTimer = null;
let wantConnected = false;

const pendingBodyHandlers = new Map(); // id -> handler(type, payload)
const wsTunnels = new Map();           // id -> target socket

function authToken() {
  if (cfg.authMode === 'token') return cfg.token;
  return crypto.createHash('sha256').update(`${cfg.name}::${cfg.secret}`).digest('hex');
}

function validateConfig(c) {
  const errors = [];
  if (!c.relay) errors.push('relay 地址不能为空');
  if (!/^https?:\/\//.test(c.relay)) errors.push('relay 地址需以 http:// 或 https:// 开头');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(c.name)) errors.push('规则名只能包含字母、数字、连字符');
  if (c.authMode === 'secret' && !c.secret) errors.push('缺少共享密钥');
  if (c.authMode === 'token' && !c.token) errors.push('缺少规则 token');
  if (!c.target) errors.push('目标网站地址不能为空');
  if (c.target && !/^https?:\/\//.test(c.target)) errors.push('目标地址需以 http:// 或 https:// 开头');
  return errors;
}

function connect() {
  if (ws) { try { ws.terminate(); } catch { } ws = null; }
  clearTimeout(reconnectTimer);
  wantConnected = true;
  tunnelState = 'connecting';
  lastError = '';

  const url = `${cfg.relay}/agent/ws?name=${encodeURIComponent(cfg.name)}&token=${encodeURIComponent(authToken())}`;
  const sock = new WebSocket(url);
  ws = sock;
  let alive = true;

  sock.on('open', () => {
    if (ws !== sock) return;
    tunnelState = 'connected';
    connectedAt = Date.now();
    console.log(`[${new Date().toISOString()}] 已连接 relay ${cfg.relay}（规则: ${cfg.name} → ${cfg.target}）`);
  });

  sock.on('message', (data, isBinary) => {
    if (ws !== sock || !isBinary) return;
    const frame = decode(data);
    if (!frame) return;
    try {
      if (frame.type === T.REQ_HEAD) handleHttp(frame, jsonPayload(frame));
      else if (frame.type === T.WS_OPEN) handleWsOpen(frame, jsonPayload(frame));
      else routeFrame(frame);
    } catch (e) {
      console.error('[frame] 处理失败:', e.message);
    }
  });

  sock.on('pong', () => { alive = true; });
  sock.on('close', () => {
    if (ws !== sock) return;
    ws = null;
    cleanupAll();
    if (wantConnected) {
      tunnelState = 'connecting';
      lastError = '连接断开，等待重连…';
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    } else {
      tunnelState = 'stopped';
    }
    console.log(`[${new Date().toISOString()}] 与 relay 断开`);
  });
  sock.on('error', (e) => {
    if (ws !== sock) return;
    lastError = e.message;
    console.error(`[ws] 连接错误: ${e.message}`);
  });

  const hb = setInterval(() => {
    if (ws !== sock || sock.readyState !== WebSocket.OPEN) { clearInterval(hb); return; }
    alive = false;
    sock.ping();
    setTimeout(() => {
      if (ws === sock && !alive) sock.terminate();
    }, 10000);
  }, 30000);
  sock.on('close', () => clearInterval(hb));
}

function disconnect() {
  wantConnected = false;
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch { } }
  ws = null;
  cleanupAll();
  tunnelState = 'stopped';
  lastError = '';
}

function cleanupAll() {
  pendingBodyHandlers.clear();
  for (const [, s] of wsTunnels) { try { s.destroy(); } catch { } }
  wsTunnels.clear();
}

function send(type, id, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(type, id, payload));
}

// ---------- HTTP 转发（流式） ----------
let targetUrl = null;
function targetOrigin() {
  try { targetUrl = new URL(cfg.target); } catch { return null; }
  return targetUrl;
}

function handleHttp(headFrame, head) {
  if (!head) return;
  const { id } = headFrame;
  const tu = targetUrl || targetOrigin();
  if (!tu) {
    send(T.RESP_ERROR, id, { message: '目标地址无效', code: 'TARGET_FAILED' });
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
      send(T.RESP_HEAD, id, {
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: res.headers,
        targetOrigin: tu.origin,
      });
      res.on('data', (c) => send(T.RESP_BODY, id, c));
      res.on('end', () => send(T.RESP_END, id));
      res.on('error', () => send(T.RESP_END, id));
    }
  );

  upstream.on('error', (e) => {
    send(T.RESP_ERROR, id, { message: `访问内网目标失败: ${e.message}`, code: 'TARGET_FAILED' });
  });

  pendingBodyHandlers.set(id, (type, payload) => {
    if (type === T.REQ_BODY) upstream.write(payload);
    else if (type === T.REQ_END) { upstream.end(); pendingBodyHandlers.delete(id); }
    else if (type === T.REQ_CANCEL) { upstream.destroy(); pendingBodyHandlers.delete(id); }
    // PAUSE/RESUME：server 侧 PassThrough 已缓冲，这里无需处理
  });
}

// ---------- WebSocket 隧道 ----------
function handleWsOpen(frame, msg) {
  if (!msg) return;
  const { id } = frame;
  const tu = targetUrl || targetOrigin();
  if (!tu) { send(T.WS_OPEN_ERR, id, { message: '目标地址无效' }); return; }
  let target;
  try { target = new URL(msg.url, tu.origin); } catch { send(T.WS_OPEN_ERR, id, { message: '无效的 WS 路径' }); return; }
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
    send(T.WS_OPEN_OK, id, { protocol: res.headers['sec-websocket-protocol'] || '' });
    if (head?.length) send(T.WS_DATA, id, Buffer.concat([Buffer.from([1]), head]));
    socket.on('data', (c) => send(T.WS_DATA, id, Buffer.concat([Buffer.from([1]), c])));
    socket.on('close', () => send(T.WS_CLOSE, id, { code: 1000, reason: '' }));
    socket.on('error', () => send(T.WS_CLOSE, id, { code: 1011, reason: 'target socket error' }));
    wsTunnels.set(id, socket);
  });
  req.on('response', (res) => {
    send(T.WS_OPEN_ERR, id, { message: `目标未升级为 WebSocket (HTTP ${res.statusCode})` });
  });
  req.on('error', (e) => {
    send(T.WS_OPEN_ERR, id, { message: `连接目标失败: ${e.message}` });
  });
  req.end();
}

function routeFrame(frame) {
  const handler = pendingBodyHandlers.get(frame.id);
  if (handler) return handler(frame.type, frame.payload);
  const tunnel = wsTunnels.get(frame.id);
  if (tunnel) {
    if (frame.type === T.WS_DATA) tunnel.write(frame.payload.subarray(1));
    else if (frame.type === T.WS_CLOSE) { tunnel.end(); wsTunnels.delete(frame.id); }
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

      const changed = next.relay !== cfg.relay || next.name !== cfg.name || next.authMode !== cfg.authMode
        || next.secret !== cfg.secret || next.token !== cfg.token || next.target !== cfg.target;
      cfg = next;
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch { /* 保存失败不阻断 */ }
      if (changed) {
        // 目标变化时清缓存；连接参数变化时重连
        targetUrl = null;
        if (wantConnected || next.autoStart) connect();
      }
      return sendJSON(res, 200, { config: cfg, restarted: changed });
    }
  }

  if (pathName === '/api/tunnel' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: '无效的 JSON' }); }
    if (body.action === 'start') {
      const errors = validateConfig(cfg);
      if (errors.length) return sendJSON(res, 400, { error: errors.join('；') });
      connect();
      return sendJSON(res, 200, { ok: true });
    }
    if (body.action === 'stop') {
      disconnect();
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 400, { error: 'action 必须是 start 或 stop' });
  }

  if (pathName === '/api/status' && req.method === 'GET') {
    return sendJSON(res, 200, {
      state: tunnelState,
      lastError,
      connectedAt,
      targetOnline: null, // 填了配置后由前端探测
    });
  }

  // 探测目标网站是否可达（帮助排查 target 填错）
  if (pathName === '/api/test-target' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const t = body.target || cfg.target;
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
  // CLI 给了完整配置则自动启动隧道
  if (cfg.autoStart && validateConfig(cfg).length === 0) {
    connect();
  } else if (validateConfig(cfg).length) {
    console.log('配置不完整，请在管理界面中完成配置');
  }
});
