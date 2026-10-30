// wormhole server 主入口
// 用法: node server/index.js --port 7800 --secret <shared-secret> [--data ./relay-data] [--root-domain example.com] [--admin-user u --admin-pass p]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RuleStore } from './store.js';
import { AgentHub } from './hub.js';
import {
  rewriteHtmlStream,
  rewriteCssStream,
  rewriteResponseHeaders,
  canRewriteText,
} from './rewrite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
const args = process.argv.slice(2);
function arg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const PORT = parseInt(arg('--port', '7800'), 10);
const SECRET = arg('--secret', process.env.RELAY_SECRET || '');
const DATA_DIR = arg('--data', './relay-data');
const ROOT_DOMAIN = arg('--root-domain', ''); // 开启子域名模式，如 relay.example.com 的根 example.com
const ADMIN_USER = arg('--admin-user', '');
const ADMIN_PASS = arg('--admin-pass', '');

if (!SECRET) {
  console.error('缺少 --secret（server 与 agent 的共享密钥），或环境变量 RELAY_SECRET');
  process.exit(1);
}

const store = new RuleStore(DATA_DIR);
const hub = new AgentHub();

// 鉴权：优先每规则独立 token，其次共享密钥派生 token（见 store.authenticate）
import crypto from 'node:crypto';
const expectedToken = (name) =>
  crypto.createHash('sha256').update(`${name}::${SECRET}`).digest('hex');

// ---------- 管理页 Basic Auth ----------
function checkAdmin(req) {
  if (!ADMIN_USER) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === ADMIN_USER && p === ADMIN_PASS;
}

