/**
 * dsh-btw — Host half.
 *
 * Recreates Claude CLI's `/btw`: the user asks a question "by the way" while
 * the main agent keeps running. The question is answered by a durable,
 * continuable FORK subagent (a separate child session seeded with the parent's
 * completed-turn prefix, restricted to a read-only toolset) and rendered as a
 * resumable command card in the web chat with live token stats.
 *
 * - registers the `/btw` human command. The command lifecycle (`command/run` +
 *   `command/done`) is log-only and NEVER enters the model surface, so the main
 *   conversation's prompt and provider prefix cache stay untouched.
 * - observes each child's own log (events past the seed boundary) for answer
 *   exchanges and token usage, and exposes a `btwPanel` Typert Remote for the
 *   web client: status / followup / cancel.
 * - the `typert` seam is optional (non-web profiles skip the remote); the
 *   command itself works in any profile.
 *
 * This file is the source of `lib/index.js` (committed after `npm run
 * build:host`); the profile installs the committed `lib/` as-is.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { textOf, excerpt, seedEndSeqOf, buildPreamble, computeToolFilter, foldChildEvents } from './host-helpers.js';

export const name = 'dsh-btw';
export const inject = ['commands', 'subagents', 'agents', 'timer'];

/**
 * `btwPanel` Remote 命名空间的调用描述符（src-json codec）。手工经
 * `ctx.typert.register()` 注册——运行时 registry 接受 src-json，免去 zod
 * 依赖；Web 客户端半边（lib/client.js）按同一套参数顺序调用。
 */
