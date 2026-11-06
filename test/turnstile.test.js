import test from 'node:test';
import assert from 'node:assert/strict';
import { solveTurnstileToken } from '../src/turnstile.js';

function encodeDx(operations, p) {
  const source = Array.from(JSON.stringify(operations));
  const key = Array.from(p);
  const encrypted = source.map((character, index) => String.fromCodePoint(
    character.codePointAt(0) ^ key[index % key.length].codePointAt(0),
  )).join('');
  return Buffer.from(encrypted, 'utf8').toString('base64');
}

test('Turnstile dx instructions produce the encoded challenge token', () => {
  const p = 'sentinel-p-token';
  const dx = encodeDx([[2, 30, 'decoy-register-value'], [3, 'challenge-result']], p);
  assert.equal(solveTurnstileToken(dx, p).token, Buffer.from('challenge-result').toString('base64'));
});

test('Turnstile solver rejects malformed or mismatched dx payloads', () => {
  assert.equal(solveTurnstileToken('not-base64-json', 'p-token').reason, 'decode-failed');
  assert.equal(solveTurnstileToken(encodeDx([], 'p-token'), 'p-token').reason, 'program-produced-no-token');
});
