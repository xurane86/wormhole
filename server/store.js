// 规则存储：JSON 文件持久化。
// 每条规则 = 一个对外入口（/p/{name}/ 或 {name}.{ROOT_DOMAIN}），
// agent 用规则自带的 token 连入。token 只在创建/轮换时返回给管理端。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashPassword(password) {
  return crypto.createHash('sha256').update(`wormhole:${password}`).digest('hex');
}

export class RuleStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'rules.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.rules = new Map();
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const r of arr) {
        if (r && NAME_RE.test(r.name)) this.rules.set(r.name, r);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[store] 读取 ${this.file} 失败:`, err.message);
    }
  }

  _save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.rules.values()], null, 2));
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }

  /** 对外展示用的规则（不含 token / 密码哈希）。 */
  list() {
    return [...this.rules.values()].map((r) => this._public(r));
  }

  /** 管理端可见的规则（含 token，用于生成 agent 启动命令）。 */
  listForAdmin() {
    return [...this.rules.values()].map((r) => ({ ...this._public(r), token: r.token }));
  }

  get(name) {
    const r = this.rules.get(name);
    return r ? { ...r } : null;
  }

  _public(r) {
    const { token, accessPassHash, ...rest } = r;
    return { ...rest, accessProtected: !!accessPassHash };
  }

  create({ name, description = '', enabled = true, accessPassword = '' }) {
    if (!NAME_RE.test(name)) throw new Error('规则名只能包含小写字母、数字和连字符，长度 1-63，且以字母或数字开头结尾');
    if (this.rules.has(name)) throw new Error(`规则 "${name}" 已存在`);
    const now = Date.now();
    const rule = {
      name,
      description: String(description || '').slice(0, 200),
      enabled: enabled !== false,
      token: newToken(),
      accessPassHash: accessPassword ? hashPassword(accessPassword) : '',
      createdAt: now,
      updatedAt: now,
      stats: { requests: 0, bytes: 0, lastRequestAt: null },
    };
    this.rules.set(name, rule);
    this._save();
    return { ...this._public(rule), token: rule.token };
  }

  update(name, patch = {}) {
    const r = this.rules.get(name);
    if (!r) return null;
    if (patch.description !== undefined) r.description = String(patch.description || '').slice(0, 200);
    if (typeof patch.enabled === 'boolean') r.enabled = patch.enabled;
    if (patch.accessPassword !== undefined) {
      r.accessPassHash = patch.accessPassword ? hashPassword(String(patch.accessPassword)) : '';
    }
    if (patch.rotateToken) r.token = newToken();
    r.updatedAt = Date.now();
    this._save();
    return { ...this._public(r), token: r.token };
  }

  remove(name) {
    const ok = this.rules.delete(name);
    if (ok) this._save();
    return ok;
  }

  /** 校验 agent 的接入凭据：规则 token，或全局共享密钥（sha256(name::secret)）。 */
  authenticate(name, token, sharedSecret = '') {
    const r = this.rules.get(name);
    if (!r || !token) return null;
    const given = Buffer.from(String(token));
    if (given.length === Buffer.byteLength(r.token) && crypto.timingSafeEqual(given, Buffer.from(r.token))) {
      return r;
    }
    if (sharedSecret) {
      const derived = crypto.createHash('sha256').update(`${name}::${sharedSecret}`).digest('hex');
      const d = Buffer.from(derived);
      if (given.length === d.length && crypto.timingSafeEqual(given, d)) return r;
    }
    return null;
  }

  bumpStats(name, bytesIn, bytesOut) {
    const r = this.rules.get(name);
    if (!r) return;
    r.stats.requests += 1;
    r.stats.bytes += (bytesIn || 0) + (bytesOut || 0);
    r.stats.lastRequestAt = Date.now();
    this._dirty = true;
    // 每 20 次请求落盘一次，避免高频写文件
    if (r.stats.requests % 20 === 0) this._save();
  }

  flush() {
    if (this._dirty) this._save();
  }
}
