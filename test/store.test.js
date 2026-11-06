import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('account tokens are encrypted in SQLite and can be rotated', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-'));
  const path = join(directory, 'test.sqlite');
  const key = Buffer.alloc(32, 7);
  const store = new Store(path, key);
  t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });

  const account = store.addAccount({ label: 'test account', token: 'secret-access-token' });
  const disk = readFileSync(path).toString('latin1');
  assert.equal(disk.includes('secret-access-token'), false);
  assert.equal(store.getAccount(account.id).token, 'secret-access-token');
  store.updateAccount(account.id, { token: 'rotated-token' });
  assert.equal(store.getAccount(account.id).token, 'rotated-token');
});

test('settings and account proxy references persist', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-'));
  const store = new Store(join(directory, 'test.sqlite'), Buffer.alloc(32, 9));
  t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const proxy = store.saveProxy({ label: 'edge', url: 'http://127.0.0.1:8081' });
  const account = store.addAccount({ label: 'proxied', token: 'token', proxyId: proxy.id });
  store.setSettings({ defaultProxyId: null, exitProxyId: proxy.id });
  store.setSettings({ tencentProxyId: proxy.id });
  store.setSettings({ defaultProxyId: 'other' });
  assert.equal(store.getAccount(account.id).proxy_id, proxy.id);
  assert.equal(store.settings().exitProxyId, proxy.id);
  assert.equal(store.settings().tencentProxyId, proxy.id);
  assert.equal(store.settings().defaultProxyId, 'other');
  assert.equal(readFileSync(join(directory, 'test.sqlite')).toString('latin1').includes('127.0.0.1:8081'), false);
});

test('an empty account proxy selection is stored as NULL', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-'));
  const store = new Store(join(directory, 'test.sqlite'), Buffer.alloc(32, 5));
  t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const account = store.addAccount({ label: 'direct', token: 'token', proxyId: '' });
  assert.equal(store.getAccount(account.id).proxy_id, null);
});

test('cooldown accounts recover after expiry without clearing the error count', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-'));
  const store = new Store(join(directory, 'test.sqlite'), Buffer.alloc(32, 4));
  t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const account = store.addAccount({ label: 'limited', token: 'token' });
  store.recordAccountError(account.id, 'upstream failed');
  store.recoverCooldownAccounts(new Date(Date.now() + 11 * 60 * 1000));
  assert.equal(store.listAccounts()[0].state, 'ready');
  assert.equal(store.listAccounts()[0].consecutiveErrors, 1);
});

test('error thresholds, disable, success reset, and settings defaults/validation', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-'));
  const store = new Store(join(directory, 'test.sqlite'), Buffer.alloc(32, 4));
  t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const account = store.addAccount({ label: 'limited', token: 'token' });
  assert.equal(store.settings().cooldownMinutes, 10);
  assert.throws(() => store.setSettings({ maxQueue: 10001 }), /maxQueue/);
  store.setSettings({ cooldownMinutes: 0, maxConsecutiveErrors: 2 });
  store.recordAccountError(account.id, 'first');
  assert.equal(store.listAccounts()[0].state, 'ready');
  store.recordAccountError(account.id, 'second');
  assert.equal(store.listAccounts()[0].enabled, false);
  assert.equal(store.listAccounts()[0].state, 'disabled');
  assert.equal(store.listAccounts()[0].consecutiveErrors, 2);
  store.updateAccount(account.id, { enabled: true });
  assert.equal(store.listAccounts()[0].consecutiveErrors, 0);
  store.setSettings({ maxConsecutiveErrors: 0, cooldownMinutes: 0 });
  store.recordAccountError(account.id, 'third');
  assert.equal(store.listAccounts()[0].enabled, true);
  assert.equal(store.listAccounts()[0].state, 'ready');
  assert.equal(store.listAccounts()[0].consecutiveErrors, 1);
  store.recordAccountSuccess(account.id);
  assert.equal(store.listAccounts()[0].consecutiveErrors, 0);
  store.updateAccount(account.id, { enabled: false });
  store.recordAccountError(account.id, 'in-flight request failed');
  assert.equal(store.listAccounts()[0].enabled, false);
});

test('legacy account states migrate without losing cooldown timestamps', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-'));
  const path = join(directory, 'test.sqlite');
  const key = Buffer.alloc(32, 3);
  const first = new Store(path, key);
  const limited = first.addAccount({ label: 'limited', token: 'one' });
  const expired = first.addAccount({ label: 'expired', token: 'two' });
  const deadline = new Date(Date.now() + 60000).toISOString();
  first.db.prepare("UPDATE accounts SET state='rate_limited', rate_limited_until=? WHERE id=?").run(deadline, limited.id);
  first.db.prepare("UPDATE accounts SET state='auth_error', enabled=1 WHERE id=?").run(expired.id);
  first.db.close();
  const migrated = new Store(path, key);
  t.after(() => { migrated.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const rows = migrated.listAccounts();
  assert.equal(rows.find((row) => row.id === limited.id).state, 'cooldown');
  assert.equal(rows.find((row) => row.id === limited.id).cooldownUntil, deadline);
  assert.equal(rows.find((row) => row.id === expired.id).state, 'disabled');
  assert.equal(rows.find((row) => row.id === expired.id).enabled, false);
});

test('legacy accounts gain concurrency one and the old global setting is removed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'media-gateway-'));
  const path = join(directory, 'test.sqlite');
  const key = Buffer.alloc(32, 2);
  const first = new Store(path, key);
  first.addAccount({ label: 'legacy', token: 'token' });
  first.db.exec('ALTER TABLE accounts DROP COLUMN concurrency');
  first.db.prepare("INSERT INTO settings(key, value) VALUES('accountConcurrency', '4')").run();
  first.db.close();
  const migrated = new Store(path, key);
  t.after(() => { migrated.db.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(migrated.listAccounts()[0].concurrency, 1);
  assert.equal(Object.hasOwn(migrated.settings(), 'accountConcurrency'), false);
  assert.equal(migrated.db.prepare("SELECT count(*) AS count FROM settings WHERE key='accountConcurrency'").get().count, 0);
});