function panelDescriptor(method, parameters, cancellation) {
  return Object.freeze({
    id: `dsh-btw#btwPanel/${method}`,
    service: 'btwPanel',
    namespace: 'btwPanel',
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({
      name: p,
      wire: p,
      source: 'json',
      codec: Object.freeze({ mode: 'src-json' }),
    }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    result: Object.freeze({ mode: 'src-json' }),
  });
}

const PANEL_INVOCATIONS = Object.freeze([
  panelDescriptor('status', ['commandId']),
  panelDescriptor('followup', ['commandId', 'text'], true),
  panelDescriptor('cancel', ['commandId'], true),
]);

/** `btwPanel` 宿主服务：命令卡片轮询 / 续写 / 取消的 RPC 面。 */
class BtwPanelService extends TypertRemoteService {
  constructor(ctx, ops) {
    super(ctx, 'btwPanel');
    this.ops = ops;
  }

  /** 卡片快照：状态、问题、问答交换、累计 token 用量。 */
  status(commandId) {
    return this.ops.status(commandId);
  }

  /** 在同一子会话上续写一条后续消息。 */
  followup(commandId, text, signal) {
    return this.ops.followup(commandId, text, signal);
  }

  /** 中断正在进行的回答。 */
  cancel(commandId, signal) {
    return this.ops.cancel(commandId, signal);
  }
}

export function apply(ctx, config) {
  const commands = ctx.commands;
  const subagents = ctx.subagents;
  const agents = ctx.agents;
  const jobs = ctx.get('jobs');
  const tools = ctx.get('tools');
  // Tools granted to each side child. Empty by default (Claude /btw parity):
  // configure via the profile's cordis.patch.yml, e.g. `config: { tools: [read, web_search] }`.
  const allowedTools = config && Array.isArray(config.tools)
    ? config.tools.filter((name) => typeof name === 'string')
    : [];

  const runs = new Map();

  function pollChild(entry) {
    if (entry.childId === null) return;
    // The child's Session OBJECT changes across activations: the continuation
    // manager disposes the agent when its turn settles and cold-resumes a NEW
    // agent + Session for a follow-up. Re-capture the live session whenever the
    // agent is resident (so a follow-up folds the new activation's events), and
    // fall back to the last captured session after disposal — its frozen snapshot
    // still holds the final events of the just-finished turn.
    let session = entry.childSession;
    const agent = agents.get(entry.childId);
    if (agent && agent.session) {
      session = agent.session;
      entry.childSession = session;
    }
    if (!session) return; // not captured yet — retry next tick
    const events = Array.isArray(session.events) ? session.events : null;
    if (!events) return;
    entry.lastSeenSeq = foldChildEvents(entry, events);
    maybeStopPoll(entry);
  }

  function ensurePoll(entry) {
    if (entry.poll) return;
    entry.poll = ctx.interval(() => pollChild(entry), 900);
  }

  function maybeStopPoll(entry) {
    if (!entry.poll) return;
    if (entry.status === 'done' || entry.status === 'error' || entry.status === 'cancelled') {
      try { entry.poll(); } catch (err) {}
      entry.poll = null;
    }
  }

  function spawnAsk(agent, commandId, question) {
    const entry = {
      commandId,
      sessionId: agent.session.id,
      question,
      childId: null,
      childSession: null,
      seedEndSeq: seedEndSeqOf(agent),
      exchanges: [{ role: 'user', text: question }],
      streamingText: '',
      streamingReasoning: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      pending: 1,
      status: 'running',
      error: '',
      parent: agent,
      controller: new AbortController(),
      poll: null,
      lastSeenSeq: -1,
    };
    runs.set(commandId, entry);
    const preamble = buildPreamble(agent, jobs);
    const toolFilter = computeToolFilter(tools, allowedTools);
    const hasTools = !!(toolFilter && Array.isArray(toolFilter.allow) && toolFilter.allow.length > 0);
    const prompt =
      'Answer this side question ("by the way") directly and concisely, while the user\'s main task keeps running. ' +
      (hasTools ? 'Use read or search tools only if needed; do not modify anything.' : 'Do not modify anything.') +
      (preamble ? '\n\nCurrent context of the main conversation:\n' + preamble : '') +
      '\n\n' + question;
    subagents.startContinuable({
      provider: 'fork',
      label: 'BTW: ' + excerpt(question, 48),
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        ...(toolFilter ? { toolFilter } : {}),
      },
      signal: entry.controller.signal,
    }).then((start) => {
      if (entry.status === 'cancelled') return;
      entry.childId = start.childId;
      entry.lastSeenSeq = entry.seedEndSeq;
      // Capture the durable Session object NOW (the child agent is registered
      // before startContinuable resolves): it outlives the agent, whose disposal
      // on settlement is what used to starve the poll.
      const child = agents.get(start.childId);
      if (child && child.session) entry.childSession = child.session;
      ensurePoll(entry);
    }).catch((err) => {
      if (entry.status === 'cancelled') return;
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
    });
  }

  ctx.effect(() => commands.register({
    name: 'btw',
    description: 'Ask a question by the way while the main task keeps running.',
    input: { hint: 'your question' },
    handler: (invocation) => {
      const question = (invocation.rawInput || '').trim();
      if (!question) return { kind: 'error', text: 'Ask a question, e.g. /btw what does this error mean?' };
      if (!subagents.list().includes('fork')) return { kind: 'error', text: 'btw: the fork subagent provider is not available in this deployment.' };
      spawnAsk(invocation.agent, invocation.commandId, question);
      return { kind: 'success', text: 'Asked.' };
    },
  }));

  const ops = {
    status(commandId) {
      const entry = runs.get(String(commandId || ''));
      if (!entry) return null;
      return {
        status: entry.status,
        question: entry.question,
        exchanges: entry.exchanges.slice(-12),
        streamingText: entry.streamingText,
        streamingReasoning: entry.streamingReasoning,
        resident: entry.childId !== null && (entry.childSession !== null || !!agents.get(entry.childId)),
        usage: {
          input: entry.usage.input,
          output: entry.usage.output,
          cacheRead: entry.usage.cacheRead,
          cacheWrite: entry.usage.cacheWrite,
        },
        error: entry.error,
      };
    },

    followup(commandId, text, signal) {
      const entry = runs.get(String(commandId || ''));
      if (!entry) return { ok: false, error: 'unknown ask' };
      if (!entry.childId || !entry.parent) return { ok: false, error: 'side thread not ready yet' };
      const trimmed = String(text || '').trim();
      if (!trimmed) return { ok: false, error: 'empty follow-up' };
      const sig = signal && typeof signal.addEventListener === 'function' ? signal : entry.controller.signal;
      return subagents.followup(entry.parent, entry.childId, [{ type: 'text', text: trimmed }], {
        source: { kind: 'user' },
        signal: sig,
      }).then(() => {
        entry.question = trimmed;
        entry.exchanges.push({ role: 'user', text: trimmed });
        entry.pending += 1;
        entry.error = '';
        if (entry.status === 'done' || entry.status === 'error') entry.status = 'running';
        // The follow-up may have cold-resumed the child into a NEW Session object;
        // re-capture it before the turn starts so a fast turn that completes and
        // disposes within the poll interval still folds its events.
        const child = agents.get(entry.childId);
        if (child && child.session) entry.childSession = child.session;
        ensurePoll(entry);
        return { ok: true };
      }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    },

    cancel(commandId, signal) {
      const entry = runs.get(String(commandId || ''));
      if (!entry) return { ok: false };
      try { entry.controller.abort(); } catch (err) {}
      if (entry.childId && entry.parent) {
        try { subagents.interrupt(entry.childId, { kind: 'ancestor', agent: entry.parent }); } catch (err) {}
      }
      if (entry.poll) { try { entry.poll(); } catch (err) {} entry.poll = null; }
      entry.status = 'cancelled';
      return { ok: true };
    },
  };

  // 仅在装配了 Typert registry 的 profile（Web）里挂载面板远程；其余 profile 安静跳过。
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => scope.typert.register({
      package: 'dsh-btw',
      face: 'host',
      schemas: [],
      invocations: PANEL_INVOCATIONS,
      model: Object.freeze({ services: Object.freeze([]), events: Object.freeze([]), objects: Object.freeze([]) }),
    }), 'dsh-btw: typert invocations');
    scope.plugin(BtwPanelService, ops);
  });

  // Plugin teardown: stop observers and interrupt in-flight side threads so
  // stopping/updating the plugin never leaves an ask mid-turn.
  ctx.effect(() => () => {
    for (const entry of runs.values()) {
      if (entry.poll) { try { entry.poll(); } catch (err) {} entry.poll = null; }
      try { entry.controller.abort(); } catch (err) {}
      if (entry.childId && entry.parent && entry.status === 'running') {
        try { subagents.interrupt(entry.childId, { kind: 'ancestor', agent: entry.parent }); } catch (err) {}
      }
    }
    runs.clear();
  });
}
