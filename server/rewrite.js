// 响应头处理：仅去掉 hop-by-hop 头与 content-length，其余原样透传。
// 说明：路径模式（把应用挂在 /p/{name}/ 下）已移除，
// 因此不再需要改写 Location、Set-Cookie 的 Path、HTML 绝对路径与 CSS url()。
// 目前只使用子域名模式（--root-domain），响应体与响应头原样转发，兼容性最好。

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isHopByHop(name) {
  return HOP_BY_HOP.has(String(name).toLowerCase());
}

export function rewriteResponseHeaders(headers) {
  const out = {};
  for (const [rawKey, value] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'content-length') continue;
    out[key] = value;
  }
  return out;
}
