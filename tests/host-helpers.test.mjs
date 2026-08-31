/**
 * Unit tests for the pure host helpers (src/host-helpers.js).
 * Run with: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAFE_TOOLS,
  textOf,
  excerpt,
  seedEndSeqOf,
  buildPreamble,
  foldUsage,
  computeToolFilter,
} from '../src/host-helpers.js';

test('textOf joins text blocks and skips others', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(textOf([]), '');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf([{ type: 'image', attachment: {} }]), '');
});

test('excerpt truncates with ellipsis and passes short text through', () => {
  assert.equal(excerpt('hello', 3), 'hel\u2026');
  assert.equal(excerpt('hi', 3), 'hi');
});

test('seedEndSeqOf finds the last turn/end seq', () => {
  const agent = { session: { events: [
    { seq: 0, type: 'turn/start' }, { seq: 1, type: 'user/message' },
    { seq: 2, type: 'turn/end' }, { seq: 3, type: 'turn/start' }, { seq: 4, type: 'assistant/message' },
  ] } };
  assert.equal(seedEndSeqOf(agent), 2);
  assert.equal(seedEndSeqOf({ session: { events: [{ seq: 0, type: 'user/message' }] } }), -1);
  assert.equal(seedEndSeqOf({ session: {} }), -1);
});

test('buildPreamble reports mid-turn, last instruction, last tool, and running jobs', () => {
  const events = [
    { seq: 0, type: 'turn/end', turn: 0 },
    { seq: 1, type: 'user/message', content: [{ type: 'text', text: 'do the migration' }] },
    { seq: 2, type: 'tool/call', name: 'bash' },
    { seq: 3, type: 'turn/start', turn: 1 },
  ];
  const agent = { session: { events } };
  const jobs = { list: () => [{ status: 'running' }, { status: 'completed' }] };
  const preamble = buildPreamble(agent, jobs);
  assert.ok(preamble.includes('mid-turn'));
  assert.ok(preamble.includes('do the migration'));
  assert.ok(preamble.includes('bash'));
  assert.ok(preamble.includes('Background jobs running in the main session: 1'));
});

test('buildPreamble is empty for an empty log and tolerant of a missing jobs service', () => {
  assert.equal(buildPreamble({ session: { events: [] } }, undefined), '');
  assert.equal(buildPreamble({}, undefined), '');
  const throwingJobs = { list: () => { throw new Error('nope'); } };
  assert.equal(buildPreamble({ session: { events: [] } }, throwingJobs), '');
});

test('foldUsage accumulates numeric fields and ignores garbage', () => {
  const entry = { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
  foldUsage(entry, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
  foldUsage(entry, undefined);
  foldUsage(entry, { inputTokens: 'x' });
  assert.deepEqual(entry.usage, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
});

test('computeToolFilter intersects with registered tools', () => {
  const tools = { schemas: () => [{ name: 'read' }, { name: 'grep' }, { name: 'bash' }] };
  const filter = computeToolFilter(tools);
  assert.ok(filter.allow.includes('read'));
  assert.ok(!filter.allow.includes('bash'));
  assert.ok(filter.allow.length < SAFE_TOOLS.length);
});

test('computeToolFilter falls back to the full read-only set when schemas are empty or unavailable (the bundle profile-level ctx case)', () => {
  // A profile-level context exposes no agent tool scope: schemas() returns [].
  const emptyTools = { schemas: () => [] };
  const fromEmpty = computeToolFilter(emptyTools);
  assert.deepEqual(fromEmpty.allow, SAFE_TOOLS.slice());
  assert.ok(!fromEmpty.allow.includes('bash'));

  // tools service absent entirely.
  const absent = computeToolFilter(undefined);
  assert.deepEqual(absent.allow, SAFE_TOOLS.slice());

  // schemas() throws.
  const throwingTools = { schemas: () => { throw new Error('no scope'); } };
  assert.deepEqual(computeToolFilter(throwingTools).allow, SAFE_TOOLS.slice());
});
