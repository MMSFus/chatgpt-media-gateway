import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_SETTINGS = Object.freeze({ cooldownMinutes: 10, maxConsecutiveErrors: 3, maxAttempts: 3, queueTimeoutSeconds: 60, maxQueue: 100 });
const SETTINGS_RANGES = { cooldownMinutes: [0, 1440], maxConsecutiveErrors: [0, 100], maxAttempts: [1, 10], queueTimeoutSeconds: [0, 600], maxQueue: [0, 10000] };

/** Encrypts a secret with a fresh AES-GCM nonce before it enters SQLite. */
function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Opens an AES-256-GCM value produced by seal; a wrong key or modified record fails closed. */
function open(value, key) {
  const packed = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}

export class Store {
  /** Opens the SQLite store, creates its schema, and keeps account/proxy secrets encrypted with key. */
  constructor(path, key) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.key = key;
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token_enc TEXT NOT NULL,
        device_id TEXT NOT NULL,
        proxy_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'ready',
        last_error TEXT NOT NULL DEFAULT '',
        rate_limited_until TEXT,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        concurrency INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY(proxy_id) REFERENCES proxies(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS proxies (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        url_enc TEXT NOT NULL,
        next_proxy_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(next_proxy_id) REFERENCES proxies(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        route TEXT NOT NULL,
        account_id TEXT,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        error TEXT NOT NULL DEFAULT ''
      );
    `);
    const accountColumns = this.db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name);
    if (!accountColumns.includes('rate_limited_until')) this.db.exec('ALTER TABLE accounts ADD COLUMN rate_limited_until TEXT');
    if (!accountColumns.includes('consecutive_errors')) this.db.exec('ALTER TABLE accounts ADD COLUMN consecutive_errors INTEGER NOT NULL DEFAULT 0');
    if (!accountColumns.includes('concurrency')) this.db.exec('ALTER TABLE accounts ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1');
    this.db.prepare("DELETE FROM settings WHERE key='accountConcurrency'").run();
    this.db.exec("UPDATE accounts SET state='cooldown' WHERE state='rate_limited'; UPDATE accounts SET state='disabled', enabled=0 WHERE state='auth_error';");
    this.inFlight = () => 0;
  }

  /** Returns global and service-specific proxy selectors; unset selectors resolve to defaults. */
  settings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const values = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    const result = { defaultProxyId: values.defaultProxyId ?? null, exitProxyId: values.exitProxyId ?? null, tencentProxyId: values.tencentProxyId ?? null };
    for (const key of Object.keys(SETTINGS_RANGES)) result[key] = values[key] ?? DEFAULT_SETTINGS[key];
    return result;
  }

  /** Atomically updates supplied proxy selectors while preserving omitted settings. */
  setSettings(settings) {
    for (const [key, [min, max]] of Object.entries(SETTINGS_RANGES)) {
      if (Object.hasOwn(settings, key) && (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max)) throw Object.assign(new Error(`${key} must be an integer from ${min} to ${max}`), { status: 400 });
    }
    const upsert = this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    try {
      this.db.exec('BEGIN');
      for (const key of ['defaultProxyId', 'exitProxyId', 'tencentProxyId']) {
        if (Object.hasOwn(settings, key)) upsert.run(key, JSON.stringify(settings[key] || null));
      }
      for (const key of Object.keys(SETTINGS_RANGES)) if (Object.hasOwn(settings, key)) upsert.run(key, JSON.stringify(settings[key]));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.settings();
  }

  /** Lists operational account metadata without decrypting or returning access tokens. */
  listAccounts() {
    return this.db.prepare(`SELECT id, label, proxy_id AS proxyId, enabled, state, last_error AS lastError, created_at AS createdAt,
      consecutive_errors AS consecutiveErrors, rate_limited_until AS cooldownUntil, concurrency FROM accounts ORDER BY created_at`)
      .all().map((row) => ({ ...row, enabled: Boolean(row.enabled), cooldownUntil: row.cooldownUntil || null, inFlight: this.inFlight(row.id) }));
  }

  /** Loads one account and decrypts its token for an upstream request only. */
  getAccount(id) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, enabled: Boolean(row.enabled), token: open(row.token_enc, this.key) };
  }

  /** Adds an enabled account with an encrypted token; blank proxy selections become SQL NULL. */
  addAccount({ label, token, proxyId = null, concurrency = 1 }) {
    const id = randomUUID();
    const normalizedProxyId = typeof proxyId === 'string' && proxyId.trim() === '' ? null : proxyId;
    this.db.prepare(`INSERT INTO accounts(id, label, token_enc, device_id, proxy_id, concurrency, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(id, label.trim(), seal(token.trim(), this.key), randomUUID(), normalizedProxyId, concurrency, new Date().toISOString());
    return this.listAccounts().find((account) => account.id === id);
  }

  /** Updates account metadata, optionally rotates its token, and re-arms recovered accounts. */
  updateAccount(id, fields) {
    const current = this.getAccount(id);
    if (!current) return null;
    const values = {
      label: fields.label === undefined ? current.label : fields.label.trim(),
      token: fields.token === undefined || fields.token === '' ? current.token : fields.token.trim(),
      proxyId: fields.proxyId === undefined ? current.proxy_id : fields.proxyId || null,
      enabled: fields.enabled === undefined ? current.enabled : Boolean(fields.enabled),
      concurrency: fields.concurrency === undefined ? current.concurrency : fields.concurrency,
    };
    const rotated = fields.token !== undefined && fields.token !== '';
    this.db.prepare(`UPDATE accounts SET label=?, token_enc=?, proxy_id=?, enabled=?, concurrency=?, state=?, last_error=?, consecutive_errors=?, rate_limited_until=? WHERE id=?`)
      .run(values.label, seal(values.token, this.key), values.proxyId, values.enabled ? 1 : 0,
        values.concurrency,
        values.enabled && (rotated || fields.enabled === true) ? 'ready' : current.state,
        values.enabled && (rotated || fields.enabled === true) ? '' : current.last_error,
        values.enabled && (rotated || fields.enabled === true) ? 0 : current.consecutive_errors,
        values.enabled && (rotated || fields.enabled === true) ? null : current.rate_limited_until, id);
    return this.listAccounts().find((account) => account.id === id);
  }

  /** Deletes an account and reports whether a row existed. */
  deleteAccount(id) {
    return this.db.prepare('DELETE FROM accounts WHERE id=?').run(id).changes > 0;
  }

  /** Records a short upstream health state without storing request or token contents. */
  recordAccountError(id, error, settings = this.settings(), now = new Date()) {
    const row = this.db.prepare('SELECT consecutive_errors, enabled FROM accounts WHERE id=?').get(id);
    if (!row) return;
    const count = row.consecutive_errors + 1;
    const disabled = settings.maxConsecutiveErrors > 0 && count >= settings.maxConsecutiveErrors;
    const until = !disabled && settings.cooldownMinutes > 0 ? new Date(now.getTime() + settings.cooldownMinutes * 60000).toISOString() : null;
    const summary = disabled ? `连续 ${count} 次错误自动停用：${error}` : error;
    this.db.prepare('UPDATE accounts SET consecutive_errors=?, enabled=?, state=?, last_error=?, rate_limited_until=? WHERE id=?')
      .run(count, disabled ? 0 : row.enabled, disabled ? 'disabled' : until ? 'cooldown' : 'ready', summary.slice(0, 500), until, id);
  }

  recordAccountSuccess(id) {
    this.db.prepare("UPDATE accounts SET consecutive_errors=0, state='ready', last_error='', rate_limited_until=NULL WHERE id=? AND enabled=1").run(id);
  }

  setAccountState(id, state, error = '') {
    this.db.prepare('UPDATE accounts SET state=?, last_error=? WHERE id=?').run(state, error.slice(0, 500), id);
  }

  recoverCooldownAccounts(now = new Date()) {
    this.db.prepare(`UPDATE accounts SET state='ready', last_error='', rate_limited_until=NULL
      WHERE state='cooldown' AND rate_limited_until IS NOT NULL AND rate_limited_until <= ? AND enabled=1`)
      .run(now.toISOString());
  }

  /** Lists proxy definitions for authenticated administration, decrypting URLs for route construction. */
  listProxies() {
    return this.db.prepare(`SELECT id, label, url_enc, next_proxy_id AS nextProxyId, created_at AS createdAt
      FROM proxies ORDER BY created_at`).all().map(({ url_enc, ...proxy }) => ({ ...proxy, url: open(url_enc, this.key) }));
  }

  /** Loads one proxy definition for routing or an authenticated admin edit. */
  getProxy(id) {
    const proxy = this.db.prepare('SELECT id, label, url_enc, next_proxy_id AS nextProxyId FROM proxies WHERE id=?').get(id);
    return proxy ? { id: proxy.id, label: proxy.label, url: open(proxy.url_enc, this.key), nextProxyId: proxy.nextProxyId } : null;
  }

  /** Inserts or updates a proxy while keeping credentials encrypted at rest. */
  saveProxy({ id = randomUUID(), label, url, nextProxyId = null }) {
    this.db.prepare(`INSERT INTO proxies(id, label, url_enc, next_proxy_id, created_at) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, url_enc=excluded.url_enc, next_proxy_id=excluded.next_proxy_id`)
      .run(id, label.trim(), seal(url.trim(), this.key), nextProxyId || null, new Date().toISOString());
    return this.getProxy(id);
  }

  /** Deletes a proxy; SQLite clears account and next-hop references using foreign keys. */
  deleteProxy(id) {
    return this.db.prepare('DELETE FROM proxies WHERE id=?').run(id).changes > 0;
  }

  /** Stores request metadata only; callers must not pass prompts, bodies, or upstream response text. */
  logRequest({ route, accountId = null, status, durationMs, error = '' }) {
    this.db.prepare(`INSERT INTO request_log(created_at, route, account_id, status, duration_ms, error)
      VALUES(?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), route, accountId, status, durationMs, error.slice(0, 500));
  }

  /** Returns the newest bounded request log page for the admin console. */
  recentLogs(limit = 100) {
    return this.db.prepare(`SELECT id, created_at AS createdAt, route, account_id AS accountId, status, duration_ms AS durationMs, error
      FROM request_log ORDER BY id DESC LIMIT ?`).all(limit);
  }
}
