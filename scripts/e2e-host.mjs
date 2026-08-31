/**
 * End-to-end host test: boots a real Cordis context with the REAL DSH
 * services the plugin consumes (timer, sessions, commands, typert registry)
 * and mounts the committed Host half (lib/index.js) as a plugin. Only the
 * heavy subagent continuation stack is stubbed (recording calls), which is
 * the part already proven by the running dynamic plugin.
 *
 * Asserts:
 *  1. the `btw` command registers and resolves via the real CommandRuntime;
 *  2. `commands.execute('/btw …')` settles success and appends the log-only
 *     `command/run` + `command/done` lifecycle events to the session;
 *  3. the fork child request is correct (provider, parent, prompt, read-only
 *     toolFilter, real AbortSignal);
 *  4. the `btwPanel` Typert remote mounts and its methods behave;
 *  5. clean teardown.
 *
 * Run with `npm run e2e`. Requires the real DSH packages resolvable — the
 * dev script links them from the local harness checkout (see README).
 */
import { Context } from '@deepseek-ai/cordis';
import { TimerService } from '@deepseek-ai/cordis-plugin-timer';
import SessionStore from '@deepseek-ai/dsh-session';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { apply as btwApply, name as btwName, inject as btwInject } from '../lib/index.js';

let failed = 0;
function assert(condition, label) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

const ctx = new Context();
await ctx.plugin(TimerService);
await ctx.plugin(SessionStore);
await ctx.plugin(TypertRegistry);
await ctx.plugin(CommandRuntime);

const calls = { starts: [], followups: [], interrupts: [] };
let spawnCount = 0;
let followupChild = null; // when set, child-stub-1 resolves to this cold-resumed session
ctx.provide('subagents', {
  list: () => ['fork'],
  startContinuable: async (spec) => {
    calls.starts.push(spec);
    spawnCount += 1;
    return { childId: 'child-stub-' + spawnCount, messageId: 'msg-stub-' + spawnCount };
  },
  followup: async (parent, childId, content, options) => {
    calls.followups.push({ parent, childId, content, options });
    if (childId === 'child-stub-1') followupChild = fakeChildFollowup; // simulate cold resume into a NEW Session object
    return 'msg-stub-2';
  },
  interrupt: (targetSessionId, authority) => {
    calls.interrupts.push({ targetSessionId, authority });
  },
});
// Fake child agent whose live log carries the fork seed + the child's own
// Q&A in the real session event shape ({type, seq, time, data}).
const fakeChild = {
  session: {
    events: [
      { type: 'turn/end', seq: 0, data: { turn: 0, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'seed user msg' }] } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'the btw question' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'the side answer' }] }, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  },
};
// A follow-up cold-resumes the child into a NEW Session object: same seed + first
// turn (seqs 0..4), then a session/end-seed resume marker and the follow-up turn.
const fakeChildFollowup = {
  session: {
    events: [
      { type: 'turn/end', seq: 0, data: { turn: 0, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'seed user msg' }] } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'the btw question' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'the side answer' }] }, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/end-seed', seq: 5, data: {} },
      { type: 'turn/start', seq: 6, data: { turn: 2 } },
      { type: 'user/message', seq: 7, data: { content: [{ type: 'text', text: 'again' }] } },
      { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: 'follow-up answer' }] }, usage: { outputTokens: 5 } } },
      { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } },
    ],
  },
};
// A child whose AGENT is disposed right after the fork resolves: the poll must
// keep folding via the captured Session object (regression for the disposal race).
const fakeChild3 = {
  session: {
    events: [
      { type: 'turn/end', seq: 0, data: { turn: 0, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'third ask' }] } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'answer after disposal' }] }, usage: { outputTokens: 7 } } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  },
};
let childResident = true;
ctx.provide('agents', {
  get: (id) => {
    if (!childResident) return undefined;
    if (id === 'child-stub-1') return followupChild || fakeChild;
    if (id === 'child-stub-3') return fakeChild3;
    return undefined;
  },
  list: () => [],
  roots: () => [],
});

const btwFiber = ctx.plugin({ name: btwName, inject: btwInject, apply: btwApply });

