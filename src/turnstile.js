/**
 * Interprets the bounded Turnstile dx instruction format without evaluating JavaScript.
 * The algorithm is adapted from basketikun/chatgpt2api's MIT-licensed utils/turnstile.py
 * (Copyright 2026 kunkun).
 */

const specialStrings = new Map([
  ['window.Math', '[object Math]'],
  ['window.Reflect', '[object Reflect]'],
  ['window.performance', '[object Performance]'],
  ['window.localStorage', '[object Storage]'],
  ['window.Object', 'function Object() { [native code] }'],
  ['window.Reflect.set', 'function set() { [native code] }'],
  ['window.performance.now', 'function () { [native code] }'],
  ['window.Object.create', 'function create() { [native code] }'],
  ['window.Object.keys', 'function keys() { [native code] }'],
  ['window.Math.random', 'function random() { [native code] }'],
]);

const localStorageKeys = [
  'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4',
  'STATSIG_LOCAL_STORAGE_STABLE_ID',
  'client-correlated-secret',
  'oai/apps/capExpiresAt',
  'oai-did',
  'STATSIG_LOCAL_STORAGE_LOGGING_REQUEST',
  'UiState.isNavigationCollapsed.1',
];

/** Models the ordered storage object exposed to the dx program's limited instruction set. */
class OrderedStorage {
  constructor() {
    this.keys = [];
    this.values = new Map();
  }

  add(key, value) {
    if (!this.values.has(key)) this.keys.push(key);
    this.values.set(key, value);
  }
}

/** Converts the challenge's known browser-value placeholders to their protocol string form. */
function challengeString(value) {
  if (value === null || value === undefined) return 'undefined';
  if (typeof value === 'string') return specialStrings.get(value) || value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(',');
  return String(value);
}

/** XORs Unicode code points with the repeating per-request p token. */
function xorText(text, key) {
  if (!key) return text;
  const input = Array.from(text);
  const mask = Array.from(key);
  return input.map((character, index) => String.fromCodePoint(
    character.codePointAt(0) ^ mask[index % mask.length].codePointAt(0),
  )).join('');
}

/** Solves an upstream Turnstile dx payload using only its fixed data-operation instruction set. */
export function solveTurnstileToken(dx, p) {
  if (typeof dx !== 'string' || typeof p !== 'string') return { token: null, reason: 'missing-input' };

  let operations;
  try {
    operations = JSON.parse(xorText(Buffer.from(dx, 'base64').toString('utf8'), p));
  } catch {
    return { token: null, reason: 'decode-failed' };
  }
  if (!Array.isArray(operations)) return { token: null, reason: 'invalid-program' };

  const values = new Map();
  const started = performance.now();
  let result = '';
  const get = (key) => {
    if (!values.has(key)) throw new Error('Missing challenge value');
    return values.get(key);
  };
  const set = (key, value) => values.set(key, value);

  const handlers = new Map([
    [1, (to, from) => set(to, xorText(challengeString(get(to)), challengeString(get(from))))],
    [2, (to, value) => set(to, value)],
    // Opcode 3 carries the output string directly; its operand is not a value-table key.
    [3, (value) => { result = Buffer.from(challengeString(value), 'utf8').toString('base64'); }],
    [5, (to, from) => {
      const current = get(to);
      const incoming = get(from);
      if (Array.isArray(current)) set(to, [...current, incoming]);
      else if (typeof current === 'string' || typeof current === 'number' || typeof incoming === 'string' || typeof incoming === 'number') {
        set(to, challengeString(current) + challengeString(incoming));
      } else set(to, 'NaN');
    }],
    [6, (to, left, right) => {
      const a = get(left);
      const b = get(right);
      if (typeof a === 'string' && typeof b === 'string') {
        const joined = `${a}.${b}`;
        set(to, joined === 'window.document.location' ? 'https://chatgpt.com/' : joined);
      }
    }],
    [7, (target, ...args) => {
      const fn = get(target);
      const resolved = args.map(get);
      if (fn === 'window.Reflect.set') {
        const [object, key, value] = resolved;
        object.add(String(key), value);
      } else if (typeof fn === 'function') fn(...resolved);
    }],
    [8, (to, from) => set(to, get(from))],
    [14, (to, from) => set(to, JSON.parse(get(from)))],
    [15, (to, from) => set(to, JSON.stringify(get(from)))],
    [17, (to, target, ...args) => {
      const fn = get(target);
      const resolved = args.map(get);
      if (fn === 'window.performance.now') set(to, performance.now() - started + Math.random());
      else if (fn === 'window.Object.create') set(to, new OrderedStorage());
      else if (fn === 'window.Object.keys' && resolved[0] === 'window.localStorage') set(to, [...localStorageKeys]);
      else if (fn === 'window.Math.random') set(to, Math.random());
      else if (typeof fn === 'function') set(to, fn(...resolved));
    }],
    [18, (key) => set(key, Buffer.from(challengeString(get(key)), 'base64').toString('utf8'))],
    [19, (key) => set(key, Buffer.from(challengeString(get(key)), 'utf8').toString('base64'))],
    [20, (left, right, target, ...args) => {
      if (get(left) === get(right)) {
        const fn = get(target);
        if (typeof fn === 'function') fn(...args.map(get));
      }
    }],
    [21, () => {}],
    [23, (condition, target, ...args) => {
      const fn = get(target);
      if (get(condition) !== null && typeof fn === 'function') fn(...args);
    }],
    [24, (to, left, right) => {
      const a = get(left);
      const b = get(right);
      if (typeof a === 'string' && typeof b === 'string') set(to, `${a}.${b}`);
    }],
  ]);

  values.set(1, handlers.get(1));
  values.set(2, handlers.get(2));
  values.set(3, handlers.get(3));
  values.set(5, handlers.get(5));
  values.set(6, handlers.get(6));
  values.set(7, handlers.get(7));
  values.set(8, handlers.get(8));
  values.set(9, operations);
  values.set(10, 'window');
  values.set(14, handlers.get(14));
  values.set(15, handlers.get(15));
  values.set(16, p);
  values.set(17, handlers.get(17));
  values.set(18, handlers.get(18));
  values.set(19, handlers.get(19));
  values.set(20, handlers.get(20));
  values.set(21, handlers.get(21));
  values.set(23, handlers.get(23));
  values.set(24, handlers.get(24));

  for (const operation of operations) {
    try {
      const [opcode, ...args] = operation;
      const handler = values.get(opcode);
      if (typeof handler === 'function') handler(...args);
    } catch (error) {
      // The challenge program tolerates unsupported or not-yet-initialized operations.
    }
  }
  return { token: result || null, reason: result ? null : 'program-produced-no-token' };
}

