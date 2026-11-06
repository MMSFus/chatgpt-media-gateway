import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

function setup(count = 1, overrides = {}, capacities = []) {
  const accounts = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, enabled: true, state: 'ready', concurrency: capacities[i] || 1 }));
  const settings = { queueTimeoutSeconds: 1, maxQueue: 100, ...overrides };
  return { accounts, scheduler: new Scheduler({ listAccounts: () => accounts, settings: () => settings, recover() {} }) };
}

test('per-account limit queues FIFO and wakes a waiter after release', async () => {
  const { scheduler } = setup();
  const a = await scheduler.acquire();
  const waiting = scheduler.acquire();
  assert.equal(scheduler.stats().queued, 1);
  a.release();
  const c = await waiting;
  assert.equal(c.accountId, 'a0');
  c.release();
  assert.deepEqual(scheduler.stats(), { queued: 0, inFlight: 0 });
});

test('queue timeout and full queue reject with 503', async () => {
  const { scheduler } = setup(1, { queueTimeoutSeconds: 0.02, maxQueue: 0 });
  const a = await scheduler.acquire();
  await assert.rejects(scheduler.acquire(), (error) => error.status === 503 && error.message === 'All accounts are busy');
  a.release();
  const { scheduler: timeout } = setup(1, { queueTimeoutSeconds: 0.02 });
  const c = await timeout.acquire();
  await assert.rejects(timeout.acquire(), (error) => error.status === 503);
  c.release();
});

test('default one-slot accounts queue a second request', async () => {
  const { scheduler } = setup();
  const first = await scheduler.acquire();
  const waiting = scheduler.acquire();
  assert.equal(scheduler.stats().queued, 1);
  first.release();
  assert.equal((await waiting).accountId, 'a0');
});

test('a concurrency two account reserves two simultaneous requests', async () => {
  const { scheduler } = setup(1, {}, [2]);
  const slots = await Promise.all([scheduler.acquire(), scheduler.acquire()]);
  assert.deepEqual(slots.map((slot) => slot.accountId), ['a0', 'a0']);
  slots.forEach((slot) => slot.release());
});

test('normalized load gives concurrency two accounts two of three reservations', async () => {
  const { scheduler } = setup(2, {}, [2, 1]);
  const slots = await Promise.all(Array.from({ length: 3 }, () => scheduler.acquire()));
  assert.deepEqual(slots.reduce((counts, slot) => ({ ...counts, [slot.accountId]: (counts[slot.accountId] || 0) + 1 }), {}), { a0: 2, a1: 1 });
  slots.forEach((slot) => slot.release());
});

test('raising an account limit wakes queued work immediately', async () => {
  const { accounts, scheduler } = setup();
  const first = await scheduler.acquire();
  const waiting = scheduler.acquire();
  accounts[0].concurrency = 2;
  scheduler.wake();
  const second = await waiting;
  assert.equal(second.accountId, first.accountId);
  first.release(); second.release();
});

test('a queued retry that excludes the freed account does not block later waiters', async () => {
  const { scheduler } = setup(2, { queueTimeoutSeconds: 5 });
  const a0 = await scheduler.acquire();
  const a1 = await scheduler.acquire();
  // Retry that already failed on a0 waits for a1; a plain request queues behind it.
  const retry = scheduler.acquire(new Set(['a0']));
  const plain = scheduler.acquire();
  assert.equal(scheduler.stats().queued, 2);
  a0.release();
  const got = await plain;
  assert.equal(got.accountId, 'a0');
  assert.equal(scheduler.stats().queued, 1);
  a1.release();
  const retried = await retry;
  assert.equal(retried.accountId, 'a1');
  retried.release();
  got.release();
  assert.deepEqual(scheduler.stats(), { queued: 0, inFlight: 0 });
});