try {
  await btwFiber;
  const session = ctx.sessions.create('test-session');
  const agent = { id: 'test-session', session, ctx };

  // 1. command registration + resolution
  const found = ctx.commands.find(agent, 'btw');
  assert(found !== undefined, 'btw command registered and resolvable');

  // 2. execute -> log-only lifecycle events
  const execution = await ctx.commands.execute(agent, '/btw hello world', [], new AbortController().signal);
  assert(execution !== undefined, 'commands.execute resolved the /btw line');
  assert(execution.result.kind === 'success', `command result success (got ${execution.result.kind})`);
  const types = session.events.map((event) => event.type);
  assert(types.includes('command/run'), 'command/run appended to the session log');
  assert(types.includes('command/done'), 'command/done appended to the session log');
  const runEvent = session.events.find((event) => event.type === 'command/run');
  assert(runEvent && runEvent.data.name === 'btw' && String(runEvent.data.args || '').includes('hello world'), 'command/run carries the question');
  const doneEvent = session.events.find((event) => event.type === 'command/done');
  assert(doneEvent && doneEvent.data.kind === 'success', 'command/done settles success');

  // 3. fork child request shape
  assert(calls.starts.length === 1, 'one side thread spawned');
  const spec = calls.starts[0];
  assert(spec.provider === 'fork', `fork provider (got ${spec.provider})`);
  assert(spec.request.parent === agent, 'parent is the receiving agent');
  assert(spec.signal instanceof AbortSignal, 'startContinuable receives a real AbortSignal');
  const promptText = String(spec.request.prompt[0].text || '');
  assert(promptText.includes('hello world'), 'prompt embeds the question');
  assert(promptText.includes('by the way'), 'prompt carries the framing');
  assert(spec.request.toolFilter && Array.isArray(spec.request.toolFilter.allow), 'toolFilter present');
  assert(spec.request.toolFilter.allow.length === 0, 'toolFilter defaults to no tools (empty allow-list)');

  // 4. btwPanel Typert remote
  const panel = ctx.get('btwPanel');
  assert(panel !== undefined, 'btwPanel remote service mounted');
  const status = await panel.status('unknown-command');
  assert(status === null, 'btwPanel.status unknown -> null');
  const followup = await panel.followup('unknown-command', 'again', new AbortController().signal);
  assert(followup && followup.ok === false && followup.error === 'unknown ask', 'btwPanel.followup unknown -> error');
  const cancel = await panel.cancel('unknown-command', new AbortController().signal);
  assert(cancel && cancel.ok === false, 'btwPanel.cancel unknown -> error');

  // 4b. poll loop folds the child's real-shaped log and completes the entry
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(1300); // poll interval is 900ms
  const settled = await panel.status(execution.commandId);
  assert(settled !== null, 'status resolves after the poll fold');
  assert(settled.status === 'done', `poll folds the child log to done (got ${settled.status})`);
  assert(settled.exchanges.some((e) => e.role === 'assistant' && e.text === 'the side answer'), 'transcript contains the child answer');
  assert(settled.usage.cacheRead === 30, 'usage folded from the child log');

  // 4b2. a follow-up cold-resumes the child into a NEW Session object; the poll
  // must re-capture it and fold the follow-up turn (regression: follow-up dies).
  const followupRes = await panel.followup(execution.commandId, 'again', new AbortController().signal);
  assert(followupRes && followupRes.ok === true, 'follow-up accepted');
  await sleep(1300);
  const followed = await panel.status(execution.commandId);
  assert(followed !== null && followed.status === 'done', `follow-up folds to done via re-captured session (got ${followed && followed.status})`);
  assert(followed.exchanges.some((e) => e.role === 'assistant' && e.text === 'follow-up answer'), 'follow-up answer folded from the re-captured session');

  // 4c. a second ask whose child is not resident stays running
  const execution2 = await ctx.commands.execute(agent, '/btw second ask', [], new AbortController().signal);
  await sleep(1300);
  const running = await panel.status(execution2.commandId);
  assert(running !== null && running.status === 'running', 'unresolved child keeps the entry running');

  // 4d. a child whose AGENT is disposed after capture still folds to done via the captured Session
  const execution3 = await ctx.commands.execute(agent, '/btw third ask', [], new AbortController().signal);
  await sleep(50); // let startContinuable resolve and capture the child Session
  childResident = false; // simulate the continuation manager disposing the child agent
  await sleep(1300);
  const settled3 = await panel.status(execution3.commandId);
  assert(settled3 !== null && settled3.status === 'done', `disposed child folds to done via captured session (got ${settled3 && settled3.status})`);
  assert(settled3.exchanges.some((e) => e.role === 'assistant' && e.text === 'answer after disposal'), 'disposed child answer folded from the captured session');

  // 5. teardown interrupts the still-running side thread
  await btwFiber.dispose();
  assert(calls.interrupts.length === 1, 'plugin teardown interrupts the in-flight child');
  assert(calls.interrupts[0].targetSessionId === 'child-stub-2', 'interrupt targets the running child session');
  assert(calls.interrupts[0].authority && calls.interrupts[0].authority.kind === 'ancestor', 'interrupt uses ancestor authority');

  if (failed === 0) {
    console.log('\ne2e host: ALL PASS');
    process.exit(0);
  }
  console.error(`\ne2e host: ${failed} FAILURE(S)`);
  process.exit(1);
} catch (error) {
  console.error('e2e host: CRASHED:', error && error.stack ? error.stack : error);
  try { await btwFiber.dispose(); } catch (err) {}
  process.exit(1);
}
