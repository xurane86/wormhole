// wormhole 端到端回归测试（npm test）
//
// 覆盖范围：
//   1. 路径模式 / 子域名模式的 HTTP 转发（GET 与带 body 的 POST）
//   2. WS 桥接：两个模式下的双向收发
//   3. 目标站 WS 心跳：目标发 Ping，agent 必须回 Pong，否则目标会判定连接死亡并主动断开
//   4. WS 子协议协商：目标选中的协议要原样回给浏览器，且并发连接之间不能串台
//   5. relay 侧 WS 保活：relay 必须主动给浏览器侧发 Ping（前置 CDN/反代会掐掉空闲 WS）
//
// 实现方式：同进程内 import server / agent（argv 先行改写），避免依赖外部进程与端口占用。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 17800);
const TARGET_PORT = Number(process.env.E2E_TARGET_PORT || 19101);
const AGENT_UI_PORT = Number(process.env.E2E_AGENT_UI_PORT || 17899);
const ROOT_DOMAIN = 'test.local';
const RULE = 'codeg';
const SECRET = 'e2e-secret';
const TOKEN_PROTO = 'codeg-token.e2e';

const KEEPALIVE_MS = 1500;      // 测试里把 relay 的 WS 保活间隔调小，便于断言
const TARGET_PING_MS = 3000;    // 目标每 3s ping 一次
const TARGET_PONG_DEADLINE = 8000; // 8s 收不到 pong 就按“连接已死”断开（模拟真实站点心跳）

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---------- 模拟内网目标站 ----------
let targetPongSeen = 0;
const targetErrors = [];
const target = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><head><title>codeg</title></head><body>codeg workspace</body></html>');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ got: Buffer.concat(chunks).toString(), method: req.method }));
  });
});

// WS：回显 + 目标侧心跳（Ping/Pong）+ 子协议选择（模拟 codeg 用 codeg-token.* 带鉴权）
const wssTarget = new WebSocketServer({
  server: target,
  path: '/ws/events',
  handleProtocols: (protocols) => {
    for (const p of protocols) if (String(p).startsWith('codeg-token.')) return p;
    return false;
  },
});
wssTarget.on('connection', (sock) => {
  sock.on('error', (e) => targetErrors.push(e.message));
  sock.on('message', (d) => sock.send(`echo:${d}`));
  sock.on('pong', () => { targetPongSeen += 1; });
  const hb = setInterval(() => {
    if (sock.readyState !== WebSocket.OPEN) return;
    const before = targetPongSeen;
    sock.ping();
    setTimeout(() => {
      if (targetPongSeen === before && sock.readyState === WebSocket.OPEN) {
        // 真实站点（如用 ws 库自建心跳的服务）会在这里判死并断开
        sock.close(4000, 'no pong');
      }
    }, TARGET_PONG_DEADLINE);
  }, TARGET_PING_MS);
  sock.on('close', () => clearInterval(hb));
});

// ---------- 准备 relay 数据目录 / agent 配置 ----------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wormhole-e2e-'));
const dataDir = path.join(tmpDir, 'relay-data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify([{
  name: RULE, description: 'e2e', enabled: true, token: 'e2e-rule-token',
  accessPassHash: '', createdAt: Date.now(), updatedAt: Date.now(),
  stats: { requests: 0, bytes: 0, lastRequestAt: null },
}], null, 2));
const agentConfigFile = path.join(tmpDir, 'agent-config.json');
fs.writeFileSync(agentConfigFile, JSON.stringify({ relay: '', autoStart: false, source: 'cli', rules: [] }, null, 2));

// ---------- 启动 relay 与 agent ----------
await new Promise((r) => target.listen(TARGET_PORT, r));

process.argv = ['node', 'server/index.js', '--port', String(RELAY_PORT), '--secret', SECRET,
  '--data', dataDir, '--root-domain', ROOT_DOMAIN];
process.env.RELAY_WS_KEEPALIVE_MS = String(KEEPALIVE_MS);
await import(pathToFileURL(path.join(ROOT, 'server/index.js')).href);

process.argv = ['node', 'agent/index.js', '--relay', `http://127.0.0.1:${RELAY_PORT}`, '--secret', SECRET,
  '--name', RULE, '--target', `http://127.0.0.1:${TARGET_PORT}`, '--ui-port', String(AGENT_UI_PORT),
  '--config', agentConfigFile];
await import(pathToFileURL(path.join(ROOT, 'agent/index.js')).href);

