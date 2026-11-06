/** Synchronous slot reservation with FIFO waiters and round-robin tie breaking. */
export class Scheduler {
  constructor({ listAccounts, settings, recover, now = () => Date.now() }) {
    this.listAccounts = listAccounts;
    this.settings = settings;
    this.recover = recover;
    this.now = now;
    this.counts = new Map();
    this.queue = [];
    this.cursor = 0;
  }

  inFlight(id) { return this.counts.get(id) || 0; }
  stats() { return { queued: this.queue.length, inFlight: [...this.counts.values()].reduce((sum, n) => sum + n, 0) }; }

  acquire(excluded = new Set()) {
    this.recover();
    const settings = this.settings();
    const account = this.pick(excluded);
    if (account) return Promise.resolve(this.reserve(account));
    const accounts = this.listAccounts();
    const busyReady = accounts.some((a) => a.enabled && a.state === 'ready' && this.inFlight(a.id) >= a.concurrency && !excluded.has(a.id));
    if (!busyReady || settings.queueTimeoutSeconds === 0) return Promise.reject(this.unavailable(accounts));
    if (this.queue.length >= settings.maxQueue) return Promise.reject(this.unavailable(accounts, 'All accounts are busy'));
    return new Promise((resolve, reject) => {
      const waiter = { excluded, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.queue = this.queue.filter((item) => item !== waiter);
        reject(this.unavailable(this.listAccounts(), 'All accounts are busy'));
      }, settings.queueTimeoutSeconds * 1000);
      this.queue.push(waiter);
    });
  }

  pick(excluded) {
    const candidates = this.listAccounts().filter((a) => a.enabled && a.state === 'ready' && !excluded.has(a.id) && this.inFlight(a.id) < a.concurrency);
    if (!candidates.length) return null;
    const min = Math.min(...candidates.map((a) => this.inFlight(a.id) / a.concurrency));
    const tied = candidates.filter((a) => this.inFlight(a.id) / a.concurrency === min);
    const account = tied[this.cursor % tied.length];
    this.cursor = (this.cursor + 1) % Math.max(1, candidates.length);
    return account;
  }

  reserve(account) {
    this.counts.set(account.id, this.inFlight(account.id) + 1);
    let released = false;
    return { accountId: account.id, release: () => {
      if (released) return;
      released = true;
      const next = this.inFlight(account.id) - 1;
      if (next > 0) this.counts.set(account.id, next); else this.counts.delete(account.id);
      this.wake();
    } };
  }

  // FIFO, but a waiter whose retry excludes the only free account must not block the waiters behind it.
  wake() {
    this.recover();
    for (let i = 0; i < this.queue.length;) {
      const waiter = this.queue[i];
      const account = this.pick(waiter.excluded);
      if (!account) { i += 1; continue; }
      this.queue.splice(i, 1); clearTimeout(waiter.timer); waiter.resolve(this.reserve(account));
    }
  }

  unavailable(accounts, message = null) {
    if (message) return Object.assign(new Error(message), { status: 503, type: 'unavailable_error' });
    const cooldown = accounts.filter((a) => a.enabled && a.state === 'cooldown').length;
    const disabled = accounts.filter((a) => !a.enabled || a.state === 'disabled').length;
    return Object.assign(new Error(`No available ChatGPT account (${cooldown} cooling down, ${disabled} disabled)`), { status: 503, type: 'unavailable_error' });
  }
}
