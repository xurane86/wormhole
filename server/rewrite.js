// 路径模式下的响应改写。
//
// 把目标网站挂在 /p/{name}/ 前缀下，必然要处理「根路径绝对地址」：
//   - HTML: 注入 <base>，并把 href/src/action="/x" 改写成 /p/{name}/x
//   - CSS : url(/x) → url(/p/{name}/x)
//   - 响应头: Location、Set-Cookie 的 Path
//
// 子域名模式（--root-domain）不需要任何改写，兼容性最好。

const MAX_TEXT_BUFFER = 8 * 1024 * 1024;

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
  return HOP_BY_HOP.has(name.toLowerCase());
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function charsetOf(contentType) {
  const m = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType || '');
  return m ? m[1].trim().toLowerCase() : '';
}

export function canRewriteText(contentType) {
  const cs = charsetOf(contentType);
  return !cs || cs === 'utf-8' || cs === 'utf8' || cs === 'ascii' || cs === 'us-ascii';
}

/** 单个绝对路径加上前缀：已是前缀、协议相对地址、非绝对路径都不动。 */
export function prefixPath(value, prefix) {
  if (!value.startsWith('/') || value.startsWith('//')) return value;
  if (value === prefix || value.startsWith(prefix + '/') || value.startsWith(prefix + '?')) return value;
  return prefix + value;
}

export function rewriteHtml(html, prefix, targetOrigin) {
  let out = html;

  // 1. 注入 <base>，让相对路径也落在前缀下
  if (!/<base\b/i.test(out)) {
    const tag = `<base href="${prefix}/">`;
    if (/<head\b[^>]*>/i.test(out)) {
      out = out.replace(/<head\b[^>]*>/i, (m) => `${m}\n${tag}`);
    } else if (/<html\b[^>]*>/i.test(out)) {
      out = out.replace(/<html\b[^>]*>/i, (m) => `${m}\n${tag}`);
    } else {
      out = tag + out;
    }
  }

  // 2. 根路径绝对地址 —— 属性
  out = out.replace(
    /(\b(?:href|src|action|formaction|poster|data-src|xlink:href)\s*=\s*["'])(\/[^"']*)/gi,
    (m, head, value) => head + prefixPath(value, prefix),
  );

  // 3. srcset
  out = out.replace(/(\bsrcset\s*=\s*["'])([^"']*)(["'])/gi, (m, head, value, tail) => {
    const rewritten = value
      .split(',')
      .map((part) => {
        const t = part.trim();
        return t ? prefixPath(t, prefix) + part.slice(part.indexOf(t) + t.length) : part;
      })
      .join(',');
    return `${head}${rewritten}${tail}`;
  });

  // 4. 内联样式与 <style> 里的 url(/x) / @import "/x"
  out = out.replace(/url\(\s*(["']?)\/(?!\/)/gi, (m, q) => `url(${q}${prefix}/`);
  out = out.replace(/(@import\s+["'])\/(?!\/)/gi, `$1${prefix}/`);

  // 5. 指向目标站点的绝对 URL
  if (targetOrigin) {
    out = out.split(`${targetOrigin}/`).join(`${prefix}/`);
  }

  // 6. meta refresh: content="0;url=/x"
  out = out.replace(/(content\s*=\s*["'][^"']*\burl=)\/(?!\/)/gi, (m, head) => `${head}${prefix}/`);

  return out;
}

export function rewriteCss(css, prefix, targetOrigin) {
  let out = css.replace(/url\(\s*(["']?)\/(?!\/)/gi, (m, q) => `url(${q}${prefix}/`);
  out = out.replace(/(@import\s+["'])\/(?!\/)/gi, `$1${prefix}/`);
  if (targetOrigin) out = out.split(`${targetOrigin}/`).join(`${prefix}/`);
  return out;
}

export function rewriteLocation(location, prefix, targetOrigin) {
  let loc = String(location).trim();
  if (targetOrigin && loc.startsWith(targetOrigin)) {
    loc = loc.slice(targetOrigin.length) || '/';
  }
  if (loc.startsWith('/') && !loc.startsWith('//')) {
    const q = loc.search(/[?#]/);
    const path = q === -1 ? loc : loc.slice(0, q);
    const rest = q === -1 ? '' : loc.slice(q);
    return prefixPath(path, prefix) + rest;
  }
  return location;
}

export function rewriteCookie(cookie, prefix) {
  let out = String(cookie).replace(/;\s*domain=[^;]*/gi, '');
  out = out.replace(/;\s*path=([^;]*)/gi, (m, p) => {
    const path = p.trim();
    if (!path.startsWith('/')) return m;
    if (path === prefix || path.startsWith(prefix + '/')) return m;
    return `; Path=${path === '/' ? `${prefix}/` : prefix + path}`;
  });
  return out;
}

/**
 * 生成响应头。pathMode 为 false 时只去掉 hop-by-hop / content-length。
 */
export function rewriteResponseHeaders(headers, { prefix, targetOrigin, pathMode }) {
  const out = {};
  for (const [rawKey, value] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'content-length') continue;

    if (!pathMode) {
      out[key] = value;
      continue;
    }
    if (key === 'location') {
      out[key] = rewriteLocation(value, prefix, targetOrigin);
    } else if (key === 'set-cookie') {
      const list = Array.isArray(value) ? value : [String(value)];
      out[key] = list.map((c) => rewriteCookie(c, prefix));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 流式改写 HTML：先缓冲整个文档（上限 8MB），再处理。 */
export async function* rewriteHtmlStream(stream, prefix, targetOrigin) {
  const chunks = [];
  let size = 0;
  let overflow = false;

  for await (const chunk of stream) {
    if (overflow) {
      yield chunk;
      continue;
    }
    size += chunk.length;
    if (size > MAX_TEXT_BUFFER) {
      overflow = true;
      for (const c of chunks) yield c;
      chunks.length = 0;
      yield chunk;
      continue;
    }
    chunks.push(chunk);
  }
  if (!overflow) {
    const html = Buffer.concat(chunks).toString('utf8');
    yield Buffer.from(rewriteHtml(html, prefix, targetOrigin), 'utf8');
  }
}

export async function* rewriteCssStream(stream, prefix, targetOrigin) {
  const chunks = [];
  let size = 0;
  let overflow = false;

  for await (const chunk of stream) {
    if (overflow) {
      yield chunk;
      continue;
    }
    size += chunk.length;
    if (size > MAX_TEXT_BUFFER) {
      overflow = true;
      for (const c of chunks) yield c;
      chunks.length = 0;
      yield chunk;
      continue;
    }
    chunks.push(chunk);
  }
  if (!overflow) {
    const css = Buffer.concat(chunks).toString('utf8');
    yield Buffer.from(rewriteCss(css, prefix, targetOrigin), 'utf8');
  }
}
