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

test('computeToolFilter defaults to no tools (empty allow-list)', () => {
  const tools = { schemas: () => [{ name: 'read' }, { name: 'grep' }, { name: 'bash' }] };
  assert.deepEqual(computeToolFilter(tools).allow, []);
  assert.deepEqual(computeToolFilter(undefined).allow, []);
});

test('computeToolFilter intersects an explicit allow-list with registered tools', () => {
  const tools = { schemas: () => [{ name: 'read' }, { name: 'grep' }, { name: 'bash' }] };
  // unregistered name is dropped
  assert.deepEqual(computeToolFilter(tools, ['read', 'web_search']).allow, ['read']);
  // explicit names that ARE registered pass through verbatim
  assert.deepEqual(computeToolFilter(tools, ['read', 'bash']).allow, ['read', 'bash']);
});

test('computeToolFilter passes the full allow-list through when schemas are unavailable (the bundle profile-level ctx case)', () => {
  // A profile-level context exposes no agent tool scope: schemas() returns [].
  const emptyTools = { schemas: () => [] };
  assert.deepEqual(computeToolFilter(emptyTools, ['read', 'grep']).allow, ['read', 'grep']);

  // tools service absent entirely.
  const absent = computeToolFilter(undefined, ['read', 'grep']);
  assert.deepEqual(absent.allow, ['read', 'grep']);

  // schemas() throws.
  const throwingTools = { schemas: () => { throw new Error('no scope'); } };
  assert.deepEqual(computeToolFilter(throwingTools, ['read']).allow, ['read']);
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

test('foldChildEvents resumes at the seq/index mismatch instead of skipping ahead', () => {
  const events = [
    { type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'first' }] } } },
    { type: 'turn/end', seq: 99, data: { reason: { kind: 'completed' } } }, // seq != index
  ];
  const entry = { seedEndSeq: -1, lastSeenSeq: -1, pending: 1, status: 'running', error: '', exchanges: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const next = foldChildEvents(entry, events);
  assert.equal(next, 0); // stopped at the mismatch; must NOT claim events.length - 1
  assert.equal(entry.status, 'running'); // the unreadable turn/end was not folded
  assert.equal(entry.pending, 0); // the assistant message before it was folded
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

test('foldChildEvents resolves a turn that ends with NO assistant/message (regression: stuck at answering)', () => {
  // The agent loop emits turn/end for blocked / error / aborted-before-content /
  // empty-first-step with ZERO assistant/message events. The transition must
  // follow turn/end.reason, never an assistant-message count.
  const makeEntry = () => ({ seedEndSeq: -1, lastSeenSeq: -1, pending: 1, status: 'running', error: '', exchanges: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

  const errorEntry = makeEntry();
  foldChildEvents(errorEntry, [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error' } } },
  ]);
  assert.equal(errorEntry.status, 'error');

  const abortedEntry = makeEntry();
  foldChildEvents(abortedEntry, [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } } },
  ]);
  assert.equal(abortedEntry.status, 'cancelled');

  const blockedEntry = makeEntry();
  foldChildEvents(blockedEntry, [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'blocked' } } },
  ]);
  assert.equal(blockedEntry.status, 'error');
  assert.ok(blockedEntry.error.includes('blocked'));

  const emptyEntry = makeEntry();
  foldChildEvents(emptyEntry, [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  assert.equal(emptyEntry.status, 'done');
});

test('foldChildEvents streams assistant/chunk text and reasoning live, then finalizes', () => {
  const entry = { seedEndSeq: -1, lastSeenSeq: -1, pending: 1, status: 'running', error: '', exchanges: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, streamingText: '', streamingReasoning: '' };
  // Poll tick 1: partial stream — chunks accumulate, no terminal event yet.
  entry.lastSeenSeq = foldChildEvents(entry, [
    { type: 'assistant/chunk', seq: 0, data: { chunk: { type: 'reasoning-delta', index: 0, text: 'Let me ' } } },
    { type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'reasoning-delta', index: 0, text: 'think.' } } },
    { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', index: 1, text: 'Hello' } } },
  ]);
  assert.equal(entry.status, 'running');
  assert.equal(entry.streamingReasoning, 'Let me think.');
  assert.equal(entry.streamingText, 'Hello');
  // Poll tick 2: stream completes, the assembled message finalizes, turn ends.
  entry.lastSeenSeq = foldChildEvents(entry, [
    { type: 'assistant/chunk', seq: 0, data: { chunk: { type: 'reasoning-delta', index: 0, text: 'Let me ' } } },
    { type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'reasoning-delta', index: 0, text: 'think.' } } },
    { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', index: 1, text: 'Hello' } } },
    { type: 'assistant/chunk', seq: 3, data: { chunk: { type: 'text-delta', index: 1, text: ' world' } } },
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'reasoning', text: 'Let me think.' }, { type: 'text', text: 'Hello world' }] }, usage: { outputTokens: 5 } } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  assert.equal(entry.status, 'done');
  assert.equal(entry.streamingText, '');
  assert.equal(entry.streamingReasoning, '');
  assert.deepEqual(entry.exchanges, [
    { role: 'reasoning', text: 'Let me think.' },
    { role: 'assistant', text: 'Hello world' },
  ]);
});

test('foldChildEvents ignores non-array input', () => {
  const entry = { lastSeenSeq: 5 };
  assert.equal(foldChildEvents(entry, undefined), 5);
});