// ---------- 静态管理页 ----------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- HTTP 处理 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathName = decodeURIComponent(url.pathname);

  // 管理 API / 页面
  if (pathName === '/admin' || pathName.startsWith('/admin/') || pathName === '/style.css' || pathName === '/api/rules' || pathName.startsWith('/api/rules/')) {
    if (!checkAdmin(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="relay admin"' });
      return res.end('401 Unauthorized');
    }
    return handleAdmin(req, res, pathName);
  }

  // 管理端 token 计算接口（agent 侧也可自算，这里仅供调试）
  if (pathName.startsWith('/api/agent-token/')) {
    const name = pathName.split('/')[3];
    if (!store.get(name)) return sendJSON(res, 404, { error: '规则不存在' });
    return sendJSON(res, 200, { token: store.get(name).token || expectedToken(name) });
  }

  // 路径模式转发: /p/{name}/...
  let ruleName = null, innerPath = '/';
  const m = pathName.match(/^\/p\/([a-z0-9][a-z0-9-]{1,62})(\/.*)?$/i);
  if (m) {
    ruleName = m[1];
    innerPath = m[2] || '/';
  } else if (ROOT_DOMAIN) {
    // 子域名模式: {name}.root
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (host.toLowerCase() !== ROOT_DOMAIN.toLowerCase() && host.endsWith('.' + ROOT_DOMAIN.toLowerCase())) {
      ruleName = host.slice(0, -(ROOT_DOMAIN.length + 1));
      innerPath = pathName;
    }
  }

  if (ruleName) {
    // m 命中 = 路径模式（/p/{name}/...）；子域名模式在根路径上，不需要改写
    return handleForward(req, res, ruleName, innerPath + url.search, Boolean(m));
  }

  // 根路径 → 简介页
  if (pathName === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>wormhole</title>
<body style="font-family:system-ui;max-width:640px;margin:60px auto">
<h2>wormhole 运行中</h2>
<p>通用内网反向代理 relay。访问 <a href="/admin">/admin</a> 管理路由规则。</p>
<p>路径转发格式：<code>http://本机:${PORT}/p/{规则名}/路径</code></p>
${ROOT_DOMAIN ? `<p>子域名模式已启用：{规则名}.${ROOT_DOMAIN}</p>` : ''}
</body>`);
  }

  res.writeHead(404);
  res.end('404 Not Found');
});

// ---------- 管理 API ----------
async function handleAdmin(req, res, pathName) {
  // 页面
  if (req.method === 'GET' && (pathName === '/admin' || pathName === '/admin/')) {
    const file = path.join(PUBLIC_DIR, 'admin.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return res.end(fs.readFileSync(file));
  }
  if (req.method === 'GET' && (pathName === '/style.css' || pathName === '/admin/style.css')) {
    const file = path.join(PUBLIC_DIR, 'style.css');
    res.writeHead(200, { 'Content-Type': MIME['.css'] });
    return res.end(fs.readFileSync(file));
  }
  if (req.method === 'GET' && pathName.startsWith('/admin/assets/')) {
    const file = path.join(PUBLIC_DIR, path.basename(pathName));
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); return res.end();
  }

  if (pathName === '/api/rules') {
    if (req.method === 'GET') {
      const rules = store.listForAdmin().map(r => ({ ...r, online: hub.isOnline(r.name) }));
      return sendJSON(res, 200, { rules, rootDomain: ROOT_DOMAIN });
    }
    if (req.method === 'POST') {
      try {
        const data = JSON.parse(await readBody(req));
        const rule = store.create(data);
        return sendJSON(res, 200, rule);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }
  }

  const m = pathName.match(/^\/api\/rules\/([^/]+)$/);
  if (m) {
    const name = m[1];
    if (req.method === 'PATCH') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJSON(res, 400, { error: '无效的 JSON 请求体' });
      }
      const rule = store.update(name, body);
      if (!rule) return sendJSON(res, 404, { error: '规则不存在' });
      return sendJSON(res, 200, rule);
    }
    if (req.method === 'DELETE') {
      const ok = store.remove(name);
      return sendJSON(res, ok ? 200 : 404, { ok });
    }
  }

  res.writeHead(404); res.end();
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- 转发 ----------
async function handleForward(req, res, ruleName, innerPath, pathMode = true) {
  const rule = store.get(ruleName);
  if (!rule) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(noticePage('规则不存在', `relay 中没有名为 "${ruleName}" 的转发规则，请在 /admin 中创建。`));
  }
  if (!rule.enabled) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(noticePage('规则已停用', `规则 "${ruleName}" 当前处于停用状态。`));
  }

  // 收集请求体（普通请求先缓存；超大体型场景可改为流式，此处取简单可靠方案）
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await readBody(req); } catch { }
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['accept-encoding']; // 避免 agent 侧压缩后 HTML 改写失效

  const fwd = hub.begin(ruleName, {
    method: req.method,
    url: innerPath,
    headers,
    bytesIn: body?.length || 0,
  });

  // 客户端断开时中止上游请求
  req.on('close', () => { if (!res.writableEnded) fwd.abort?.(); });

  // 发送请求体
  if (body?.length) fwd.write(body);
  fwd.end();

  try {
    const head = await fwd.response;

    // 路径模式：Location / Set-Cookie 的 Path / HTML 绝对路径 / CSS url() 全部改写；
    // 子域名模式：只去 hop-by-hop / content-length，body 与 header 原样。
    // 注意：目标应用自身 JS 发起的绝对路径请求（如 fetch("/api/x")）无法在 relay 层改写，
    // SPA 需应用侧配置 basePath（如 Next.js 的 basePath: '/p/{name}'）才能在路径模式完全可用。
    const prefix = `/p/${ruleName}`;
    const outHeaders = rewriteResponseHeaders(head.headers, {
      prefix,
      targetOrigin: head.targetOrigin,
      pathMode,
    });
    const contentType = String(outHeaders['content-type'] || '');
    const needHtmlRewrite = pathMode && /text\/html/i.test(contentType) && canRewriteText(contentType);
    const needCssRewrite = pathMode && /text\/css/i.test(contentType) && canRewriteText(contentType);
    res.writeHead(head.status, outHeaders);
    if (needHtmlRewrite) {
      for await (const chunk of rewriteHtmlStream(head.body, prefix, head.targetOrigin)) res.write(chunk);
    } else if (needCssRewrite) {
      for await (const chunk of rewriteCssStream(head.body, prefix, head.targetOrigin)) res.write(chunk);
    } else {
      for await (const chunk of head.body) res.write(chunk);
    }
    res.end();
    store.bumpStats(ruleName, fwd.stats.bytesIn, fwd.stats.bytesOut);
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    const code = e.code === 'AGENT_OFFLINE' ? 503 : 502;
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(noticePage('转发失败', e.message));
  }
}

function noticePage(title, msg) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:560px;margin:80px auto;text-align:center">
<h2>${title}</h2><p style="color:#666">${msg}</p><p><a href="/admin">返回管理页</a></p></body>`;
}

// ---------- Agent WebSocket 接入 ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/agent/ws') { socket.destroy(); return; }

  const name = url.searchParams.get('name') || '';
  const token = url.searchParams.get('token') || '';
  if (!store.authenticate(name, token, SECRET)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (sock) => {
    const conn = hub.register(name, sock);
    console.log(`[agent] "${name}" 已连接 (${new Date().toISOString()})`);
    sock.on('message', (data) => hub.onFrame(conn, data));
    sock.on('close', () => {
      hub.unregister(conn);
      console.log(`[agent] "${name}" 已断开`);
    });
    sock.on('error', () => hub.unregister(conn));

    // 心跳
    const ping = setInterval(() => {
      if (sock.readyState === 1) sock.ping();
      else clearInterval(ping);
    }, 30000);
    sock.on('close', () => clearInterval(ping));
  });
});

// 定期落盘统计
setInterval(() => store.flush(), 60000).unref();

server.listen(PORT, () => {
  console.log(`wormhole server 启动: http://0.0.0.0:${PORT}`);
  console.log(`  管理页:  http://0.0.0.0:${PORT}/admin`);
  console.log(`  转发路径: /p/{规则名}/...`);
  if (ROOT_DOMAIN) console.log(`  子域名模式: {规则名}.${ROOT_DOMAIN}`);
});
