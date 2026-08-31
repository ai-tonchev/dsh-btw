/**
 * Unit tests for the pure client helpers (src/client-helpers.js).
 * Run with: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZERO_USAGE,
  BTW_REMOTE,
  descriptor,
  unwrap,
  formatStats,
  statusSchema,
  okSchema,
} from '../src/client-helpers.js';

test('BTW_REMOTE declares the three endpoints with the strict wire contract', () => {
  assert.equal(BTW_REMOTE.package, 'dsh-btw');
  const methods = BTW_REMOTE.descriptors.map((d) => d.method);
  assert.deepEqual(methods, ['status', 'followup', 'cancel']);
  const [status, followup, cancel] = BTW_REMOTE.descriptors;
  assert.equal(status.parameters.length, 1);
  assert.equal(status.parameters[0].name, 'commandId');
  assert.equal(status.cancellation, undefined);
  assert.equal(status.result.mode, 'strict');
  assert.equal(followup.cancellation.parameter, 'signal');
  assert.equal(followup.parameters.length, 2);
  assert.equal(cancel.cancellation.parameter, 'signal');
  assert.equal(cancel.result.mode, 'strict');
});

test('descriptor ids use the dsh-btw#btwPanel prefix', () => {
  const d = descriptor('status', [{ name: 'x', wire: 'x', source: 'json', codec: { mode: 'strict' }, acceptsUndefined: true }], statusSchema, false);
  assert.equal(d.id, 'dsh-btw#btwPanel/status');
  assert.equal(d.namespace, 'btwPanel');
  assert.equal(d.invocation.kind, 'direct');
});

test('unwrap returns the value and throws on failure envelopes', () => {
  assert.equal(unwrap({ ok: true, value: 42 }), 42);
  assert.equal(unwrap({ ok: true, value: null }), null);
  assert.throws(() => unwrap({ ok: false, error: 'unknown ask' }), /unknown ask/);
  assert.throws(() => unwrap(undefined), /btwPanel call failed/);
});

test('formatStats renders non-zero components and omits zeros', () => {
  assert.equal(formatStats({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0 }), 'in 100 \u00b7 cache hit 900 \u00b7 out 20');
  assert.equal(formatStats({ input: 100, output: 20, cacheRead: 0, cacheWrite: 5 }), 'in 100 \u00b7 out 20 \u00b7 write 5');
  assert.equal(formatStats(ZERO_USAGE), '');
});

test('statusSchema validates the host status payload and null', () => {
  const payload = {
    status: 'done',
    question: 'hi',
    exchanges: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 },
    error: '',
  };
  assert.equal(statusSchema.safeParse(payload).success, true);
  // New streaming/resident fields are optional (older hosts still validate).
  assert.equal(statusSchema.safeParse({ ...payload, streamingText: 'ans', streamingReasoning: 'think', resident: true }).success, true);
  assert.equal(statusSchema.safeParse(null).success, true);
  assert.equal(statusSchema.safeParse({ status: 'done' }).success, false);
  assert.equal(statusSchema.safeParse({ ...payload, usage: { input: 1 } }).success, false);
});

test('okSchema validates the followup/cancel envelope payload', () => {
  assert.equal(okSchema.safeParse({ ok: true }).success, true);
  assert.equal(okSchema.safeParse({ ok: false, error: 'unknown ask' }).success, true);
  assert.equal(okSchema.safeParse({}).success, false);
});
