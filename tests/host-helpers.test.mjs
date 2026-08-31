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
  foldChildEvents,
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

test('foldChildEvents reads event.data payloads and completes the turn', () => {
  // Session events carry their payload under data ({type, seq, time, data});
  // the fork seed occupies seqs 0..seedEnd and must be present in the array.
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 0 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'seed user' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'seed answer' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 0, reason: { kind: 'completed' } } },
    { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: 'the btw question' }] } },
    { type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: 'the side answer' }] }, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 } } },
    { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const entry = { seedEndSeq: 3, lastSeenSeq: 3, pending: 1, status: 'running', error: '', exchanges: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const next = foldChildEvents(entry, events);
  assert.equal(next, 6);
  assert.equal(entry.status, 'done');
  assert.equal(entry.pending, 0);
  assert.deepEqual(entry.exchanges, [{ role: 'assistant', text: 'the side answer' }]);
  assert.deepEqual(entry.usage, { input: 10, output: 20, cacheRead: 30, cacheWrite: 0 });
});

test('foldChildEvents stops on a seq/index mismatch (live-log guard)', () => {
  const events = [
    { type: 'turn/end', seq: 0, data: { reason: { kind: 'completed' } } },
    { type: 'assistant/message', seq: 99, data: { message: { content: [{ type: 'text', text: 'x' }] } } }, // seq != index
  ];
  const entry = { seedEndSeq: -1, lastSeenSeq: -1, pending: 1, status: 'running', error: '', exchanges: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  foldChildEvents(entry, events);
  assert.equal(entry.status, 'running');
  assert.equal(entry.pending, 1);
});

test('foldChildEvents marks a non-completed turn as error and an abort as cancelled', () => {
  const base = { seedEndSeq: -1, lastSeenSeq: -1, pending: 1, status: 'running', error: '', exchanges: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const entryError = { ...base, exchanges: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const eventsError = [
    { type: 'assistant/message', seq: 0, data: { message: { content: [] } } },
    { type: 'turn/end', seq: 1, data: { reason: { kind: 'max-tokens' } } },
  ];
  foldChildEvents(entryError, eventsError);
  assert.equal(entryError.status, 'error');
  assert.ok(entryError.error.includes('max-tokens'));

  const entryAbort = { ...base, exchanges: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const eventsAbort = [
    { type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'partial' }] } } },
    { type: 'turn/end', seq: 1, data: { reason: { kind: 'aborted' } } },
  ];
  foldChildEvents(entryAbort, eventsAbort);
  assert.equal(entryAbort.status, 'cancelled');
});

test('foldChildEvents ignores non-array input', () => {
  const entry = { lastSeenSeq: 5 };
  assert.equal(foldChildEvents(entry, undefined), 5);
});
