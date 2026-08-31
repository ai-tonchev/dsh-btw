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
ctx.provide('subagents', {
  list: () => ['fork'],
  startContinuable: async (spec) => {
    calls.starts.push(spec);
    spawnCount += 1;
    return { childId: 'child-stub-' + spawnCount, messageId: 'msg-stub-' + spawnCount };
  },
  followup: async (parent, childId, content, options) => {
    calls.followups.push({ parent, childId, content, options });
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
ctx.provide('agents', {
  get: (id) => (id === 'child-stub-1' ? fakeChild : undefined),
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
  assert(spec.request.toolFilter && Array.isArray(spec.request.toolFilter.allow), 'read-only toolFilter present');
  assert(spec.request.toolFilter.allow.includes('read') && !spec.request.toolFilter.allow.includes('bash'), 'toolFilter allows read and excludes bash');

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

  // 4c. a second ask whose child is not resident stays running
  const execution2 = await ctx.commands.execute(agent, '/btw second ask', [], new AbortController().signal);
  await sleep(1300);
  const running = await panel.status(execution2.commandId);
  assert(running !== null && running.status === 'running', 'unresolved child keeps the entry running');

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