// 等 agent 上线
const subHost = `${RULE}.${ROOT_DOMAIN}`;
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/rules`);
    const j = await r.json();
    if (j.rules?.[0]?.online) break;
  } catch { /* relay 还没起来 */ }
  await new Promise((r) => setTimeout(r, 100));
}

// ---------- 工具 ----------
function req(method, p, { host = subHost, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: RELAY_PORT, method, path: p, headers: { host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    r.end(body);
  });
}

function openWs(p, { host = subHost, protocols, onPing } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}${p}`, protocols || [], { headers: { host } });
  if (onPing) ws.on('ping', onPing);
  ws.on('error', () => { }); // 测试客户端自身不因对端异常而崩
  return ws;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const opened = (ws) => new Promise((resolve, reject) => {
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
  ws.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
});

console.log('\n===== 1. HTTP 转发 =====');
const g1 = await req('GET', '/workspace');
check('子域名模式 GET', g1.status === 200 && g1.body.includes('codeg workspace'), `status=${g1.status}`);

const g2 = await req('GET', `/p/${RULE}/workspace`, { host: '127.0.0.1' });
check('路径模式 GET（注入 <base>）', g2.status === 200 && g2.body.includes(`<base href="/p/${RULE}/">`), `status=${g2.status}`);

const p1 = await req('POST', '/api/echo', { body: '{"a":1}' });
check('子域名模式 POST（带 body）', p1.status === 200 && JSON.parse(p1.body).got === '{"a":1}', `status=${p1.status} body=${p1.body.slice(0, 60)}`);

const p2 = await req('POST', `/p/${RULE}/api/echo`, { host: '127.0.0.1', body: '{"a":2}' });
check('路径模式 POST（带 body）', p2.status === 200 && JSON.parse(p2.body).got === '{"a":2}', `status=${p2.status} body=${p2.body.slice(0, 60)}`);

console.log('\n===== 2. WS 桥接与目标侧心跳 =====');
const wsA = await opened(openWs('/ws/events'));
const echo = await new Promise((resolve) => {
  wsA.once('message', (d) => resolve(d.toString()));
  wsA.send('hello');
});
check('子域名模式 WS 收发', echo === 'echo:hello', `收到 ${echo}`);

// 目标每 3s ping，8s 收不到 pong 就会以 4000 断开；能撑过 15s 说明 agent 正确回了 Pong
let earlyClose = null;
wsA.on('close', (code, reason) => { earlyClose = `${code} ${reason}`; });
await wait(TARGET_PING_MS * 5);
check('目标 Ping 被 agent 正确回 Pong（连接保持）', wsA.readyState === WebSocket.OPEN && !earlyClose,
  earlyClose ? `被目标断开: ${earlyClose}` : `15s 后仍在线，目标累计收到 ${targetPongSeen} 个 pong`);
wsA.close();

const wsB = await opened(openWs(`/p/${RULE}/ws/events`, { host: '127.0.0.1' }));
const echo2 = await new Promise((resolve) => {
  wsB.once('message', (d) => resolve(d.toString()));
  wsB.send('path-mode');
});
check('路径模式 WS 收发', echo2 === 'echo:path-mode', `收到 ${echo2}`);
wsB.close();

// 浏览器/客户端不带状态码关闭时，relay 侧看到的是保留码 1005；
// 若原样写上线，对端 ws 库会抛 "invalid status code 1005"（真实场景下表现为目标站报协议错误）
const wsC = await opened(openWs('/ws/events'));
wsC.close();
await wait(500);
check('不带状态码关闭不会把保留码写上线', targetErrors.length === 0, targetErrors.join('; ') || '目标侧无协议错误');

console.log('\n===== 3. WS 子协议协商 =====');
const [subA, subB] = await Promise.all([
  opened(openWs('/ws/events', { protocols: ['codeg-v1', `${TOKEN_PROTO}.aaa`] })),
  opened(openWs('/ws/events', { protocols: ['codeg-v1', `${TOKEN_PROTO}.bbb`] })),
]);
check('目标选中的子协议回显给浏览器', subA.protocol === `${TOKEN_PROTO}.aaa`, `拿到 "${subA.protocol}"`);
check('并发连接的子协议互不串台', subA.protocol !== subB.protocol && subB.protocol === `${TOKEN_PROTO}.bbb`,
  `A="${subA.protocol}" B="${subB.protocol}"`);
subA.close(); subB.close();

console.log('\n===== 4. relay 侧 WS 保活 =====');
let relayPings = 0;
const wsK = await opened(openWs('/ws/events', { onPing: () => { relayPings += 1; } }));
await wait(KEEPALIVE_MS * 3);
check('relay 主动 ping 浏览器侧连接', relayPings >= 1, `${KEEPALIVE_MS * 3}ms 内收到 ${relayPings} 个 ping`);
check('保活期间连接未被误杀', wsK.readyState === WebSocket.OPEN);
wsK.close();

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
process.exit(failed.length ? 1 : 0);
